import { buildSearchInsights } from "@/lib/insights";
import {
  DEFAULT_BLOCKED_THRESHOLD,
  DEFAULT_GLOBAL_BUDGET,
  DEFAULT_VERIFY_LIMIT,
  PHASE_LIMITS,
  PHASE_ORDER,
} from "@/lib/kb/query-templates";
import { ontologyTemplatesForContext } from "@/lib/kb/legal-ontology";
import { runOpusReasoner } from "@/lib/llm-reasoner";
import { classificationCounts, classifyCandidates } from "@/lib/pipeline/classifier";
import { buildIntentProfile } from "@/lib/pipeline/intent";
import {
  buildGuaranteeBackfillVariants,
  buildTraceQueryVariants,
  buildReasonerQueryVariants,
  mergeCanonicalRewriteVariants,
  planAIFailoverQueryVariants,
  planDeterministicQueryVariants,
} from "@/lib/pipeline/planner";
import { runRetrievalSchedule } from "@/lib/pipeline/scheduler";
import { QueryVariant, SchedulerConfig, SchedulerResult } from "@/lib/pipeline/types";
import { buildCanonicalIntent, CanonicalIntent, synthesizeRetrievalQueries } from "@/lib/pipeline/query-rewrite";
import {
  buildSyntheticAdvisoryNearMiss,
  shouldInjectSyntheticFallback,
  syntheticFallbackStatus,
} from "@/lib/pipeline/always-return";
import { verifyCandidates } from "@/lib/pipeline/verifier";
import {
  lookupFallbackRecallEntry,
  saveFallbackRecallEntry,
} from "@/lib/cache/fallback-recall-cache";
import { pickRetrievalProvider } from "@/lib/retrieval/provider";
import type { RetrievalProvider } from "@/lib/retrieval/providers/types";
import { groundReasonerPlanToIntent } from "@/lib/reasoner-schema";
import {
  buildPropositionChecklist,
  PropositionChecklist,
  splitByProposition,
} from "@/lib/proposition-gate";
import { diversifyRankedCases } from "@/lib/ranking-diversity";
import { scoreCases } from "@/lib/scoring";
import { CaseCandidate, NearMissCase, ScoredCase, SearchResponse } from "@/lib/types";

const MIN_RELEVANT_SCORE = 0.18;
const PASS2_MIN_EXACT = Math.max(1, Number(process.env.AI_FAILOVER_MIN_CASES ?? "4"));
const PASS2_MIN_REMAINING_BUDGET = Math.max(
  1,
  Number(process.env.AI_FAILOVER_MIN_REMAINING_BUDGET ?? "4"),
);
const PASS2_MIN_REMAINING_MS = Math.max(
  3_000,
  Number(process.env.PASS2_MIN_REMAINING_MS ?? "9000"),
);
const PASS2_MIN_COVERAGE = Math.min(
  1,
  Math.max(Number(process.env.PASS2_MIN_REQUIRED_COVERAGE ?? "0.7"), 0),
);
const PASS2_MIN_HOOK_COVERAGE = Math.min(
  1,
  Math.max(Number(process.env.PASS2_MIN_HOOK_COVERAGE ?? "0.8"), 0),
);
const PROPOSITION_V3_ENABLED = parseBooleanEnv(process.env.PROPOSITION_V3, true);
const PROPOSITION_V41_ENABLED = parseBooleanEnv(process.env.PROPOSITION_V41, true);
const PROPOSITION_V5_ENABLED = parseBooleanEnv(process.env.PROPOSITION_V5, true);
const PROPOSITION_EXACT_STOP_TARGET = Math.max(1, Number(process.env.PROPOSITION_EXACT_STOP_TARGET ?? "4"));
const PROPOSITION_STRICT_STOP_TARGET = Math.max(
  1,
  Number(process.env.PROPOSITION_STRICT_STOP_TARGET ?? String(PROPOSITION_EXACT_STOP_TARGET)),
);
const PROPOSITION_BEST_EFFORT_STOP_TARGET = Math.max(
  PROPOSITION_STRICT_STOP_TARGET,
  Number(process.env.PROPOSITION_BEST_EFFORT_STOP_TARGET ?? String(PROPOSITION_EXACT_STOP_TARGET)),
);
const PROPOSITION_PROVISIONAL_CONFIDENCE_FLOOR = Math.min(
  0.9,
  Math.max(Number(process.env.PROPOSITION_PROVISIONAL_CONFIDENCE_FLOOR ?? "0.62"), 0.35),
);
const PROPOSITION_CHAIN_MIN_COVERAGE = Math.min(
  1,
  Math.max(Number(process.env.PROPOSITION_CHAIN_MIN_COVERAGE ?? "0.75"), 0.4),
);
const REASONER_TIMEOUT_RECOVERY_MODE = process.env.REASONER_TIMEOUT_RECOVERY_MODE ?? "extended_deterministic";
const EXTENDED_DETERMINISTIC_BUDGET_BONUS = Math.max(
  0,
  Number(process.env.EXTENDED_DETERMINISTIC_BUDGET_BONUS ?? "6"),
);
const IK_FETCH_TIMEOUT_MS = Math.max(1_200, Number(process.env.IK_FETCH_TIMEOUT_MS ?? "3000"));
const IK_MAX_429_RETRIES = Math.max(0, Number(process.env.IK_MAX_429_RETRIES ?? "0"));
const IK_MAX_RETRY_AFTER_MS = Math.max(500, Number(process.env.IK_MAX_RETRY_AFTER_MS ?? "1500"));
const TRACE_EXPANSION_MIN_REMAINING_MS = Math.max(
  1_500,
  Number(process.env.TRACE_EXPANSION_MIN_REMAINING_MS ?? "6000"),
);
const PIPELINE_MAX_ELAPSED_MS = Math.min(
  Math.max(Number(process.env.PIPELINE_MAX_ELAPSED_MS ?? "9000"), 5_000),
  60_000,
);
const DETAIL_MIN_SUCCESS_BEFORE_EARLY_STOP = Math.max(
  0,
  Number(process.env.DETAIL_MIN_SUCCESS_BEFORE_EARLY_STOP ?? "2"),
);
const SERPER_STOP_ON_CANDIDATE_TARGET = parseBooleanEnv(
  process.env.SERPER_STOP_ON_CANDIDATE_TARGET,
  false,
);
const NEAR_MISS_MAX_RESULTS = Math.max(1, Number(process.env.NEAR_MISS_MAX_RESULTS ?? "12"));
const SUPREME_COURT_PREFERENCE_ENABLED = parseBooleanEnv(
  process.env.SUPREME_COURT_PREFERENCE_ENABLED,
  true,
);
const SUPREME_COURT_PREFERENCE_BONUS = Math.min(
  0.08,
  Math.max(Number(process.env.SUPREME_COURT_PREFERENCE_BONUS ?? "0.025"), 0),
);
const ALWAYS_RETURN_V1_ENABLED = parseBooleanEnv(process.env.ALWAYS_RETURN_V1, true);
const ALWAYS_RETURN_SYNTHETIC_FALLBACK_ENABLED = parseBooleanEnv(
  process.env.ALWAYS_RETURN_SYNTHETIC_FALLBACK,
  true,
);
const STALE_FALLBACK_ENABLED = parseBooleanEnv(process.env.STALE_FALLBACK_ENABLED, true);
const GUARANTEE_MIN_RESULTS = Math.max(1, Number(process.env.GUARANTEE_MIN_RESULTS ?? "3"));
const GUARANTEE_EXTRA_ATTEMPTS = Math.max(1, Number(process.env.GUARANTEE_EXTRA_ATTEMPTS ?? "2"));
const GUARANTEE_MIN_REMAINING_MS = Math.max(
  1_000,
  Number(process.env.GUARANTEE_MIN_REMAINING_MS ?? "1500"),
);
const STALE_FALLBACK_MIN_SIMILARITY = Math.min(
  0.95,
  Math.max(Number(process.env.STALE_FALLBACK_MIN_SIMILARITY ?? "0.55"), 0.3),
);
const ADAPTIVE_VARIANT_SCHEDULER_ENABLED = parseBooleanEnv(process.env.ADAPTIVE_VARIANT_SCHEDULER, true);
const QUERY_REWRITE_V2_ENABLED = parseBooleanEnv(process.env.QUERY_REWRITE_V2, true);
const CANONICAL_LEXICAL_SCORING_ENABLED = parseBooleanEnv(process.env.CANONICAL_LEXICAL_SCORING, true);

type ReasonerHealthStatus =
  | "ok"
  | "timeout"
  | "circuit_open"
  | "config_error"
  | "rate_limited"
  | "lock_timeout"
  | "semaphore_saturated"
  | "disabled"
  | "error";

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return fallback;
}

function classifyReasonerHealth(input: {
  mode: "opus" | "deterministic";
  error?: string;
}): {
  status: ReasonerHealthStatus;
  attempted: boolean;
  skipReason?: string;
} {
  if (input.mode === "opus") {
    return {
      status: "ok",
      attempted: true,
    };
  }

  const error = (input.error ?? "").trim();
  if (!error) {
    return {
      status: "error",
      attempted: false,
      skipReason: "unknown",
    };
  }

  if (error === "reasoner_timeout") {
    return {
      status: "timeout",
      attempted: true,
    };
  }
  if (error === "reasoner_circuit_open") {
    return {
      status: "circuit_open",
      attempted: false,
      skipReason: "circuit_open",
    };
  }
  if (
    error === "reasoner_mode_disabled" ||
    error === "reasoner_call_budget_exhausted"
  ) {
    return {
      status: "disabled",
      attempted: false,
      skipReason: error,
    };
  }
  if (
    error.includes("not a valid Bedrock model") ||
    error.includes("missing") ||
    error.includes("invalid")
  ) {
    return {
      status: "config_error",
      attempted: false,
      skipReason: error,
    };
  }
  if (error === "reasoner_global_rate_limited") {
    return {
      status: "rate_limited",
      attempted: false,
      skipReason: "global_rate_limited",
    };
  }
  if (error === "reasoner_inflight_lock_wait_timeout") {
    return {
      status: "lock_timeout",
      attempted: false,
      skipReason: "inflight_lock_wait_timeout",
    };
  }
  if (error === "reasoner_local_semaphore_saturated") {
    return {
      status: "semaphore_saturated",
      attempted: false,
      skipReason: "local_semaphore_saturated",
    };
  }

  return {
    status: "error",
    attempted: true,
    skipReason: error,
  };
}

