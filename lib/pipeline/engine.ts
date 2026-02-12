import { buildSearchInsights } from "@/lib/insights";
import {
  DEFAULT_BLOCKED_THRESHOLD,
  DEFAULT_GLOBAL_BUDGET,
  DEFAULT_VERIFY_LIMIT,
  PHASE_LIMITS,
  PHASE_ORDER,
} from "@/lib/kb/query-templates";
import { runOpusReasoner } from "@/lib/llm-reasoner";
import { classificationCounts, classifyCandidates } from "@/lib/pipeline/classifier";
import { buildIntentProfile } from "@/lib/pipeline/intent";
import {
  buildTraceQueryVariants,
  buildReasonerQueryVariants,
  planDeterministicQueryVariants,
} from "@/lib/pipeline/planner";
import { runRetrievalSchedule } from "@/lib/pipeline/scheduler";
import { QueryVariant, SchedulerConfig, SchedulerResult } from "@/lib/pipeline/types";
import { verifyCandidates } from "@/lib/pipeline/verifier";
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
const IK_FETCH_TIMEOUT_MS = Math.max(1_500, Number(process.env.IK_FETCH_TIMEOUT_MS ?? "3500"));
const IK_MAX_429_RETRIES = Math.max(0, Number(process.env.IK_MAX_429_RETRIES ?? "0"));
const IK_MAX_RETRY_AFTER_MS = Math.max(500, Number(process.env.IK_MAX_RETRY_AFTER_MS ?? "1500"));
const TRACE_EXPANSION_MIN_REMAINING_MS = Math.max(
  1_500,
  Number(process.env.TRACE_EXPANSION_MIN_REMAINING_MS ?? "6000"),
);
const PIPELINE_MAX_ELAPSED_MS = Math.min(
  Math.max(Number(process.env.PIPELINE_MAX_ELAPSED_MS ?? "22000"), 8_000),
  120_000,
);

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return fallback;
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
    passedCaseGate: number;
  };
};

type PhaseRunResult = {
  scheduler: SchedulerResult;
  evaluation: CandidateEvaluation;
  propositionSplit: ReturnType<typeof splitByProposition>;
};

async function evaluateCandidates(input: {
  query: string;
  maxResults: number;
  verifyLimit: number;
  context: ReturnType<typeof buildIntentProfile>["context"];
  checklist: PropositionChecklist;
  candidates: CaseCandidate[];
}): Promise<CandidateEvaluation> {
  const classified = classifyCandidates(input.candidates);
  const verified = await verifyCandidates(classified, input.verifyLimit);
  const postVerify = verified.verified;
  const counts = classificationCounts(postVerify);

  const rejectionReasons = postVerify
    .filter((item) => item.classification.kind !== "case")
    .flatMap((item) => item.classification.reasons)
    .reduce<Record<string, number>>((acc, reason) => {
      acc[reason] = (acc[reason] ?? 0) + 1;
      return acc;
    }, {});

  const caseCandidates = postVerify
    .filter((item) => item.classification.kind === "case")
    .map((item) => {
      const { classification, ...candidate } = item;
      void classification;
      return candidate;
    });

  const courtFiltered = caseCandidates.filter((candidate) => candidate.court === "SC" || candidate.court === "HC");
  const scoredInput = courtFiltered.length > 0 ? courtFiltered : caseCandidates;
  const scored = scoreCases(input.query, input.context, scoredInput, {
    checklist: input.checklist,
  });
  const relevant = scored.filter(isRelevantCase);
  const pool = relevant.length > 0 ? relevant : scored;
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
      passedCaseGate: verified.summary.passedCaseGate,
    },
  };
}

