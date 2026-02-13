import assert from "node:assert/strict";
import test from "node:test";
import { buildIntentProfile } from "@/lib/pipeline/intent";
import { planDeterministicQueryVariants } from "@/lib/pipeline/planner";
import { buildCanonicalIntent, synthesizeRetrievalQueries } from "@/lib/pipeline/query-rewrite";
import { buildSerperQueryForTest } from "@/lib/retrieval/providers/serper";
import { buildIndianKanoonSearchQueryForTest } from "@/lib/source-indiankanoon";
import type { ReasonerPlan } from "@/lib/reasoner-schema";
import type { RetrievalSearchInput } from "@/lib/retrieval/providers/types";

function sampleReasonerPlan(polarity: ReasonerPlan["proposition"]["outcome_constraint"]["polarity"]): ReasonerPlan {
  return {
    proposition: {
      actors: ["state"],
      proceeding: ["criminal appeal"],
      legal_hooks: ["section 197 crpc", "section 19 prevention of corruption act"],
      outcome_required: ["delay condonation refused"],
      outcome_negative: ["delay condoned"],
      jurisdiction_hint: "SC",
      hook_groups: [
        {
          group_id: "g1",
          terms: ["section 197 crpc", "197 crpc"],
          min_match: 1,
          required: true,
        },
        {
          group_id: "g2",
          terms: ["section 19 prevention of corruption act", "section 19 pc act"],
          min_match: 1,
          required: true,
        },
      ],
      relations: [
        {
          type: "interacts_with",
          left_group_id: "g1",
          right_group_id: "g2",
          required: true,
        },
      ],
      outcome_constraint: {
        polarity,
        terms: ["delay condonation refused"],
        contradiction_terms: ["delay condoned", "appeal allowed"],
      },
      interaction_required: true,
    },
    must_have_terms: ["state", "criminal appeal", "section 197 crpc", "section 19 prevention of corruption act"],
    must_not_have_terms: ["delay condoned", "appeal allowed"],
    query_variants_strict: [
      "state criminal appeal section 197 crpc section 19 prevention of corruption act delay condonation refused",
    ],
    query_variants_broad: [
      "criminal appeal section 197 crpc section 19 prevention of corruption act delay condonation",
    ],
    case_anchors: ["section 197 crpc section 19 prevention of corruption act"],
  };
}

function serperInput(query: string): RetrievalSearchInput {
  return {
    phrase: query,
    courtScope: "SC",
    maxResultsPerPhrase: 10,
    maxPages: 1,
    crawlMaxElapsedMs: 2500,
    fetchTimeoutMs: 1200,
    max429Retries: 0,
    includeTokens: ["delay condonation refused", "section 197 crpc"],
    excludeTokens: ["appeal allowed"],
    providerHints: {
      serperQuotedTerms: ["delay condonation refused"],
      serperCoreTerms: ["section 197 crpc", "section 19 prevention of corruption act"],
      canonicalOrderTerms: ["state", "criminal appeal", "section 197 crpc"],
      excludeTerms: ["delay condoned"],
    },
  };
}

test("buildCanonicalIntent preserves actor/proceeding/outcome from NLQ", () => {
  const intent = buildIntentProfile(
    "Please find me judgments where the state filed a criminal appeal and delay condonation was refused under section 5 limitation act",
  );
  const canonical = buildCanonicalIntent(intent);
  assert.ok(canonical.proceedings.some((value) => value.includes("appeal")));
  assert.ok(canonical.outcomes.some((value) => value.includes("delay") || value.includes("barred")));
});

test("synthesizeRetrievalQueries preserves required multi-hook intersections in strict variants", async () => {
  const intent = buildIntentProfile(
    "state criminal appeal, section 197 crpc and section 19 pc act interaction, delay condonation refused",
  );
  const reasonerPlan = sampleReasonerPlan("refused");
  const deterministic = await planDeterministicQueryVariants(intent, reasonerPlan);
  const canonical = buildCanonicalIntent(intent, reasonerPlan);
  const variants = synthesizeRetrievalQueries({
    canonicalIntent: canonical,
    deterministicPlanner: deterministic,
    reasonerVariants: [],
  });
  const strict = variants.filter((variant) => variant.strictness === "strict");
  assert.ok(strict.length > 0);
  assert.ok(
    strict.every(
      (variant) =>
        variant.phrase.includes("197") &&
        (variant.phrase.includes("section 19") || variant.phrase.includes("pc act")),
    ),
  );
});

test("polarity disambiguation adds contradiction exclusions", () => {
  const intent = buildIntentProfile(
    "whether prior sanction is not required for prosecution under section 197 crpc",
  );
  const reasonerPlan = sampleReasonerPlan("not_required");
  const canonical = buildCanonicalIntent(intent, reasonerPlan);
  assert.equal(canonical.outcomePolarity, "not_required");
  assert.ok(
    canonical.mustExcludeTokens.some((token) => token === "required" || token === "mandatory"),
  );
});

test("provider query builders apply canonical ordering and exclusions", () => {
  const serperQuery = buildSerperQueryForTest(serperInput("state criminal appeal delay condonation refused"));
  assert.ok(serperQuery.includes("site:indiankanoon.org/doc"));
  assert.ok(serperQuery.includes("\"delay condonation refused\""));
  assert.ok(serperQuery.includes("-\"appeal allowed\""));

  const indianKanoonQuery = buildIndianKanoonSearchQueryForTest("state criminal appeal delay condonation refused", {
    courtType: "supremecourt",
    canonicalOrderTerms: ["section 197 crpc", "section 19 prevention of corruption act"],
    includeTokens: ["delay condonation refused"],
    excludeTokens: ["appeal allowed"],
  });
  assert.ok(indianKanoonQuery.includes("doctypes:supremecourt"));
  assert.ok(indianKanoonQuery.includes("section 197 crpc"));
  assert.ok(!indianKanoonQuery.includes("appeal allowed"));
});
