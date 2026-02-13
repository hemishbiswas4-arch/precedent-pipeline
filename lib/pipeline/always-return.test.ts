import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSyntheticAdvisoryNearMiss,
  shouldInjectSyntheticFallback,
  syntheticFallbackStatus,
} from "@/lib/pipeline/always-return";
import { buildIntentProfile } from "@/lib/pipeline/intent";
import { buildPropositionChecklist } from "@/lib/proposition-gate";
import { SearchResponse } from "@/lib/types";

test("buildSyntheticAdvisoryNearMiss returns deterministic exploratory advisory shape", () => {
  const query =
    "state criminal appeal dismissed as time barred after delay condonation refused under section 5 limitation act";
  const intent = buildIntentProfile(query);
  const checklist = buildPropositionChecklist({
    context: intent.context,
    cleanedQuery: intent.cleanedQuery,
  });

  const synthetic = buildSyntheticAdvisoryNearMiss({
    query,
    intent,
    checklist,
    schedulerStopReason: "blocked",
    blockedKind: "rate_limit",
    queryRewrite: {
      applied: true,
      canonicalMustIncludeTokens: ["state", "criminal appeal", "section 5 limitation act"],
      strictVariantPhrases: ["state criminal appeal section 5 limitation act delay condonation refused"],
    },
  });

  assert.equal(synthetic.item.retrievalTier, "exploratory");
  assert.equal(synthetic.item.fallbackReason, "synthetic_advisory");
  assert.equal(synthetic.item.confidenceBand, "LOW");
  assert.ok(synthetic.item.title.toLowerCase().includes("non-citation"));
  assert.ok(synthetic.item.url.startsWith("https://indiankanoon.org/search/?formInput="));
  assert.ok(synthetic.item.gapSummary && synthetic.item.gapSummary.length > 0);
  assert.ok(synthetic.reason.includes("retrieval_blocked"));
});

test("shouldInjectSyntheticFallback only triggers for empty exact+exploratory result sets", () => {
  assert.equal(
    shouldInjectSyntheticFallback({
      alwaysReturnEnabled: true,
      syntheticFallbackEnabled: true,
      casesExactCount: 0,
      casesExploratoryCount: 0,
    }),
    true,
  );
  assert.equal(
    shouldInjectSyntheticFallback({
      alwaysReturnEnabled: true,
      syntheticFallbackEnabled: true,
      casesExactCount: 0,
      casesExploratoryCount: 2,
    }),
    false,
  );
  assert.equal(
    shouldInjectSyntheticFallback({
      alwaysReturnEnabled: true,
      syntheticFallbackEnabled: false,
      casesExactCount: 0,
      casesExploratoryCount: 0,
    }),
    false,
  );
});

test("synthetic fallback keeps truthful blocked/no_match response semantics", () => {
  const blocked = syntheticFallbackStatus("blocked");
  const noMatch = syntheticFallbackStatus("completed");
  const noMatchFromBudget = syntheticFallbackStatus("budget_exhausted");

  assert.equal(blocked, "blocked" satisfies SearchResponse["status"]);
  assert.equal(noMatch, "no_match" satisfies SearchResponse["status"]);
  assert.equal(noMatchFromBudget, "no_match" satisfies SearchResponse["status"]);
});