async function runQualityAwarePhases(input: {
  variants: QueryVariant[];
  intent: ReturnType<typeof buildIntentProfile>;
  config: SchedulerConfig;
  carryState?: SchedulerResult["carryState"];
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
    carryState: input.carryState,
  });
  let evaluation = await evaluateCandidates({
    query: input.query,
    maxResults: input.maxResults,
    verifyLimit: input.config.verifyLimit,
    context: input.intent.context,
    checklist: input.checklist,
    candidates: scheduler.candidates,
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
      carryState: scheduler.carryState,
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
        context: input.intent.context,
        checklist: input.checklist,
        candidates: scheduler.candidates,
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
    if (
      (propositionSplit.strictExactCount >= input.strictStopTarget && chainCoverageReady) ||
      (propositionSplit.strictExactCount + qualifiedProvisional >= input.bestEffortStopTarget &&
        !provisionalHasCoreFailures &&
        chainCoverageReady)
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

function mergeVariants<T extends { phase: string; phrase: string }>(variants: T[]): T[] {
  const seen = new Set<string>();
  return variants.filter((variant) => {
    const key = `${variant.phase}|${variant.phrase.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
}): Promise<{
  response: SearchResponse;
  debug?: {
    requestId: string;
    cleanedQuery: string;
    planner: {
      source: "bedrock" | "fallback";
      modelId?: string;
      error?: string;
    };
    phrases: string[];
    source: Array<{
      phrase: string;
      searchQuery?: string;
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
      rejectionReasons: Record<string, number>;
    };
  };
}> {
  const intent = buildIntentProfile(input.query);
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

  let config: SchedulerConfig = {
    strictCaseOnly,
    verifyLimit: effectiveVerifyLimit,
    globalBudget: effectiveGlobalBudget,
    phaseLimits: PHASE_LIMITS,
    blockedThreshold: DEFAULT_BLOCKED_THRESHOLD,
    minCaseTarget,
    requireSupremeCourt,
    maxElapsedMs: PIPELINE_MAX_ELAPSED_MS,
    stopOnCandidateTarget: false,
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
  const deterministicPlanner = await planDeterministicQueryVariants(intent, activeReasonerPlan);
  let pass2Variants: ReturnType<typeof buildReasonerQueryVariants> = [];
  let traceVariantsUsed: ReturnType<typeof buildTraceQueryVariants> = [];

  const initialReasonerVariants = activeReasonerPlan
    ? buildReasonerQueryVariants({ intent, plan: activeReasonerPlan })
    : [];
  const initialVariants = mergeVariants([...initialReasonerVariants, ...deterministicPlanner.variants]);
  let checklist = applyPropositionMode(
    buildPropositionChecklist({
      context: intent.context,
      cleanedQuery: intent.cleanedQuery,
      reasonerPlan: activeReasonerPlan,
    }),
  );
  let phaseRun = await runQualityAwarePhases({
    variants: initialVariants,
    intent,
    config,
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
          carryState: scheduler.carryState,
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
  const shouldRunPass2 =
    Boolean(activeReasonerPlan) &&
    scheduler.stopReason !== "blocked" &&
    remainingBudget >= PASS2_MIN_REMAINING_BUDGET &&
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
      activeReasonerPlan = reasonerPass2.plan;
      checklist = applyPropositionMode(
        buildPropositionChecklist({
          context: intent.context,
          cleanedQuery: intent.cleanedQuery,
          reasonerPlan: activeReasonerPlan,
        }),
      );
      pass2Variants = buildReasonerQueryVariants({
        intent,
        plan: reasonerPass2.plan,
      });
      phaseRun = await runQualityAwarePhases({
        variants: mergeVariants(pass2Variants),
        intent,
        config,
        carryState: scheduler.carryState,
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

  const casesExactStrict = PROPOSITION_V41_ENABLED
    ? propositionSplit.exactStrict.slice(0, input.maxResults)
    : propositionSplit.exact.slice(0, input.maxResults);
  const casesExactProvisional = PROPOSITION_V41_ENABLED
    ? propositionSplit.exactProvisional.slice(0, input.maxResults)
    : [];
  const casesExact = PROPOSITION_V41_ENABLED
    ? [...casesExactStrict, ...casesExactProvisional].slice(0, input.maxResults)
    : propositionSplit.exact.slice(0, input.maxResults);
  const casesNearMiss: NearMissCase[] = PROPOSITION_V41_ENABLED
    ? propositionSplit.nearMiss.slice(0, input.maxResults)
    : propositionSplit.nearMiss.slice(0, input.maxResults);
  const allVariants = mergeVariants([...initialVariants, ...pass2Variants, ...traceVariantsUsed]);
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
  if (extendedDeterministicUsed) {
    notes.push(
      `Reasoner timeout recovery used ${timeoutRecoveryMode} with expanded deterministic budget (+${EXTENDED_DETERMINISTIC_BUDGET_BONUS}).`,
    );
  }

  if (pass2Invoked) {
    if (reasonerPass2Error) {
      notes.push(`Opus pass-2 refinement degraded to pass-1 output (${reasonerPass2Error}).`);
    } else {
      notes.push("Conditional Opus pass-2 refinement executed to tighten proposition matching.");
    }
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
  if (casesExact.length === 0 && casesNearMiss.length > 0) {
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
  const effectiveBlockedState = scheduler.stopReason === "blocked" && successCount === 0;
  const responseStatus: SearchResponse["status"] = effectiveBlockedState
    ? "blocked"
    : partialDueToLatency || (scheduler.stopReason === "blocked" && successCount > 0)
      ? "partial"
      : casesExact.length === 0
        ? "no_match"
        : "completed";

  const response: SearchResponse = {
    requestId: input.requestId,
    status: responseStatus,
    retryAfterMs: scheduler.retryAfterMs,
    blockedKind: scheduler.blockedKind,
    executionPath: "server_only",
    clientDirectAttempted: false,
    clientDirectSucceeded: false,
    partialRun: partialDueToLatency || (scheduler.stopReason === "blocked" && successCount > 0),
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
    reasoning: {
      mode: reasonerPass1.telemetry.mode,
      cacheHit: reasonerPass1.telemetry.cacheHit,
      latencyMs: reasonerPass1.telemetry.latencyMs,
      degraded: reasonerPass1.telemetry.degraded,
    },
    insights: buildSearchInsights({
      context: intent.context,
      cases: casesExact,
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
        pass1Invoked,
        pass2Invoked,
        pass2Reason,
        pass2LatencyMs,
        strictGroupsEnforced: deterministicPlanner.strictGroupCount,
        strictVariantsPreservedAllGroups: deterministicPlanner.strictVariantsPreservedAllGroups,
        timeoutRecoveryMode,
        extendedDeterministicUsed,
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
      },
      retrieval: {
        phaseAttempts: attemptsByPhase,
        phaseSuccesses: successesByPhase,
        statusCounts,
        challengeCount,
        rateLimitCount,
        cooldownSkipCount,
        timeoutCount,
        fetchTimeoutMsUsed,
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
        nearMissCount: propositionSplit.nearMissCount,
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
        passedCaseGate: evaluation.verificationSummary.passedCaseGate,
        limit: config.verifyLimit,
      },
    },
  };

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
      },
      phrases: allVariants.map((variant) => variant.phrase),
      source: scheduler.attempts.map((attempt) => ({
        phrase: attempt.phrase,
        searchQuery: attempt.searchQuery,
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
        rejectionReasons: evaluation.rejectionReasons,
      },
    },
  };
}