function uniqueLimit(values: string[], limit: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

function dedupeByUrl<T extends { url: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const value of values) {
    if (seen.has(value.url)) continue;
    seen.add(value.url);
    output.push(value);
  }
  return output;
}

function isSparseIntent(intent: ReturnType<typeof buildIntentProfile>): boolean {
  return (
    intent.statutes.length === 0 &&
    intent.issues.length === 0 &&
    intent.anchors.length <= 8 &&
    intent.cleanedQuery.split(/\s+/).filter((token) => token.length > 1).length <= 9
  );
}

function withExtendedPhaseLimits(phaseLimits: Record<string, number>, bonus: number): Record<string, number> {
  if (bonus <= 0) return phaseLimits;
  const output: Record<string, number> = { ...phaseLimits };
  const orderedPhases = ["primary", "fallback", "rescue", "micro", "revolving", "browse"];
  for (const phase of orderedPhases) {
    if (typeof output[phase] !== "number") continue;
    output[phase] = Math.max(1, output[phase] + 1);
  }
  return output;
}

function applyPropositionMode(checklist: PropositionChecklist): PropositionChecklist {
  if (PROPOSITION_V3_ENABLED) {
    if (PROPOSITION_V5_ENABLED) return checklist;
    return {
      ...checklist,
      graph: undefined,
    };
  }
  return {
    ...checklist,
    hookGroups: checklist.hookGroups.map((group) => ({
      ...group,
      required: false,
    })),
    relations: [],
    interactionRequired: false,
    graph: PROPOSITION_V5_ENABLED ? checklist.graph : undefined,
  };
}

function phaseCount(values: Array<{ phase: string }>): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value.phase] = (acc[value.phase] ?? 0) + 1;
    return acc;
  }, {});
}

function hasPrimaryFallbackCourtFloor(
  attempts: Array<{ phase: string; courtScope?: "SC" | "HC" | "ANY" }>,
): boolean {
  const scoped = attempts.filter((attempt) => attempt.phase === "primary" || attempt.phase === "fallback");
  const hasSc = scoped.some((attempt) => attempt.courtScope === "SC");
  const hasHc = scoped.some((attempt) => attempt.courtScope === "HC");
  return hasSc && hasHc;
}

function isRelevantCase(item: ScoredCase): boolean {
  if (item.score < MIN_RELEVANT_SCORE) {
    return false;
  }
  return (
    item.verification.issuesMatched > 0 ||
    item.verification.proceduresMatched > 0 ||
    item.verification.anchorsMatched > 0 ||
    (item.matchEvidence?.length ?? 0) > 0
  );
}

function applySupremeCourtPreference(cases: ScoredCase[]): ScoredCase[] {
  if (!SUPREME_COURT_PREFERENCE_ENABLED || cases.length === 0) {
    return cases;
  }
  const hasSc = cases.some((item) => item.court === "SC");
  const hasHc = cases.some((item) => item.court === "HC");
  if (!hasSc || !hasHc) {
    return cases;
  }
  const boosted = cases.map((item) => {
    if (item.court !== "SC") {
      return item;
    }
    const rankingScore = Math.min(1, (item.rankingScore ?? item.score) + SUPREME_COURT_PREFERENCE_BONUS);
    return {
      ...item,
      rankingScore: Number(rankingScore.toFixed(3)),
      reasons: item.reasons.includes("Supreme Court priority applied")
        ? item.reasons
        : [...item.reasons, "Supreme Court priority applied"],
    };
  });
  return boosted.sort((a, b) => (b.rankingScore ?? b.score) - (a.rankingScore ?? a.score));
}

function qualifiedProvisionalCount(cases: ScoredCase[]): number {
  return cases.filter((item) => (item.confidenceScore ?? item.score) >= PROPOSITION_PROVISIONAL_CONFIDENCE_FLOOR).length;
}

function filterTraceVariantsByChecklist(variants: QueryVariant[], checklist: PropositionChecklist): QueryVariant[] {
  const requiredGroups = checklist.hookGroups.filter((group) => group.required);
  if (requiredGroups.length === 0) return variants;
  return variants.filter((variant) => {
    const phrase = variant.phrase.toLowerCase();
    if (requiredGroups.length === 1) {
      return requiredGroups[0].terms.some((term) => phrase.includes(term.toLowerCase()));
    }
    return requiredGroups.every((group) => group.terms.some((term) => phrase.includes(term.toLowerCase())));
  });
}

type CandidateEvaluation = {
  counts: Record<"case" | "statute" | "noise" | "unknown", number>;
  rejectionReasons: Record<string, number>;
  rankedPool: ScoredCase[];
  courtFilteredCount: number;
  scCount: number;
  duplicatesCollapsed: number;
  verificationSummary: {
    attempted: number;
    detailFetched: number;
    detailFetchFailed?: number;
    detailFetchFallbackUsed?: number;
    detailFetchErrorCounts?: Record<string, number>;
    detailFetchSampleErrors?: string[];
    hybridFallbackUsed?: number;
    hybridFallbackSuccesses?: number;
    detailHydrationCoverage?: number;
    passedCaseGate: number;
  };
};

type PhaseRunResult = {
  scheduler: SchedulerResult;
  evaluation: CandidateEvaluation;
  propositionSplit: ReturnType<typeof splitByProposition>;
};

type CanonicalLexicalProfile = {
  mustIncludeTokens: string[];
  strictVariantTokens: string[];
  checklistTokens: string[];
  contradictionTokens: string[];
};

async function evaluateCandidates(input: {
  query: string;
  maxResults: number;
  verifyLimit: number;
  allowNetworkFetch: boolean;
  context: ReturnType<typeof buildIntentProfile>["context"];
  checklist: PropositionChecklist;
  candidates: CaseCandidate[];
  canonicalLexicalProfile?: CanonicalLexicalProfile;
  candidateProvenance?: SchedulerResult["carryState"]["candidateProvenance"];
}): Promise<CandidateEvaluation> {
  const classified = classifyCandidates(input.candidates);
  const verified = await verifyCandidates(classified, input.verifyLimit, {
    allowNetworkFetch: input.allowNetworkFetch,
  });
  const postVerify = verified.verified;
  const counts = classificationCounts(postVerify);

  const rejectionReasons = postVerify
    .filter(
      (item) =>
        item.classification.kind === "statute" || item.classification.kind === "noise",
    )
    .flatMap((item) => item.classification.reasons)
    .reduce<Record<string, number>>((acc, reason) => {
      acc[reason] = (acc[reason] ?? 0) + 1;
      return acc;
    }, {});

  const caseCandidates = postVerify
    .filter(
      (item) =>
        item.classification.kind === "case" || item.classification.kind === "unknown",
    )
    .map((item) => {
      const { classification, ...candidate } = item;
      void classification;
      return candidate;
    });

  const courtFiltered = caseCandidates.filter((candidate) => candidate.court === "SC" || candidate.court === "HC");
  const scoredInput = courtFiltered.length > 0 ? courtFiltered : caseCandidates;
  const scored = scoreCases(input.query, input.context, scoredInput, {
    checklist: input.checklist,
    canonicalLexicalProfile: input.canonicalLexicalProfile,
    candidateProvenance: input.candidateProvenance,
  });
  const prioritized = applySupremeCourtPreference(scored);
  const relevant = prioritized.filter(isRelevantCase);
  const pool = relevant.length > 0 ? relevant : prioritized;
  const diversified = diversifyRankedCases(pool, {
    maxPerFingerprint: 1,
    maxPerCourtDay: 1,
  });
  const duplicatesCollapsed = Math.max(pool.length - diversified.length, 0);
  const rankedPool = diversified.slice(0, Math.max(input.maxResults * 3, 24));

  return {
    counts,
    rejectionReasons,
    rankedPool,
    courtFilteredCount: courtFiltered.length,
    scCount: courtFiltered.filter((candidate) => candidate.court === "SC").length,
    duplicatesCollapsed,
    verificationSummary: {
      attempted: verified.summary.attempted,
      detailFetched: verified.summary.detailFetched,
      detailFetchFailed: verified.summary.detailFetchFailed,
      detailFetchFallbackUsed: verified.summary.detailFetchFallbackUsed,
      detailFetchErrorCounts: verified.summary.detailFetchErrorCounts,
      detailFetchSampleErrors: verified.summary.detailFetchSampleErrors,
      hybridFallbackUsed: verified.summary.hybridFallbackUsed,
      hybridFallbackSuccesses: verified.summary.hybridFallbackSuccesses,
      detailHydrationCoverage: verified.summary.detailHydrationCoverage,
      passedCaseGate: verified.summary.passedCaseGate,
    },
  };
}

