import assert from "node:assert/strict";
import test from "node:test";
import { schedulerTestUtils } from "@/lib/pipeline/scheduler";
import type { QueryVariant, VariantUtilitySnapshot } from "@/lib/pipeline/types";

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
