import assert from "node:assert/strict";
import test from "node:test";
import { runRetrievalSchedule, schedulerTestUtils } from "@/lib/pipeline/scheduler";
import type { IntentProfile, QueryVariant, VariantUtilitySnapshot } from "@/lib/pipeline/types";

function variant(input: {
  id: string;
  phrase: string;
  canonicalKey: string;
  priority: number;
  strictness?: QueryVariant["strictness"];
}): QueryVariant {
  return {
    id: input.id,
    phrase: input.phrase,
    phase: "primary",
    purpose: "test",
    courtScope: "ANY",
    strictness: input.strictness ?? "strict",
    tokens: input.phrase.split(/\s+/),
    canonicalKey: input.canonicalKey,
    priority: input.priority,
  };
}

test("computeAttemptUtility rewards case-like candidates and penalizes statute-heavy rows", () => {
  const strong = schedulerTestUtils.computeAttemptUtility({
    parsedCount: 8,
    challengeDetected: false,
    timedOut: false,
    status: 200,
    cases: [
      {
        source: "indiankanoon",
        title: "State v. A on 1 January 2020",
        url: "https://indiankanoon.org/doc/1/",
        snippet: "criminal appeal by state petitioner respondent judgment",
        court: "SC",
      },
    ],
  });
  const weak = schedulerTestUtils.computeAttemptUtility({
    parsedCount: 8,
    challengeDetected: false,
    timedOut: false,
    status: 200,
    cases: [
      {
        source: "indiankanoon",
        title: "Indian Penal Code, 1860",
        url: "https://indiankanoon.org/doc/2/",
        snippet: "section 406 punishment whoever shall be punished",
        court: "UNKNOWN",
      },
    ],
  });
  assert.ok(strong.score > weak.score);
  assert.ok(strong.caseLikeRatio >= weak.caseLikeRatio);
});

test("toSortedPhaseVariants favors historically high-utility canonical keys", () => {
  const variants = [
    variant({
      id: "v1",
      phrase: "state criminal appeal limitation",
      canonicalKey: "rewrite:strict:low",
      priority: 90,
    }),
    variant({
      id: "v2",
      phrase: "section 197 crpc section 19 pc act",
      canonicalKey: "rewrite:strict:high",
      priority: 90,
    }),
  ];
  const utility: Record<string, VariantUtilitySnapshot> = {
    "rewrite:strict:low": {
      attempts: 3,
      meanUtility: 0.12,
      caseLikeRate: 0.2,
      statuteLikeRate: 0.6,
      challengeRate: 0.2,
      timeoutRate: 0.1,
      updatedAtMs: Date.now(),
    },
    "rewrite:strict:high": {
      attempts: 3,
      meanUtility: 0.78,
      caseLikeRate: 0.9,
      statuteLikeRate: 0.05,
      challengeRate: 0,
      timeoutRate: 0,
      updatedAtMs: Date.now(),
    },
  };
  const sorted = schedulerTestUtils.toSortedPhaseVariants(variants, utility);
  assert.equal(sorted[0].canonicalKey, "rewrite:strict:high");
});

function buildIntent(): IntentProfile {
  return {
    query: "state appeal limitation",
    cleanedQuery: "state appeal limitation",
    context: {
      domains: ["criminal"],
      issues: ["delay condonation refused"],
      statutesOrSections: ["section 5 limitation act"],
      procedures: ["criminal appeal"],
      actors: ["state"],
      anchors: ["delay", "condonation"],
    },
    domains: ["criminal"],
    issues: ["delay condonation refused"],
    statutes: ["section 5 limitation act"],
    procedures: ["criminal appeal"],
    actors: ["state"],
    anchors: ["delay", "condonation"],
    courtHint: "ANY",
    dateWindow: {},
    retrievalIntent: {
      actors: ["state"],
      proceeding: ["criminal appeal"],
      hookGroups: [
        {
          groupId: "sec_5_limitation",
          terms: ["section 5 limitation act"],
          required: true,
        },
      ],
      outcomePolarity: "refused",
      citationHints: [],
      judgeHints: [],
      dateWindow: {},
      doctypeProfile: "judgments_sc_hc_tribunal",
    },
    entities: {
      person: [],
      org: [],
      statute: ["limitation act"],
      section: ["section 5 limitation act"],
      case_citation: [],
    },
  };
}

test("runRetrievalSchedule honors per-phase page policy and does not early-stop on raw count by default", async () => {
  const calls: Array<{ phase?: string; maxPages: number }> = [];
  const provider = {
    id: "indiankanoon_api" as const,
    supportsDetailFetch: true,
    async search(input: {
      maxPages: number;
      phrase: string;
    }) {
      calls.push({ maxPages: input.maxPages });
      return {
        cases: [
          {
            source: "indiankanoon" as const,
            title: `State v. Candidate ${calls.length}`,
            url: `https://indiankanoon.org/doc/${calls.length}/`,
            snippet: "criminal appeal dismissed as time barred",
            court: "SC" as const,
          },
        ],
        debug: {
          searchQuery: input.phrase,
          status: 200,
          ok: true,
          parsedCount: 1,
          parserMode: "ik_api",
          cloudflareDetected: false,
          challengeDetected: false,
        },
      };
    },
  };

  const variants: QueryVariant[] = [
    {
      id: "p1",
      phrase: "state criminal appeal limitation",
      phase: "primary",
      purpose: "test",
      courtScope: "ANY",
      strictness: "strict",
      tokens: ["state", "criminal", "appeal", "limitation"],
    },
    {
      id: "f1",
      phrase: "delay condonation refused limitation",
      phase: "fallback",
      purpose: "test",
      courtScope: "ANY",
      strictness: "strict",
      tokens: ["delay", "condonation", "refused", "limitation"],
    },
    {
      id: "r1",
      phrase: "section 5 limitation act",
      phase: "rescue",
      purpose: "test",
      courtScope: "ANY",
      strictness: "relaxed",
      tokens: ["section", "5", "limitation", "act"],
    },
  ];

  const result = await runRetrievalSchedule({
    variants,
    intent: buildIntent(),
    provider,
    config: {
      strictCaseOnly: true,
      verifyLimit: 4,
      globalBudget: 6,
      phaseLimits: {
        primary: 2,
        fallback: 2,
        rescue: 1,
        micro: 1,
        revolving: 1,
        browse: 1,
      },
      maxPagesByPhase: {
        primary: 2,
        fallback: 2,
        other: 1,
      },
      blockedThreshold: 3,
      minCaseTarget: 1,
      requireSupremeCourt: false,
      maxElapsedMs: 5000,
      stopOnCandidateTarget: true,
      fetchTimeoutMs: 1200,
      max429Retries: 0,
    },
  });

  assert.equal(result.attempts.length, 3);
  assert.deepEqual(
    calls.map((entry) => entry.maxPages),
    [2, 2, 1],
  );
});