async function runQualityAwarePhases(input: {
  variants: QueryVariant[];
  intent: ReturnType<typeof buildIntentProfile>;
  config: SchedulerConfig;
  provider: RetrievalProvider;
  allowNetworkFetch: boolean;
  canonicalLexicalProfile?: CanonicalLexicalProfile;
  carryState?: SchedulerResult["carryState"];
  cooldownScope?: string;
  strictStopTarget: number;
  bestEffortStopTarget: number;
  query: string;
  maxResults: number;
  checklist: PropositionChecklist;
}): Promise<PhaseRunResult> {
  const phaseOrder = ["primary", "fallback", "rescue", "micro", "revolving", "browse"] as const;
  const phaseBuckets = new Map<string, QueryVariant[]>();
  for (const phase of phaseOrder) {
    phaseBuckets.set(
      phase,
      input.variants.filter((variant) => variant.phase === phase),
    );
  }

  let scheduler: SchedulerResult = await runRetrievalSchedule({
    variants: [],
    intent: input.intent,
    config: input.config,
    provider: input.provider,
    carryState: input.carryState,
    cooldownScope: input.cooldownScope,
  });
  let evaluation = await evaluateCandidates({
    query: input.query,
    maxResults: input.maxResults,
    verifyLimit: input.config.verifyLimit,
    allowNetworkFetch: input.allowNetworkFetch,
    context: input.intent.context,
    checklist: input.checklist,
    candidates: scheduler.candidates,
    canonicalLexicalProfile: input.canonicalLexicalProfile,
    candidateProvenance: scheduler.carryState.candidateProvenance,
  });
  let propositionSplit = splitByProposition(evaluation.rankedPool, input.checklist);
  let lastCandidateSignature = `${scheduler.candidates.length}|${scheduler.candidates
    .slice(0, 48)
    .map((candidate) => candidate.url)
    .join("|")}`;

  for (const phase of phaseOrder) {
    const phaseVariants = phaseBuckets.get(phase) ?? [];
    if (phaseVariants.length === 0) continue;
    scheduler = await runRetrievalSchedule({
      variants: phaseVariants,
      intent: input.intent,
      config: input.config,
      provider: input.provider,
      carryState: scheduler.carryState,
      cooldownScope: input.cooldownScope,
    });
    const currentCandidateSignature = `${scheduler.candidates.length}|${scheduler.candidates
      .slice(0, 48)
      .map((candidate) => candidate.url)
      .join("|")}`;
    if (currentCandidateSignature !== lastCandidateSignature) {
      evaluation = await evaluateCandidates({
        query: input.query,
        maxResults: input.maxResults,
        verifyLimit: input.config.verifyLimit,
        allowNetworkFetch: input.allowNetworkFetch,
        context: input.intent.context,
        checklist: input.checklist,
        candidates: scheduler.candidates,
        canonicalLexicalProfile: input.canonicalLexicalProfile,
        candidateProvenance: scheduler.carryState.candidateProvenance,
      });
      propositionSplit = splitByProposition(evaluation.rankedPool, input.checklist);
      lastCandidateSignature = currentCandidateSignature;
    }
    const qualifiedProvisional = qualifiedProvisionalCount(propositionSplit.exactProvisional);
    const provisionalHasCoreFailures = propositionSplit.exactProvisional.some(
      (item) =>
        (item.missingCoreElements?.length ?? 0) > 0 ||
        (item.missingMandatorySteps?.length ?? 0) > 0,
    );
    const chainCoverageReady = propositionSplit.chainCoverageAvg >= PROPOSITION_CHAIN_MIN_COVERAGE;
    const detailCoverageReady =
      evaluation.verificationSummary.detailFetched >= DETAIL_MIN_SUCCESS_BEFORE_EARLY_STOP;
    const phaseFloorReady = hasPrimaryFallbackCourtFloor(scheduler.attempts);
    const earlyStopQualityReady = detailCoverageReady && phaseFloorReady;
    if (
      earlyStopQualityReady &&
      ((propositionSplit.strictExactCount >= input.strictStopTarget && chainCoverageReady) ||
        (propositionSplit.strictExactCount + qualifiedProvisional >= input.bestEffortStopTarget &&
          !provisionalHasCoreFailures &&
          chainCoverageReady))
    ) {
      scheduler = {
        ...scheduler,
        stopReason: "enough_candidates",
      };
      break;
    }
    if (scheduler.stopReason === "blocked" || scheduler.stopReason === "budget_exhausted") {
      break;
    }
  }

  return {
    scheduler,
    evaluation,
    propositionSplit,
  };
}

function mergeVariantTokenLists(values: string[] | undefined, fallback: string[] | undefined, max = 24): string[] | undefined {
  if (!values && !fallback) return undefined;
  return uniqueLimit([...(values ?? []), ...(fallback ?? [])], max);
}

