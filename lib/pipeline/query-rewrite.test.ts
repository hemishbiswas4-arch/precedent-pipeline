import assert from "node:assert/strict";
import test from "node:test";
import { buildIntentProfile } from "@/lib/pipeline/intent";
import { planDeterministicQueryVariants } from "@/lib/pipeline/planner";
import { buildCanonicalIntent, synthesizeRetrievalQueries } from "@/lib/pipeline/query-rewrite";
import { buildSerperQueryForTest } from "@/lib/retrieval/providers/serper";
import { ikApiProviderTestUtils } from "@/lib/retrieval/providers/indiankanoon-api";
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
    queryMode: "precision",
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
  const precisionStrict = strict.filter(
    (variant) => variant.retrievalDirectives?.queryMode === "precision",
  );
  assert.ok(precisionStrict.length > 0);
  assert.ok(
    precisionStrict.some(
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

test("contradiction exclusions avoid broad generic tokens from phrase-only negatives", () => {
  const intent = buildIntentProfile(
    "State criminal appeal where condonation of delay was refused under section 5 limitation act",
  );
  const reasonerPlan = sampleReasonerPlan("refused");
  const canonical = buildCanonicalIntent(intent, reasonerPlan);
  assert.ok(canonical.mustExcludeTokens.some((token) => token.includes("delay condoned")));
  assert.ok(canonical.mustExcludeTokens.includes("condoned"));
  assert.equal(canonical.mustExcludeTokens.includes("delay"), false);
  assert.equal(canonical.mustExcludeTokens.includes("appeal"), false);
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

test("serper context and expansion query modes avoid over-constraining exclusions", () => {
  const contextQuery = buildSerperQueryForTest({
    ...serperInput("state challenge discharge order"),
    queryMode: "context",
  });
  const expansionQuery = buildSerperQueryForTest({
    ...serperInput("state challenge discharge order"),
    queryMode: "expansion",
    includeTokens: ["discharge order", "revision", "appeal"],
    excludeTokens: ["delay condoned", "appeal allowed"],
    providerHints: {
      ...serperInput("state challenge discharge order").providerHints,
      canonicalOrderTerms: ["state", "challenge discharge", "high court"],
    },
  });

  assert.ok(contextQuery.includes("site:indiankanoon.org/doc"));
  assert.ok(!contextQuery.includes("-\"appeal allowed\""));
  assert.ok(!expansionQuery.includes("-\"appeal allowed\""));
  assert.ok(expansionQuery.includes("site:indiankanoon.org/doc"));
});

test("synthesizeRetrievalQueries emits precision, context and expansion lanes with directives", async () => {
  const intent = buildIntentProfile(
    "state criminal appeal on delay condonation refused under section 5 limitation act with tribunal references",
  );
  const deterministic = await planDeterministicQueryVariants(intent);
  const canonical = buildCanonicalIntent(intent);
  const variants = synthesizeRetrievalQueries({
    canonicalIntent: canonical,
    deterministicPlanner: deterministic,
    reasonerVariants: [],
  });

  const modes = new Set(variants.map((variant) => variant.retrievalDirectives?.queryMode));
  assert.ok(modes.has("precision"));
  assert.ok(modes.has("context"));
  assert.ok(modes.has("expansion"));
  assert.ok(
    variants.some(
      (variant) =>
        variant.retrievalDirectives?.doctypeProfile === "judgments_sc_hc_tribunal" ||
        variant.retrievalDirectives?.doctypeProfile === "supremecourt",
    ),
  );
});

test("disjunctive natural-language queries keep actionable precision variants without over-constraining all hooks", async () => {
  const intent = buildIntentProfile(
    "State revision or appeal against discharge, or framing of charge under section 304 ipc in road accidents, rash or drunken driving, knowledge versus negligence",
  );
  const deterministic = await planDeterministicQueryVariants(intent);
  const canonical = buildCanonicalIntent(intent);
  const variants = synthesizeRetrievalQueries({
    canonicalIntent: canonical,
    deterministicPlanner: deterministic,
    reasonerVariants: [],
  });

  assert.equal(canonical.disjunctiveQuery, true);
  assert.ok(canonical.hookGroups.some((group) => group.required));
  assert.ok(canonical.hookGroups.filter((group) => group.required).length <= 2);
  assert.ok(canonical.hookGroups.some((group) => group.terms.some((term) => term.includes("304"))));

  const precisionStrict = variants.filter(
    (variant) => variant.strictness === "strict" && variant.retrievalDirectives?.queryMode === "precision",
  );
  assert.ok(precisionStrict.length > 0);
  assert.ok(
    precisionStrict.some(
      (variant) => variant.phrase.includes("section 304") || variant.phrase.includes("304 ipc"),
    ),
  );
});

test("discharge refusal query does not drift into delay-condonation variants", async () => {
  const intent = buildIntentProfile(
    "Cases where the State challenged a discharge order and the High Court or Supreme Court refused to interfere and upheld the discharge.",
  );
  const deterministic = await planDeterministicQueryVariants(intent);
  const canonical = buildCanonicalIntent(intent);
  const variants = synthesizeRetrievalQueries({
    canonicalIntent: canonical,
    deterministicPlanner: deterministic,
    reasonerVariants: [],
  });

  const deterministicPhrases = deterministic.variants.map((variant) => variant.phrase);
  const rewrittenPhrases = variants.map((variant) => variant.phrase);
  const delayCondonationDrift = /condonation|delay not condoned|application for condonation|time barred/;

  assert.ok(deterministic.variants.some((variant) => variant.phase === "primary" && variant.strictness === "strict"));
  assert.ok(deterministicPhrases.some((phrase) => phrase.includes("discharge")));
  assert.equal(deterministicPhrases.some((phrase) => delayCondonationDrift.test(phrase)), false);
  assert.equal(rewrittenPhrases.some((phrase) => delayCondonationDrift.test(phrase)), false);
  const precision = variants.filter((variant) => variant.retrievalDirectives?.queryMode === "precision");
  assert.ok(precision.length > 0);
  assert.ok(
    precision.every((variant) => variant.retrievalDirectives?.applyContradictionExclusions === false),
  );
});

test("state petition against discharge rejected does not drift into limitation dismissal", async () => {
  const intent = buildIntentProfile("State files petition against discharge, petition rejected");
  const deterministic = await planDeterministicQueryVariants(intent);
  const canonical = buildCanonicalIntent(intent);
  const variants = synthesizeRetrievalQueries({
    canonicalIntent: canonical,
    deterministicPlanner: deterministic,
    reasonerVariants: [],
  });

  const drift = /time barred|barred by limitation|dismissed on limitation|appeal dismissed as time barred/;
  assert.equal(deterministic.variants.some((variant) => drift.test(variant.phrase)), false);
  assert.equal(variants.some((variant) => drift.test(variant.phrase)), false);
});

test("canonical intent drops reasoner delay-condonation outcomes when query context is discharge-only", () => {
  const intent = buildIntentProfile(
    "Cases where the State challenged a discharge order and the High Court refused to interfere and upheld discharge.",
  );
  const canonical = buildCanonicalIntent(intent, sampleReasonerPlan("refused"));
  assert.equal(canonical.outcomes.some((value) => /condonation|delay|time barred/.test(value)), false);
  assert.equal(canonical.contradictionTerms.some((value) => /delay condoned|time barred/.test(value)), false);
});

test("limitation condonation queries retain delay-condonation lexical expansions", async () => {
  const intent = buildIntentProfile(
    "State appeal against acquittal dismissed as time barred and condonation of delay refused under section 5 limitation act",
  );
  const deterministic = await planDeterministicQueryVariants(intent);
  const canonical = buildCanonicalIntent(intent);
  const variants = synthesizeRetrievalQueries({
    canonicalIntent: canonical,
    deterministicPlanner: deterministic,
    reasonerVariants: [],
  });
  const phrases = deterministic.variants.map((variant) => variant.phrase);
  assert.ok(phrases.some((phrase) => /condonation|not condoned|time barred/.test(phrase)));
  const precision = variants.filter((variant) => variant.retrievalDirectives?.queryMode === "precision");
  assert.ok(precision.some((variant) => variant.retrievalDirectives?.applyContradictionExclusions === true));
});

test("IK API structured query uses bounded ORR in expansion mode and avoids NOTT", () => {
  const query = ikApiProviderTestUtils.buildFormInput({
    phrase: "delay condonation appeal",
    compiledQuery: "delay condonation appeal",
    courtScope: "ANY",
    queryMode: "expansion",
    includeTokens: ["delay condonation", "limitation"],
    excludeTokens: ["appeal allowed"],
    categoryExpansions: ["appellate", "limitation"],
    maxResultsPerPhrase: 8,
    maxPages: 1,
    crawlMaxElapsedMs: 1200,
    fetchTimeoutMs: 900,
    max429Retries: 0,
  });
  assert.ok(query.includes("ORR"));
  assert.ok(!query.includes("NOTT"));
});

test("IK API structured query applies NOTT in precision mode with contradiction exclusions", () => {
  const query = ikApiProviderTestUtils.buildFormInput({
    phrase: "section 197 sanction required",
    compiledQuery: "section 197 sanction required",
    courtScope: "ANY",
    queryMode: "precision",
    includeTokens: ["section 197", "sanction required"],
    excludeTokens: ["sanction not required"],
    maxResultsPerPhrase: 8,
    maxPages: 1,
    crawlMaxElapsedMs: 1200,
    fetchTimeoutMs: 900,
    max429Retries: 0,
  });
  assert.ok(query.includes("NOTT"));
});

test("IK API doctype resolver defaults to tribunal-inclusive judgment profile", () => {
  const doctypes = ikApiProviderTestUtils.resolveDoctypes({
    phrase: "service tribunal delay condonation",
    courtScope: "ANY",
    doctypeProfile: "judgments_sc_hc_tribunal",
    maxResultsPerPhrase: 8,
    maxPages: 1,
    crawlMaxElapsedMs: 1200,
    fetchTimeoutMs: 900,
    max429Retries: 0,
  });
  assert.equal(doctypes, "supremecourt,highcourts,tribunals");
});

test("open-ended limitation condonation query keeps unknown polarity and preserves section-number precision", async () => {
  const intent = buildIntentProfile(
    "Can delay in filing a criminal appeal by the State be condoned under Section 5 of the Limitation Act when the appeal against acquittal is filed late?",
  );
  const deterministic = await planDeterministicQueryVariants(intent);
  const canonical = buildCanonicalIntent(intent);
  const variants = synthesizeRetrievalQueries({
    canonicalIntent: canonical,
    deterministicPlanner: deterministic,
    reasonerVariants: [],
  });

  assert.equal(canonical.outcomePolarity, "unknown");
  const precision = variants.filter((variant) => variant.retrievalDirectives?.queryMode === "precision");
  assert.ok(precision.length > 0);
  assert.ok(
    precision.some((variant) => /\bsection 5\b/.test(variant.phrase)),
  );
});

test("open-ended quashing query does not force outcome polarity", () => {
  const intent = buildIntentProfile(
    "Under Section 482 CrPC, when can a High Court quash FIR or criminal proceedings where allegations are civil in nature?",
  );
  const canonical = buildCanonicalIntent(intent);
  assert.equal(canonical.outcomePolarity, "unknown");
});