function mergeVariants(variants: QueryVariant[]): QueryVariant[] {
  const merged = new Map<string, QueryVariant>();
  for (const variant of variants) {
    const key = `${variant.phase}|${variant.phrase.toLowerCase()}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, variant);
      continue;
    }
    const existingPriority = existing.priority ?? 0;
    const incomingPriority = variant.priority ?? 0;
    const keepIncoming =
      incomingPriority > existingPriority ||
      (incomingPriority === existingPriority &&
        variant.strictness === "strict" &&
        existing.strictness !== "strict");
    const preferred = keepIncoming ? variant : existing;
    const secondary = keepIncoming ? existing : variant;
    merged.set(key, {
      ...preferred,
      canonicalKey: preferred.canonicalKey ?? secondary.canonicalKey,
      mustIncludeTokens: mergeVariantTokenLists(preferred.mustIncludeTokens, secondary.mustIncludeTokens, 24),
      mustExcludeTokens: mergeVariantTokenLists(preferred.mustExcludeTokens, secondary.mustExcludeTokens, 16),
      providerHints: {
        compiledQuery:
          preferred.providerHints?.compiledQuery ?? secondary.providerHints?.compiledQuery,
        serperQuotedTerms: mergeVariantTokenLists(
          preferred.providerHints?.serperQuotedTerms,
          secondary.providerHints?.serperQuotedTerms,
          6,
        ),
        serperCoreTerms: mergeVariantTokenLists(
          preferred.providerHints?.serperCoreTerms,
          secondary.providerHints?.serperCoreTerms,
          8,
        ),
        canonicalOrderTerms: mergeVariantTokenLists(
          preferred.providerHints?.canonicalOrderTerms,
          secondary.providerHints?.canonicalOrderTerms,
          18,
        ),
        excludeTerms: mergeVariantTokenLists(
          preferred.providerHints?.excludeTerms,
          secondary.providerHints?.excludeTerms,
          12,
        ),
      },
    });
  }
  return Array.from(merged.values());
}

function buildPass2Snippets(cases: ScoredCase[]): string[] {
  return cases
    .slice(0, 10)
    .map((item) => `${item.title}. ${item.snippet ?? ""} ${item.detailText?.slice(0, 250) ?? ""}`.trim())
    .filter((snippet) => snippet.length > 24);
}

export async function runPipelineSearch(input: {
  query: string;
  maxResults: number;
  requestId: string;
  debugEnabled: boolean;
  cooldownScope?: string;
}): Promise<{
  response: SearchResponse;
  debug?: {
    requestId: string;
    cleanedQuery: string;
    planner: {
      source: "bedrock" | "fallback";
      modelId?: string;
      error?: string;
      reasonerMode?: "opus" | "deterministic";
      reasonerDegraded?: boolean;
      reasonerAttempted?: boolean;
      reasonerStatus?: ReasonerHealthStatus;
      reasonerSkipReason?: string;
      reasonerError?: string;
      reasonerWarnings?: string[];
      reasonerTimeoutMsUsed?: number;
      reasonerLatencyMs?: number;
    };
    phrases: string[];
    source: Array<{
      phrase: string;
      searchQuery?: string;
      canonicalKey?: string;
      variantPriority?: number;
      utilityScore?: number;
      caseLikeRatio?: number;
      statuteLikeRatio?: number;
      status: number;
      ok: boolean;
      phase: string;
      parserMode?: string;
      pagesScanned?: number;
      pageCaseCounts?: number[];
      nextPageDetected?: boolean;
      rawParsedCount?: number;
      excludedStatuteCount?: number;
      excludedWeakCount?: number;
      cloudflareDetected: boolean;
      challengeDetected: boolean;
      cooldownActive?: boolean;
      retryAfterMs?: number;
      blockedType?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
      timedOut?: boolean;
      fetchTimeoutMsUsed?: number;
      parsedCount: number;
      htmlPreview?: string;
      error: string | null;
      variantId?: string;
      providerId?: string;
    }>;
    courtBreakdown: {
      sc: number;
      hc: number;
      unknown: number;
    };
    phaseBreakdown: Record<string, number>;
    diagnostics: {
      challengeCount: number;
      rateLimitCount: number;
      timeoutCount?: number;
      noMatchCount: number;
      successCount: number;
      blockedState: boolean;
      stopReason: string;
      blockedReason?: string;
      blockedKind?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
      retryAfterMs?: number;
      skippedDuplicates: number;
      alwaysReturnFallbackUsed?: boolean;
      alwaysReturnFallbackType?: "none" | "stale_cache" | "synthetic_advisory";
      alwaysReturnFallbackReason?: string;
      rejectionReasons: Record<string, number>;
    };
  };
}> {
  const intent = buildIntentProfile(input.query);
  const retrievalSelection = pickRetrievalProvider();
  const retrievalProvider = retrievalSelection.provider;
  const allowNetworkFetch = retrievalProvider.supportsDetailFetch;
  const strictCaseOnly = parseBooleanEnv(process.env.STRICT_CASE_ONLY, true);
  const requireSupremeCourt = parseBooleanEnv(process.env.REQUIRE_SUPREME_COURT, false);
  const minCaseTarget = Math.min(Math.max(Math.floor(input.maxResults / 2), 6), 12);
  const timeoutRecoveryMode = REASONER_TIMEOUT_RECOVERY_MODE;
  const effectiveVerifyLimit = Math.max(4, Number(process.env.DEFAULT_VERIFY_LIMIT ?? String(DEFAULT_VERIFY_LIMIT)));
  const effectiveGlobalBudget = Math.max(
    4,
    Number(process.env.DEFAULT_GLOBAL_BUDGET ?? String(DEFAULT_GLOBAL_BUDGET)),
  );
  let extendedDeterministicUsed = false;

  const pass1Invoked = true;
  let pass2Invoked = false;
  let pass2Reason: string | undefined;
  let pass2LatencyMs: number | undefined;

  const reasonerPass1 = await runOpusReasoner({
    mode: "pass1",
    query: input.query,
    cleanedQuery: intent.cleanedQuery,
    context: intent.context,
    requestCallIndex: 0,
  });
  const reasonerHealth = classifyReasonerHealth({
    mode: reasonerPass1.telemetry.mode,
    error: reasonerPass1.telemetry.error,
  });

  let config: SchedulerConfig = {
    strictCaseOnly,
    verifyLimit: effectiveVerifyLimit,
    globalBudget: effectiveGlobalBudget,
    phaseLimits: PHASE_LIMITS,
    blockedThreshold: DEFAULT_BLOCKED_THRESHOLD,
    minCaseTarget,
    requireSupremeCourt,
    maxElapsedMs: PIPELINE_MAX_ELAPSED_MS,
    stopOnCandidateTarget:
      retrievalProvider.id === "serper" ? SERPER_STOP_ON_CANDIDATE_TARGET : true,
    fetchTimeoutMs: IK_FETCH_TIMEOUT_MS,
    max429Retries: IK_MAX_429_RETRIES,
    maxRetryAfterMs: IK_MAX_RETRY_AFTER_MS,
  };

  if (reasonerPass1.telemetry.timeout && timeoutRecoveryMode === "extended_deterministic") {
    config = {
      ...config,
      globalBudget: Math.min(config.globalBudget + EXTENDED_DETERMINISTIC_BUDGET_BONUS, config.globalBudget + 16),
      phaseLimits: withExtendedPhaseLimits(config.phaseLimits, EXTENDED_DETERMINISTIC_BUDGET_BONUS),
    };
    extendedDeterministicUsed = true;
  }

  let activeReasonerPlan = reasonerPass1.plan;
  let reasonerGroundingApplied = false;
  let reasonerGroundingDroppedOutcome = false;
  let reasonerGroundingDroppedHooks = 0;
  let reasonerGroundingVariantPrunedCount = 0;
  if (activeReasonerPlan) {
    const grounded = groundReasonerPlanToIntent({
      plan: activeReasonerPlan,
      cleanedQuery: intent.cleanedQuery,
      context: intent.context,
    });
    activeReasonerPlan = grounded.plan;
    reasonerGroundingApplied = grounded.telemetry.applied;
    reasonerGroundingDroppedOutcome = grounded.telemetry.droppedOutcome;
    reasonerGroundingDroppedHooks = grounded.telemetry.droppedHooks;
    reasonerGroundingVariantPrunedCount = grounded.telemetry.variantPrunedCount;
    if (activeReasonerPlan.query_variants_strict.length === 0 && isSparseIntent(intent)) {
      activeReasonerPlan = undefined;
      reasonerGroundingApplied = true;
    }
  }
  const deterministicPlanner = await planDeterministicQueryVariants(intent, activeReasonerPlan);
  let pass2Variants: ReturnType<typeof buildReasonerQueryVariants> = [];
  let traceVariantsUsed: ReturnType<typeof buildTraceQueryVariants> = [];
  let rewriteVariantsUsed: QueryVariant[] = [];
  let canonicalIntent: CanonicalIntent | undefined;
  let queryRewriteApplied = false;
  let queryRewriteError: string | undefined;

  const initialReasonerVariants = activeReasonerPlan
    ? buildReasonerQueryVariants({ intent, plan: activeReasonerPlan })
    : [];
  try {
    if (QUERY_REWRITE_V2_ENABLED) {
      canonicalIntent = buildCanonicalIntent(intent, activeReasonerPlan);
      rewriteVariantsUsed = synthesizeRetrievalQueries({
        canonicalIntent,
        deterministicPlanner,
        reasonerVariants: initialReasonerVariants,
      });
      queryRewriteApplied = rewriteVariantsUsed.length > 0;
    }
  } catch (error) {
    queryRewriteError = error instanceof Error ? error.message : "query_rewrite_failed";
    rewriteVariantsUsed = [];
  }
  const initialPlannerVariants = mergeVariants([...initialReasonerVariants, ...deterministicPlanner.variants]);
  const initialVariants = mergeCanonicalRewriteVariants({
    plannerVariants: initialPlannerVariants,
    rewriteVariants: rewriteVariantsUsed,
  });
  let checklist = applyPropositionMode(
    buildPropositionChecklist({
      context: intent.context,
      cleanedQuery: intent.cleanedQuery,
      reasonerPlan: activeReasonerPlan,
    }),
  );
  let canonicalLexicalProfile: CanonicalLexicalProfile | undefined =
    CANONICAL_LEXICAL_SCORING_ENABLED && canonicalIntent
      ? {
          mustIncludeTokens: canonicalIntent.mustIncludeTokens,
          strictVariantTokens: uniqueLimit(
            initialVariants
              .filter((variant) => variant.strictness === "strict")
              .flatMap((variant) => variant.tokens),
            64,
          ),
          checklistTokens: uniqueLimit(
            [...checklist.requiredElements, ...checklist.optionalElements].flatMap((value) =>
              value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((token) => token.length > 1),
            ),
            48,
          ),
          contradictionTokens: uniqueLimit(
            [...checklist.contradictionTerms, ...canonicalIntent.contradictionTerms],
            24,
          ),
        }
      : undefined;
  let phaseRun = await runQualityAwarePhases({
    variants: initialVariants,
    intent,
    config,
    provider: retrievalProvider,
    allowNetworkFetch,
    canonicalLexicalProfile,
    cooldownScope: input.cooldownScope,
    strictStopTarget: PROPOSITION_STRICT_STOP_TARGET,
    bestEffortStopTarget: PROPOSITION_BEST_EFFORT_STOP_TARGET,
    query: input.query,
    maxResults: input.maxResults,
    checklist,
  });
  let scheduler = phaseRun.scheduler;
  let evaluation = phaseRun.evaluation;
  let propositionSplit = phaseRun.propositionSplit;
  let qualifiedProvisionals = qualifiedProvisionalCount(propositionSplit.exactProvisional);
  let qualifiedExactTotal = propositionSplit.strictExactCount + qualifiedProvisionals;

  if (
    extendedDeterministicUsed &&
    propositionSplit.strictExactCount < PROPOSITION_STRICT_STOP_TARGET &&
    scheduler.stopReason !== "blocked"
  ) {
    const remainingForTrace = config.globalBudget - scheduler.carryState.attemptsUsed;
    const remainingElapsedMs = Math.max(0, config.maxElapsedMs - (Date.now() - scheduler.carryState.startedAtMs));
    if (remainingForTrace >= 3 && remainingElapsedMs >= TRACE_EXPANSION_MIN_REMAINING_MS) {
      const traceVariants = buildTraceQueryVariants({
        intent,
        seedCases: evaluation.rankedPool.slice(0, 8),
        maxVariants: Math.min(10, remainingForTrace),
      });
      const constrainedTraceVariants = filterTraceVariantsByChecklist(traceVariants, checklist);
      if (constrainedTraceVariants.length > 0) {
        traceVariantsUsed = mergeVariants([...traceVariantsUsed, ...constrainedTraceVariants]);
        phaseRun = await runQualityAwarePhases({
          variants: mergeVariants(constrainedTraceVariants),
          intent,
          config,
          provider: retrievalProvider,
          allowNetworkFetch,
          canonicalLexicalProfile,
          carryState: scheduler.carryState,
          cooldownScope: input.cooldownScope,
          strictStopTarget: PROPOSITION_STRICT_STOP_TARGET,
          bestEffortStopTarget: PROPOSITION_BEST_EFFORT_STOP_TARGET,
          query: input.query,
          maxResults: input.maxResults,
          checklist,
        });
        scheduler = phaseRun.scheduler;
        evaluation = phaseRun.evaluation;
        propositionSplit = phaseRun.propositionSplit;
        qualifiedProvisionals = qualifiedProvisionalCount(propositionSplit.exactProvisional);
        qualifiedExactTotal = propositionSplit.strictExactCount + qualifiedProvisionals;
      }
    }
  }

  const remainingBudget = config.globalBudget - scheduler.carryState.attemptsUsed;
  const remainingMsForPass2 = Math.max(0, config.maxElapsedMs - (Date.now() - scheduler.carryState.startedAtMs));
  const shouldRunPass2 =
    Boolean(activeReasonerPlan) &&
    scheduler.stopReason !== "blocked" &&
    remainingBudget >= PASS2_MIN_REMAINING_BUDGET &&
    remainingMsForPass2 >= PASS2_MIN_REMAINING_MS &&
    (qualifiedExactTotal < Math.max(PASS2_MIN_EXACT, PROPOSITION_BEST_EFFORT_STOP_TARGET) ||
      propositionSplit.requiredElementCoverageAvg < PASS2_MIN_COVERAGE ||
      propositionSplit.hookGroupCoverageAvg < PASS2_MIN_HOOK_COVERAGE ||
      propositionSplit.relationFailureCount > 0 ||
      propositionSplit.polarityMismatchCount > 0);

  let reasonerPass2Error: string | undefined;
  if (shouldRunPass2) {
    pass2Invoked = true;
    pass2Reason =
      qualifiedExactTotal < Math.max(PASS2_MIN_EXACT, PROPOSITION_BEST_EFFORT_STOP_TARGET)
        ? `low_quality_exact:${qualifiedExactTotal}<${Math.max(PASS2_MIN_EXACT, PROPOSITION_BEST_EFFORT_STOP_TARGET)}`
        : propositionSplit.relationFailureCount > 0
          ? `relation_failures:${propositionSplit.relationFailureCount}`
          : propositionSplit.polarityMismatchCount > 0
            ? `polarity_mismatch:${propositionSplit.polarityMismatchCount}`
            : propositionSplit.hookGroupCoverageAvg < PASS2_MIN_HOOK_COVERAGE
              ? `low_hook_group_coverage:${propositionSplit.hookGroupCoverageAvg}<${PASS2_MIN_HOOK_COVERAGE}`
              : `low_required_coverage:${propositionSplit.requiredElementCoverageAvg}<${PASS2_MIN_COVERAGE}`;
    const snippets = buildPass2Snippets(evaluation.rankedPool);
    const reasonerPass2 = await runOpusReasoner({
      mode: "pass2",
      query: input.query,
      cleanedQuery: intent.cleanedQuery,
      context: intent.context,
      requestCallIndex: 1,
      basePlan: activeReasonerPlan,
      snippets,
    });
    pass2LatencyMs = reasonerPass2.telemetry.latencyMs;

    if (reasonerPass2.plan) {
      let pass2Plan = reasonerPass2.plan;
      const groundedPass2 = groundReasonerPlanToIntent({
        plan: pass2Plan,
        cleanedQuery: intent.cleanedQuery,
        context: intent.context,
      });
      pass2Plan = groundedPass2.plan;
      reasonerGroundingApplied = reasonerGroundingApplied || groundedPass2.telemetry.applied;
      reasonerGroundingDroppedOutcome =
        reasonerGroundingDroppedOutcome || groundedPass2.telemetry.droppedOutcome;
      reasonerGroundingDroppedHooks += groundedPass2.telemetry.droppedHooks;
      reasonerGroundingVariantPrunedCount += groundedPass2.telemetry.variantPrunedCount;
      if (pass2Plan.query_variants_strict.length === 0 && isSparseIntent(intent)) {
        pass2Plan = activeReasonerPlan ?? pass2Plan;
      }
      activeReasonerPlan = pass2Plan;
      checklist = applyPropositionMode(
        buildPropositionChecklist({
          context: intent.context,
          cleanedQuery: intent.cleanedQuery,
          reasonerPlan: activeReasonerPlan,
        }),
      );
      const pass2ReasonerVariants = buildReasonerQueryVariants({
        intent,
        plan: activeReasonerPlan,
      });
      pass2Variants = pass2ReasonerVariants;
      if (QUERY_REWRITE_V2_ENABLED) {
        try {
          canonicalIntent = buildCanonicalIntent(intent, activeReasonerPlan);
          const pass2RewriteVariants = synthesizeRetrievalQueries({
            canonicalIntent,
            deterministicPlanner,
            reasonerVariants: pass2ReasonerVariants,
          });
          if (pass2RewriteVariants.length > 0) {
            rewriteVariantsUsed = mergeVariants([...rewriteVariantsUsed, ...pass2RewriteVariants]);
            pass2Variants = mergeCanonicalRewriteVariants({
              plannerVariants: pass2Variants,
              rewriteVariants: pass2RewriteVariants,
            });
            queryRewriteApplied = true;
          }
        } catch (error) {
          if (!queryRewriteError) {
            queryRewriteError = error instanceof Error ? error.message : "query_rewrite_pass2_failed";
          }
        }
      }
      if (CANONICAL_LEXICAL_SCORING_ENABLED && canonicalIntent) {
        canonicalLexicalProfile = {
          mustIncludeTokens: canonicalIntent.mustIncludeTokens,
          strictVariantTokens: uniqueLimit(
            pass2Variants
              .filter((variant) => variant.strictness === "strict")
              .flatMap((variant) => variant.tokens),
            64,
          ),
          checklistTokens: uniqueLimit(
            [...checklist.requiredElements, ...checklist.optionalElements].flatMap((value) =>
              value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((token) => token.length > 1),
            ),
            48,
          ),
          contradictionTokens: uniqueLimit(
            [...checklist.contradictionTerms, ...canonicalIntent.contradictionTerms],
            24,
          ),
        };
      }
      phaseRun = await runQualityAwarePhases({
        variants: mergeVariants(pass2Variants),
        intent,
        config,
        provider: retrievalProvider,
        allowNetworkFetch,
        canonicalLexicalProfile,
        carryState: scheduler.carryState,
        cooldownScope: input.cooldownScope,
        strictStopTarget: PROPOSITION_STRICT_STOP_TARGET,
        bestEffortStopTarget: PROPOSITION_BEST_EFFORT_STOP_TARGET,
        query: input.query,
        maxResults: input.maxResults,
        checklist,
      });
      scheduler = phaseRun.scheduler;
      evaluation = phaseRun.evaluation;
      propositionSplit = phaseRun.propositionSplit;
      qualifiedProvisionals = qualifiedProvisionalCount(propositionSplit.exactProvisional);
      qualifiedExactTotal = propositionSplit.strictExactCount + qualifiedProvisionals;
    } else {
      reasonerPass2Error = reasonerPass2.telemetry.error ?? "reasoner_pass2_unavailable";
    }
  }

  let guaranteeTriggered = false;
  let guaranteeAttemptsUsed = 0;
  let guaranteeSource: "live" | "stale_cache" | "synthetic" | "none" = "none";
  let guaranteeUsed = false;
  let staleFallbackUsed = false;
  let staleFallbackSignatureLevel: "exact" | "full" | "medium" | "broad" | undefined;
  let syntheticFallbackUsed = false;
  let syntheticFallbackReason: string | undefined;
  let syntheticFallbackBuildError: string | undefined;
  let alwaysReturnFallbackType: "none" | "stale_cache" | "synthetic_advisory" = "none";
  let alwaysReturnFallbackReason: string | undefined;
  let guaranteeBackfillVariantsUsed: QueryVariant[] = [];

  if (ALWAYS_RETURN_V1_ENABLED && scheduler.stopReason !== "blocked") {
    const provisionalExactStrict = PROPOSITION_V41_ENABLED
      ? propositionSplit.exactStrict.slice(0, input.maxResults)
      : propositionSplit.exact.slice(0, input.maxResults);
    const provisionalExactProvisional = PROPOSITION_V41_ENABLED
      ? propositionSplit.exactProvisional.slice(0, input.maxResults)
      : [];
    const provisionalExploratory = propositionSplit.nearMiss.slice(0, NEAR_MISS_MAX_RESULTS);
    const provisionalTotal =
      provisionalExactStrict.length + provisionalExactProvisional.length + provisionalExploratory.length;
    const remainingMsForGuarantee = Math.max(
      0,
      config.maxElapsedMs - (Date.now() - scheduler.carryState.startedAtMs),
    );

    if (provisionalTotal < GUARANTEE_MIN_RESULTS && remainingMsForGuarantee >= GUARANTEE_MIN_REMAINING_MS) {
      guaranteeTriggered = true;
      guaranteeUsed = true;
      guaranteeSource = "live";

      const attemptsBeforeGuarantee = scheduler.carryState.attemptsUsed;
      const guaranteePhrases = uniqueLimit(
        [
          ...(
            await planAIFailoverQueryVariants(intent, deterministicPlanner.keywordPack, activeReasonerPlan)
          ).variants
            .filter((variant) => variant.strictness === "relaxed")
            .map((variant) => variant.phrase),
          ...deterministicPlanner.variants
            .filter((variant) => variant.strictness === "relaxed")
            .map((variant) => variant.phrase),
          ...ontologyTemplatesForContext(intent.context),
          ...(activeReasonerPlan?.query_variants_broad ?? []),
          ...(activeReasonerPlan?.case_anchors ?? []),
          ...intent.issues,
          ...intent.procedures,
          ...intent.statutes,
        ],
        32,
      );

      const guaranteeVariants = buildGuaranteeBackfillVariants({
        intent,
        phrases: guaranteePhrases,
        reasonerPlan: activeReasonerPlan,
        maxVariants: Math.min(6, GUARANTEE_EXTRA_ATTEMPTS * 3),
      });

      if (guaranteeVariants.length > 0) {
        guaranteeBackfillVariantsUsed = mergeVariants(guaranteeVariants);
        const guaranteeConfig: SchedulerConfig = {
          ...config,
          globalBudget: Math.max(config.globalBudget, attemptsBeforeGuarantee + GUARANTEE_EXTRA_ATTEMPTS),
        };
        phaseRun = await runQualityAwarePhases({
          variants: guaranteeBackfillVariantsUsed,
          intent,
          config: guaranteeConfig,
          provider: retrievalProvider,
          allowNetworkFetch,
          canonicalLexicalProfile,
          carryState: scheduler.carryState,
          cooldownScope: input.cooldownScope,
          strictStopTarget: PROPOSITION_STRICT_STOP_TARGET,
          bestEffortStopTarget: PROPOSITION_BEST_EFFORT_STOP_TARGET,
          query: input.query,
          maxResults: input.maxResults,
          checklist,
        });
        scheduler = phaseRun.scheduler;
        evaluation = phaseRun.evaluation;
        propositionSplit = phaseRun.propositionSplit;
        qualifiedProvisionals = qualifiedProvisionalCount(propositionSplit.exactProvisional);
        qualifiedExactTotal = propositionSplit.strictExactCount + qualifiedProvisionals;
        config = guaranteeConfig;
      }
      guaranteeAttemptsUsed = Math.max(0, scheduler.carryState.attemptsUsed - attemptsBeforeGuarantee);
    }
  }

  const casesExactStrict = PROPOSITION_V41_ENABLED
    ? propositionSplit.exactStrict.slice(0, input.maxResults)
    : propositionSplit.exact.slice(0, input.maxResults);
  const casesExactProvisional = PROPOSITION_V41_ENABLED
    ? propositionSplit.exactProvisional.slice(0, input.maxResults)
    : [];
  const casesExact = PROPOSITION_V41_ENABLED
    ? [...casesExactStrict, ...casesExactProvisional].slice(0, input.maxResults)
    : propositionSplit.exact.slice(0, input.maxResults);
  let casesExploratory: NearMissCase[] = propositionSplit.nearMiss.slice(0, NEAR_MISS_MAX_RESULTS);
  let casesNearMiss: NearMissCase[] = [...casesExploratory];

  if (guaranteeTriggered && guaranteeSource === "live" && casesExploratory.length > 0) {
    casesExploratory = casesExploratory.map((item) => ({
      ...item,
      retrievalTier: "exploratory",
      fallbackReason: "guarantee_backfill",
      gapSummary: item.gapSummary ?? item.missingElements,
    }));
    casesNearMiss = [...casesExploratory];
  }

  if (
    ALWAYS_RETURN_V1_ENABLED &&
    STALE_FALLBACK_ENABLED &&
    (scheduler.stopReason === "blocked" || (casesExact.length === 0 && casesExploratory.length === 0))
  ) {
    const staleRecall = await lookupFallbackRecallEntry({
      query: input.query,
      actors: intent.actors,
      procedures: intent.procedures,
      statutes: intent.statutes,
      issues: intent.issues,
      domains: intent.domains,
      maxCases: GUARANTEE_MIN_RESULTS,
      minSimilarity: STALE_FALLBACK_MIN_SIMILARITY,
    });
    if (staleRecall && staleRecall.cases.length > 0) {
      staleFallbackUsed = true;
      staleFallbackSignatureLevel = staleRecall.signatureLevel;
      casesExploratory = staleRecall.cases.slice(0, NEAR_MISS_MAX_RESULTS);
      casesNearMiss = [...casesExploratory];
      guaranteeUsed = true;
      guaranteeSource = "stale_cache";
      alwaysReturnFallbackType = "stale_cache";
      alwaysReturnFallbackReason = `stale_cache_similarity:${staleRecall.signatureLevel}`;
    }
  }

  const shouldInjectSynthetic = shouldInjectSyntheticFallback({
    alwaysReturnEnabled: ALWAYS_RETURN_V1_ENABLED,
    syntheticFallbackEnabled: ALWAYS_RETURN_SYNTHETIC_FALLBACK_ENABLED,
    casesExactCount: casesExact.length,
    casesExploratoryCount: casesExploratory.length,
  });
  if (shouldInjectSynthetic) {
    try {
      const synthetic = buildSyntheticAdvisoryNearMiss({
        query: input.query,
        intent,
        checklist,
        schedulerStopReason: scheduler.stopReason,
        blockedKind: scheduler.blockedKind,
        queryRewrite: {
          applied: queryRewriteApplied,
          error: queryRewriteError,
          canonicalMustIncludeTokens: canonicalIntent?.mustIncludeTokens.slice(0, 8),
          strictVariantPhrases: rewriteVariantsUsed
            .filter((variant) => variant.strictness === "strict")
            .map((variant) => variant.phrase)
            .slice(0, 3),
        },
      });
      syntheticFallbackUsed = true;
      syntheticFallbackReason = synthetic.reason;
      alwaysReturnFallbackType = "synthetic_advisory";
      alwaysReturnFallbackReason = synthetic.reason;
      casesExploratory = [synthetic.item];
      casesNearMiss = [synthetic.item];
      guaranteeUsed = true;
      guaranteeSource = "synthetic";
    } catch (error) {
      syntheticFallbackBuildError = error instanceof Error ? error.message : "synthetic_fallback_build_failed";
    }
  }

  const tierCounts = {
    exactStrict: casesExactStrict.length,
    exactProvisional: casesExactProvisional.length,
    exploratory: casesExploratory.length,
  };
  const guaranteeMet =
    tierCounts.exactStrict + tierCounts.exactProvisional + tierCounts.exploratory >= GUARANTEE_MIN_RESULTS;

  const allVariants = mergeVariants([
    ...initialVariants,
    ...pass2Variants,
    ...traceVariantsUsed,
    ...guaranteeBackfillVariantsUsed,
  ]);
  const rewriteStrictCount = rewriteVariantsUsed.filter((variant) => variant.strictness === "strict").length;
  const rewriteBroadCount = Math.max(0, rewriteVariantsUsed.length - rewriteStrictCount);
  const variantUtilityEntries = Object.entries(scheduler.carryState.variantUtility ?? {});
  const variantUtilityTop = variantUtilityEntries
    .map(([canonicalKey, snapshot]) => ({
      canonicalKey,
      ...snapshot,
    }))
    .sort((left, right) => right.meanUtility - left.meanUtility)
    .slice(0, 6);
  const variantLookup = new Map(allVariants.map((variant) => [variant.id, variant]));
  const selectedVariants = scheduler.attempts
    .map((attempt) => {
      const variant = variantLookup.get(attempt.variantId);
      if (!variant) return null;
      return {
        id: variant.id,
        phase: variant.phase,
        purpose: variant.purpose,
        courtScope: variant.courtScope,
        strictness: variant.strictness,
        phrase: variant.phrase,
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const elapsedMs = Math.max(0, Date.now() - scheduler.carryState.startedAtMs);
  const partialDueToLatency =
    scheduler.stopReason === "budget_exhausted" &&
    (scheduler.blockedReason ?? "").startsWith("time_budget_exhausted:");
  const timeoutCount = scheduler.attempts.filter(
    (attempt) => attempt.timedOut === true || attempt.status === 408,
  ).length;
  const successfulAttemptsCount = scheduler.attempts.filter(
    (attempt) => attempt.ok && attempt.parsedCount > 0,
  ).length;
  const fetchTimeoutMsUsed =
    scheduler.attempts.reduce(
      (max, attempt) => Math.max(max, attempt.fetchTimeoutMsUsed ?? 0),
      0,
    ) || config.fetchTimeoutMs;

  const notes: string[] = [
    "This tool does not bypass anti-bot systems and may return fewer results when blocked or throttled.",
    "Use this as research triage only. Validate every citation manually.",
    "Confidence uses calibrated bands and is not a legal-certainty percentage.",
    "HIGH/VERY_HIGH confidence is restricted to strict exact matches with evidence-window support.",
  ];
  if (retrievalSelection.fallbackReason === "serper_missing_key") {
    notes.push("RETRIEVAL_PROVIDER=serper was requested but SERPER_API_KEY is missing; using Indian Kanoon HTML retrieval.");
  } else if (retrievalSelection.fallbackReason === "invalid_mode") {
    notes.push("RETRIEVAL_PROVIDER has an invalid value; using default Indian Kanoon HTML retrieval.");
  }
  if (!retrievalProvider.supportsDetailFetch) {
    notes.push("Detail verification was skipped (web-search retrieval). Results are snippet-based and confidence is capped.");
  }
  if (
    retrievalProvider.supportsDetailFetch &&
    evaluation.verificationSummary.attempted > 0 &&
    evaluation.verificationSummary.detailFetched === 0
  ) {
    notes.push("Detail verification failed for all shortlisted candidates; ranking stayed snippet-based for this run.");
  }
  if (
    retrievalProvider.supportsDetailFetch &&
    evaluation.verificationSummary.attempted > 0 &&
    evaluation.verificationSummary.detailFetched > 0 &&
    evaluation.verificationSummary.detailFetched < evaluation.verificationSummary.attempted
  ) {
    notes.push(
      `Detail verification informed ranking: ${evaluation.verificationSummary.detailFetched}/${evaluation.verificationSummary.attempted} shortlisted candidates were fully hydrated.`,
    );
  }
  if ((evaluation.verificationSummary.detailFetchFallbackUsed ?? 0) > 0) {
    notes.push(
      `Detail verification used canonical full-document fallback for ${evaluation.verificationSummary.detailFetchFallbackUsed} candidates.`,
    );
  }
  if ((evaluation.verificationSummary.hybridFallbackUsed ?? 0) > 0) {
    notes.push(
      `Hybrid detail fallback attempted for ${evaluation.verificationSummary.hybridFallbackUsed} shortlisted candidates.`,
    );
  }
  if ((evaluation.verificationSummary.hybridFallbackSuccesses ?? 0) > 0) {
    notes.push(
      `Hybrid detail fallback successfully hydrated ${evaluation.verificationSummary.hybridFallbackSuccesses} candidates.`,
    );
  }
  if (PROPOSITION_V3_ENABLED) {
    notes.push("Universal proposition V3 gating is active (all required hook groups + polarity checks).");
  } else {
    notes.push("Universal proposition V3 gating is disabled via PROPOSITION_V3=0.");
  }
  if (PROPOSITION_V41_ENABLED) {
    notes.push("Universal nuance V4.1 calibration is active (strict/provisional split with confidence bands).");
  } else {
    notes.push("Universal nuance V4.1 calibration disabled via PROPOSITION_V41=0.");
  }
  if (PROPOSITION_V5_ENABLED) {
    notes.push("Universal nuance V5 role-chain conjunctive gating is active.");
  } else {
    notes.push("Universal nuance V5 role-chain gating disabled via PROPOSITION_V5=0.");
  }

  if (reasonerPass1.telemetry.mode === "opus") {
    notes.push("Opus pass-1 generated proposition constraints and retrieval variants.");
  } else if (reasonerPass1.telemetry.degraded) {
    notes.push(
      `Opus pass-1 degraded to deterministic planning${reasonerPass1.telemetry.error ? ` (${reasonerPass1.telemetry.error})` : ""}.`,
    );
  }
  if (reasonerHealth.status === "timeout") {
    notes.push(
      `Bedrock reasoner call was attempted but timed out at ${reasonerPass1.telemetry.timeoutMsUsed ?? 0}ms.`,
    );
  } else if (reasonerHealth.status === "circuit_open") {
    notes.push("Bedrock reasoner circuit is temporarily open after recent failures; pass-1 call was skipped.");
  } else if (reasonerHealth.status === "config_error") {
    notes.push("Bedrock reasoner is misconfigured; deterministic planner was used.");
  }
  if (extendedDeterministicUsed) {
    notes.push(
      `Reasoner timeout recovery used ${timeoutRecoveryMode} with expanded deterministic budget (+${EXTENDED_DETERMINISTIC_BUDGET_BONUS}).`,
    );
  }
  if (QUERY_REWRITE_V2_ENABLED) {
    if (queryRewriteApplied) {
      notes.push(
        `Canonical query rewrite V2 generated ${rewriteVariantsUsed.length} variants (${rewriteStrictCount} strict, ${rewriteBroadCount} broad).`,
      );
    } else if (queryRewriteError) {
      notes.push(`Canonical query rewrite degraded to planner defaults (${queryRewriteError}).`);
    } else {
      notes.push("Canonical query rewrite V2 enabled with zero additional variants for this query.");
    }
  } else {
    notes.push("Canonical query rewrite V2 disabled via QUERY_REWRITE_V2=0.");
  }
  if (CANONICAL_LEXICAL_SCORING_ENABLED) {
    notes.push("Canonical lexical scoring blend is active.");
  } else {
    notes.push("Canonical lexical scoring blend disabled via CANONICAL_LEXICAL_SCORING=0.");
  }

  if (pass2Invoked) {
    if (reasonerPass2Error) {
      notes.push(`Opus pass-2 refinement degraded to pass-1 output (${reasonerPass2Error}).`);
    } else {
      notes.push("Conditional Opus pass-2 refinement executed to tighten proposition matching.");
    }
  }
  if (guaranteeTriggered) {
    notes.push(
      `Always-return guarantee pass triggered (extra attempts used: ${guaranteeAttemptsUsed}).`,
    );
  }
  if (syntheticFallbackBuildError) {
    notes.push(`Synthetic always-return fallback generation failed (${syntheticFallbackBuildError}).`);
  }

  if (scheduler.stopReason === "blocked") {
    const retryAfterText = scheduler.retryAfterMs
      ? ` Retry in about ${Math.max(1, Math.ceil(scheduler.retryAfterMs / 1000))}s.`
      : "";
    if (successfulAttemptsCount > 0) {
      notes.push(
        `Retrieval partially completed before source throttling.${retryAfterText} Additional expansion attempts were paused.`,
      );
    } else if (scheduler.blockedKind === "local_cooldown") {
      notes.push(`Retrieval paused due to active local Cloudflare cooldown.${retryAfterText}`);
    } else {
      notes.push(
        `Retrieval stopped early due to repeated source blocking (429/challenge).${retryAfterText} Try again later or narrow the facts.`,
      );
    }
  } else if (partialDueToLatency) {
    notes.push("partial_due_to_latency_budget: returned best available verified results within runtime budget.");
  } else if (scheduler.stopReason === "budget_exhausted") {
    notes.push("Retrieval budget exhausted before enough verified case candidates were found.");
  }

  if (evaluation.duplicatesCollapsed > 0) {
    notes.push(
      `Collapsed ${evaluation.duplicatesCollapsed} duplicate/near-duplicate judgments (including alternate party-name variants).`,
    );
  }
  if (casesExactProvisional.length > 0) {
    notes.push(
      `Best-effort exact mode retained ${casesExactProvisional.length} provisional matches (confidence-capped to MEDIUM by policy).`,
    );
  }
  if (staleFallbackUsed) {
    notes.push(
      `Served stale exploratory fallback from similarity-matched cache (${staleFallbackSignatureLevel ?? "unknown"} signature).`,
    );
  } else if (syntheticFallbackUsed) {
    notes.push(
      `Served synthetic advisory fallback because ${syntheticFallbackReason ?? "retrieval returned no verifiable candidates"}.`,
    );
  } else if (casesExact.length === 0 && casesNearMiss.length > 0) {
    notes.push("No exact proposition matches were found; near misses are shown separately with missing elements.");
  } else if (casesExact.length === 0 && scheduler.stopReason !== "blocked") {
    notes.push("No court-filtered exact matches found. Refine facts or add legal sections in the query.");
  } else if (
    (propositionSplit.strictExactCount >= PROPOSITION_STRICT_STOP_TARGET &&
      propositionSplit.chainCoverageAvg >= PROPOSITION_CHAIN_MIN_COVERAGE) ||
    (propositionSplit.strictExactCount + qualifiedProvisionalCount(propositionSplit.exactProvisional) >=
      PROPOSITION_BEST_EFFORT_STOP_TARGET &&
      propositionSplit.chainCoverageAvg >= PROPOSITION_CHAIN_MIN_COVERAGE)
  ) {
    notes.push(
      `Doctrinal quality stop target reached (strict=${propositionSplit.strictExactCount}, provisional=${qualifiedProvisionalCount(
        propositionSplit.exactProvisional,
      )}).`,
    );
  }
  if (ALWAYS_RETURN_V1_ENABLED) {
    if (guaranteeMet) {
      notes.push(`Tiered guarantee met (target=${GUARANTEE_MIN_RESULTS}).`);
    } else if (guaranteeUsed) {
      notes.push(`Tiered guarantee attempted but below target (target=${GUARANTEE_MIN_RESULTS}).`);
    }
    if (ALWAYS_RETURN_SYNTHETIC_FALLBACK_ENABLED && syntheticFallbackUsed) {
      notes.push("Synthetic always-return fallback injected one advisory exploratory result.");
    } else if (!ALWAYS_RETURN_SYNTHETIC_FALLBACK_ENABLED) {
      notes.push("Synthetic always-return fallback disabled via ALWAYS_RETURN_SYNTHETIC_FALLBACK=0.");
    }
  }

  const phaseCounts = allVariants.reduce<Record<string, number>>((acc, variant) => {
    acc[variant.phase] = (acc[variant.phase] ?? 0) + 1;
    return acc;
  }, {});
  for (const phase of PHASE_ORDER) {
    phaseCounts[phase] = phaseCounts[phase] ?? 0;
  }

  const attemptsByPhase = phaseCount(scheduler.attempts.map((attempt) => ({ phase: attempt.phase })));
  const successesByPhase = phaseCount(
    scheduler.attempts.filter((attempt) => attempt.ok && attempt.parsedCount > 0).map((attempt) => ({ phase: attempt.phase })),
  );
  const statusCounts = scheduler.attempts.reduce<Record<string, number>>((acc, attempt) => {
    const key = String(attempt.status);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const challengeCount = scheduler.attempts.filter((attempt) => attempt.challengeDetected).length;
  const rateLimitCount = scheduler.attempts.filter((attempt) => attempt.status === 429).length;
  const cooldownSkipCount = scheduler.attempts.filter((attempt) => attempt.cooldownActive === true).length;
  const noMatchCount = scheduler.attempts.filter((attempt) => /no matching results/i.test(attempt.htmlPreview ?? "")).length;
  const successCount = successfulAttemptsCount;
  const effectiveBlockedState = scheduler.stopReason === "blocked" && successCount === 0 && !staleFallbackUsed;
  const responseStatus: SearchResponse["status"] = staleFallbackUsed
    ? "partial"
    : syntheticFallbackUsed
      ? syntheticFallbackStatus(scheduler.stopReason)
    : effectiveBlockedState
    ? "blocked"
    : partialDueToLatency || (scheduler.stopReason === "blocked" && successCount > 0)
      ? "partial"
      : casesExact.length === 0 && casesExploratory.length === 0
        ? "no_match"
        : "completed";
  const partialRun =
    partialDueToLatency || (scheduler.stopReason === "blocked" && successCount > 0) || staleFallbackUsed;
  const insightsCases = casesExact.length > 0 ? casesExact : casesExploratory;

  const response: SearchResponse = {
    requestId: input.requestId,
    status: responseStatus,
    retryAfterMs: scheduler.retryAfterMs,
    blockedKind: scheduler.blockedKind,
    executionPath: "server_only",
    clientDirectAttempted: false,
    clientDirectSucceeded: false,
    partialRun,
    query: input.query,
    context: intent.context,
    proposition: {
      requiredElements: checklist.requiredElements,
      optionalElements: checklist.optionalElements,
      constraints: {
        hookGroups: checklist.hookGroups.map((group) => ({
          groupId: group.groupId,
          label: group.label,
          required: group.required,
          minMatch: group.minMatch,
        })),
        relations: checklist.relations.map((relation) => ({
          relationId: relation.relationId,
          type: relation.type,
          leftGroupId: relation.leftGroupId,
          rightGroupId: relation.rightGroupId,
          required: relation.required,
        })),
        outcomeConstraint: {
          polarity: checklist.outcomeConstraint.polarity,
          required: checklist.outcomeConstraint.required,
        },
        interactionRequired: checklist.interactionRequired,
      },
    },
    keywordPack: {
      ...deterministicPlanner.keywordPack,
      legalSignals: uniqueLimit(
        [
          ...deterministicPlanner.keywordPack.legalSignals,
          ...(activeReasonerPlan?.must_have_terms ?? []),
          ...(activeReasonerPlan?.case_anchors ?? []),
        ],
        20,
      ),
      searchPhrases: uniqueLimit(
        [
          ...deterministicPlanner.keywordPack.searchPhrases,
          ...(activeReasonerPlan?.query_variants_strict ?? []),
          ...(activeReasonerPlan?.query_variants_broad ?? []),
        ],
        28,
      ),
    },
    totalFetched: scheduler.candidates.length,
    filteredCount: evaluation.courtFilteredCount,
    cases: casesExact,
    casesExact,
    casesExactStrict,
    casesExactProvisional,
    casesNearMiss,
    casesExploratory,
    tierCounts,
    guarantee: {
      target: ALWAYS_RETURN_V1_ENABLED ? GUARANTEE_MIN_RESULTS : 0,
      met: ALWAYS_RETURN_V1_ENABLED ? guaranteeMet : false,
      used: ALWAYS_RETURN_V1_ENABLED ? guaranteeUsed : false,
      source: ALWAYS_RETURN_V1_ENABLED && guaranteeUsed ? guaranteeSource : "none",
    },
    reasoning: {
      mode: reasonerPass1.telemetry.mode,
      cacheHit: reasonerPass1.telemetry.cacheHit,
      latencyMs: reasonerPass1.telemetry.latencyMs,
      degraded: reasonerPass1.telemetry.degraded,
    },
    insights: buildSearchInsights({
      context: intent.context,
      cases: insightsCases,
      totalFetched: scheduler.candidates.length,
      filteredCount: evaluation.courtFilteredCount,
    }),
    notes,
    pipelineTrace: {
      planner: {
        source: deterministicPlanner.plannerSource,
        modelId: deterministicPlanner.plannerModelId,
        error: deterministicPlanner.plannerError,
        aiInvoked: false,
        aiInvocationReason: undefined,
        aiError: undefined,
        reasonerSource: reasonerPass1.telemetry.mode,
        reasonerCacheHit: reasonerPass1.telemetry.cacheHit,
        reasonerLatencyMs: reasonerPass1.telemetry.latencyMs,
        reasonerTimeoutMsUsed: reasonerPass1.telemetry.timeoutMsUsed,
        reasonerAdaptiveTimeoutApplied: reasonerPass1.telemetry.adaptiveTimeoutApplied,
        reasonerTimeout: reasonerPass1.telemetry.timeout,
        reasonerDegraded: reasonerPass1.telemetry.degraded,
        reasonerError: reasonerPass1.telemetry.error,
        reasonerWarnings: reasonerPass1.telemetry.warnings,
        reasonerAttempted: reasonerHealth.attempted,
        reasonerStatus: reasonerHealth.status,
        reasonerSkipReason: reasonerHealth.skipReason,
        reasonerStage: reasonerPass1.telemetry.reasonerStage,
        reasonerStageLatencyMs: reasonerPass1.telemetry.reasonerStageLatencyMs,
        reasonerPlanSource: reasonerPass1.telemetry.reasonerPlanSource,
        reasonerGroundingApplied,
        reasonerGroundingDroppedOutcome,
        reasonerGroundingDroppedHooks,
        reasonerGroundingVariantPrunedCount,
        pass1Invoked,
        pass2Invoked,
        pass2Reason,
        pass2LatencyMs,
        strictGroupsEnforced: deterministicPlanner.strictGroupCount,
        strictVariantsPreservedAllGroups: deterministicPlanner.strictVariantsPreservedAllGroups,
        timeoutRecoveryMode,
        extendedDeterministicUsed,
        queryRewrite: {
          enabled: QUERY_REWRITE_V2_ENABLED,
          applied: queryRewriteApplied,
          error: queryRewriteError,
          variantCount: rewriteVariantsUsed.length,
          strictVariantCount: rewriteStrictCount,
          broadVariantCount: rewriteBroadCount,
          canonicalMustIncludeCount: canonicalIntent?.mustIncludeTokens.length ?? 0,
          canonicalMustExcludeCount: canonicalIntent?.mustExcludeTokens.length ?? 0,
        },
        variantCount: allVariants.length,
        phaseCounts,
        proposition: {
          requiredElements: checklist.requiredElements,
          optionalElements: checklist.optionalElements,
          courtHint: checklist.courtHint,
          contradictionTerms: checklist.contradictionTerms.slice(0, 12),
        },
        selectedVariants,
      },
      scheduler: {
        globalBudget: config.globalBudget,
        attemptsUsed: scheduler.carryState.attemptsUsed,
        skippedDuplicates: scheduler.skippedDuplicates,
        blockedCount: scheduler.blockedCount,
        stopReason: scheduler.stopReason,
        blockedReason: scheduler.blockedReason,
        blockedKind: scheduler.blockedKind,
        retryAfterMs: scheduler.retryAfterMs,
        partialDueToLatency,
        elapsedMs,
        adaptiveVariantSchedulerEnabled: ADAPTIVE_VARIANT_SCHEDULER_ENABLED,
        guaranteeTriggered,
        guaranteeAttemptsUsed,
        guaranteeMet,
      },
      retrieval: {
        providerId: retrievalProvider.id,
        providerReason: retrievalSelection.fallbackReason,
        phaseAttempts: attemptsByPhase,
        phaseSuccesses: successesByPhase,
        statusCounts,
        challengeCount,
        rateLimitCount,
        cooldownSkipCount,
        timeoutCount,
        fetchTimeoutMsUsed,
        variantUtility: {
          trackedKeys: variantUtilityEntries.length,
          topKeys: variantUtilityTop,
        },
        staleFallbackUsed,
        staleFallbackSignatureLevel,
        alwaysReturnFallbackUsed: staleFallbackUsed || syntheticFallbackUsed,
        alwaysReturnFallbackType,
        alwaysReturnFallbackReason,
      },
      classification: {
        counts: evaluation.counts,
        strictCaseOnly: config.strictCaseOnly,
        rejectionReasons: evaluation.rejectionReasons,
        exactMatchCount: casesExact.length,
        strictExactCount: casesExactStrict.length,
        provisionalExactCount: casesExactProvisional.length,
        highConfidenceEligibleCount: propositionSplit.highConfidenceEligibleCount,
        strictOnlyHighConfidence: true,
        cacheReplayGuardApplied: false,
        nearMissCount: casesExploratory.length,
        missingElementBreakdown: propositionSplit.missingElementBreakdown,
        coreFailureBreakdown: propositionSplit.coreFailureBreakdown,
        chainMandatoryFailureBreakdown: propositionSplit.chainMandatoryFailureBreakdown,
        requiredElementCoverageAvg: propositionSplit.requiredElementCoverageAvg,
        contradictionRejectCount: propositionSplit.contradictionRejectCount,
        hookGroupCoverageAvg: propositionSplit.hookGroupCoverageAvg,
        chainCoverageAvg: propositionSplit.chainCoverageAvg,
        roleConstraintFailureCount: propositionSplit.roleConstraintFailureCount,
        relationFailureCount: propositionSplit.relationFailureCount,
        polarityMismatchCount: propositionSplit.polarityMismatchCount,
        scoreCalibration: propositionSplit.scoreCalibration,
      },
      verification: {
        attempted: evaluation.verificationSummary.attempted,
        detailFetched: evaluation.verificationSummary.detailFetched,
        detailFetchFailed: evaluation.verificationSummary.detailFetchFailed,
        detailFetchFallbackUsed: evaluation.verificationSummary.detailFetchFallbackUsed,
        detailFetchErrorCounts: evaluation.verificationSummary.detailFetchErrorCounts,
        detailFetchSampleErrors: evaluation.verificationSummary.detailFetchSampleErrors,
        hybridFallbackUsed: evaluation.verificationSummary.hybridFallbackUsed,
        hybridFallbackSuccesses: evaluation.verificationSummary.hybridFallbackSuccesses,
        detailHydrationCoverage: evaluation.verificationSummary.detailHydrationCoverage,
        passedCaseGate: evaluation.verificationSummary.passedCaseGate,
        limit: config.verifyLimit,
        networkFetchAllowed: allowNetworkFetch,
      },
    },
  };

  if (
    ALWAYS_RETURN_V1_ENABLED &&
    STALE_FALLBACK_ENABLED &&
    !staleFallbackUsed &&
    !syntheticFallbackUsed &&
    responseStatus !== "blocked" &&
    (tierCounts.exactStrict + tierCounts.exactProvisional + tierCounts.exploratory > 0)
  ) {
    try {
      await saveFallbackRecallEntry({
        query: input.query,
        actors: intent.actors,
        procedures: intent.procedures,
        statutes: intent.statutes,
        issues: intent.issues,
        domains: intent.domains,
        cases: dedupeByUrl([
          ...casesExactStrict,
          ...casesExactProvisional,
          ...casesExploratory,
        ]),
        tierCounts,
      });
    } catch (error) {
      console.warn(
        `[search:${input.requestId}] fallback_recall_cache_write_failed`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (!input.debugEnabled) {
    return { response };
  }

  return {
    response,
    debug: {
      requestId: input.requestId,
      cleanedQuery: intent.cleanedQuery,
      planner: {
        source: deterministicPlanner.plannerSource,
        modelId: deterministicPlanner.plannerModelId,
        error: deterministicPlanner.plannerError ?? reasonerPass1.telemetry.error ?? reasonerPass2Error,
        reasonerMode: reasonerPass1.telemetry.mode,
        reasonerDegraded: reasonerPass1.telemetry.degraded,
        reasonerAttempted: reasonerHealth.attempted,
        reasonerStatus: reasonerHealth.status,
        reasonerSkipReason: reasonerHealth.skipReason,
        reasonerError: reasonerPass1.telemetry.error,
        reasonerWarnings: reasonerPass1.telemetry.warnings,
        reasonerTimeoutMsUsed: reasonerPass1.telemetry.timeoutMsUsed,
        reasonerLatencyMs: reasonerPass1.telemetry.latencyMs,
      },
      phrases: allVariants.map((variant) => variant.phrase),
      source: scheduler.attempts.map((attempt) => ({
        phrase: attempt.phrase,
        searchQuery: attempt.searchQuery,
        canonicalKey: attempt.canonicalKey,
        variantPriority: attempt.variantPriority,
        utilityScore: attempt.utilityScore,
        caseLikeRatio: attempt.caseLikeRatio,
        statuteLikeRatio: attempt.statuteLikeRatio,
        status: attempt.status,
        ok: attempt.ok,
        phase: attempt.phase,
        parserMode: attempt.parserMode,
        pagesScanned: attempt.pagesScanned,
        pageCaseCounts: attempt.pageCaseCounts,
        nextPageDetected: attempt.nextPageDetected,
        rawParsedCount: attempt.rawParsedCount,
        excludedStatuteCount: attempt.excludedStatuteCount,
        excludedWeakCount: attempt.excludedWeakCount,
        cloudflareDetected: attempt.cloudflareDetected,
        challengeDetected: attempt.challengeDetected,
        cooldownActive: attempt.cooldownActive,
        retryAfterMs: attempt.retryAfterMs,
        blockedType: attempt.blockedType,
        timedOut: attempt.timedOut,
        fetchTimeoutMsUsed: attempt.fetchTimeoutMsUsed,
        parsedCount: attempt.parsedCount,
        htmlPreview: attempt.htmlPreview,
        error: attempt.error,
        variantId: attempt.variantId,
        providerId: attempt.providerId,
      })),
      courtBreakdown: {
        sc: scheduler.candidates.filter((candidate) => candidate.court === "SC").length,
        hc: scheduler.candidates.filter((candidate) => candidate.court === "HC").length,
        unknown: scheduler.candidates.filter((candidate) => candidate.court === "UNKNOWN").length,
      },
      phaseBreakdown: attemptsByPhase,
      diagnostics: {
        challengeCount,
        rateLimitCount,
        timeoutCount,
        noMatchCount,
        successCount,
        blockedState: effectiveBlockedState,
        stopReason: scheduler.stopReason,
        blockedReason: scheduler.blockedReason,
        blockedKind: scheduler.blockedKind,
        retryAfterMs: scheduler.retryAfterMs,
        skippedDuplicates: scheduler.skippedDuplicates,
        alwaysReturnFallbackUsed: staleFallbackUsed || syntheticFallbackUsed,
        alwaysReturnFallbackType,
        alwaysReturnFallbackReason,
        rejectionReasons: evaluation.rejectionReasons,
      },
    },
  };
}
