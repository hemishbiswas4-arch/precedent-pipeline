import { buildSearchInsights } from "@/lib/insights";
import { classifyCandidates, classificationCounts } from "@/lib/pipeline/classifier";
import { buildIntentProfile } from "@/lib/pipeline/intent";
import { planDeterministicQueryVariants } from "@/lib/pipeline/planner";
import { verifyCandidates } from "@/lib/pipeline/verifier";
import { buildPropositionChecklist, splitByProposition, PropositionChecklist } from "@/lib/proposition-gate";
import { diversifyRankedCases } from "@/lib/ranking-diversity";
import { scoreCases } from "@/lib/scoring";
import { ReasonerPlan } from "@/lib/reasoner-schema";
import { CaseCandidate, NearMissCase, ScoredCase, SearchResponse } from "@/lib/types";

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return fallback;
}

const PROPOSITION_V3_ENABLED = parseBooleanEnv(process.env.PROPOSITION_V3, true);
const PROPOSITION_V5_ENABLED = parseBooleanEnv(process.env.PROPOSITION_V5, true);
const PROPOSITION_V41_ENABLED = parseBooleanEnv(process.env.PROPOSITION_V41, true);
const DEFAULT_VERIFY_LIMIT = Math.max(4, Number(process.env.DEFAULT_VERIFY_LIMIT ?? "8"));

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

function isRelevantCase(item: ScoredCase): boolean {
  return (
    item.score >= 0.18 &&
    (item.verification.issuesMatched > 0 ||
      item.verification.proceduresMatched > 0 ||
      item.verification.anchorsMatched > 0 ||
      (item.matchEvidence?.length ?? 0) > 0)
  );
}

function applyPropositionMode(checklist: PropositionChecklist): PropositionChecklist {
  if (PROPOSITION_V3_ENABLED) {
    if (PROPOSITION_V5_ENABLED) return checklist;
    return { ...checklist, graph: undefined };
  }
  return {
    ...checklist,
    hookGroups: checklist.hookGroups.map((group) => ({ ...group, required: false })),
    relations: [],
    interactionRequired: false,
    graph: PROPOSITION_V5_ENABLED ? checklist.graph : undefined,
  };
}

function sanitizeCandidates(candidates: CaseCandidate[]): CaseCandidate[] {
  const seen = new Set<string>();
  const output: CaseCandidate[] = [];
  for (const item of candidates) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    output.push({
      ...item,
      title: item.title?.slice(0, 500) ?? "",
      snippet: item.snippet?.slice(0, 1800) ?? "",
      courtText: item.courtText?.slice(0, 600),
      author: item.author?.slice(0, 120),
    });
    if (output.length >= 120) break;
  }
  return output;
}

export async function finalizeFromCandidates(input: {
  query: string;
  maxResults: number;
  requestId: string;
  candidates: CaseCandidate[];
  reasonerPlan?: ReasonerPlan;
  executionPath: "client_first" | "server_fallback" | "server_only";
  clientDirectAttempted?: boolean;
  clientDirectSucceeded?: boolean;
  blockedKind?: "local_cooldown" | "cloudflare_challenge" | "rate_limit" | "cors";
  retryAfterMs?: number;
  routingReason: string;
  clientProbe?: string;
  stageTimings?: Record<string, number>;
  debugDiagnostics?: {
    sourceAttempts?: Array<Record<string, unknown>>;
  };
}): Promise<SearchResponse> {
  const startAt = Date.now();
  const intent = buildIntentProfile(input.query);
  const checklist = applyPropositionMode(
    buildPropositionChecklist({
      context: intent.context,
      cleanedQuery: intent.cleanedQuery,
      reasonerPlan: input.reasonerPlan,
    }),
  );

  const deterministicPlanner = await planDeterministicQueryVariants(intent, input.reasonerPlan);
  const sanitized = sanitizeCandidates(input.candidates);
  const classified = classifyCandidates(sanitized);
  const verified = await verifyCandidates(classified, DEFAULT_VERIFY_LIMIT);
  const postVerify = verified.verified;
  const counts = classificationCounts(postVerify);

  const caseCandidates = postVerify
    .filter((item) => item.classification.kind === "case")
    .map((item) => {
      const { classification, ...candidate } = item;
      void classification;
      return candidate;
    });

  const courtFiltered = caseCandidates.filter((candidate) => candidate.court === "SC" || candidate.court === "HC");
  const scoredInput = courtFiltered.length > 0 ? courtFiltered : caseCandidates;
  const scored = scoreCases(input.query, intent.context, scoredInput, { checklist });
  const relevant = scored.filter(isRelevantCase);
  const pool = relevant.length > 0 ? relevant : scored;
  const diversified = diversifyRankedCases(pool, {
    maxPerFingerprint: 1,
    maxPerCourtDay: 1,
  });

  const propositionSplit = splitByProposition(diversified, checklist);
  const casesExactStrict = PROPOSITION_V41_ENABLED
    ? propositionSplit.exactStrict.slice(0, input.maxResults)
    : propositionSplit.exact.slice(0, input.maxResults);
  const casesExactProvisional = PROPOSITION_V41_ENABLED
    ? propositionSplit.exactProvisional.slice(0, input.maxResults)
    : [];
  const casesExact = PROPOSITION_V41_ENABLED
    ? [...casesExactStrict, ...casesExactProvisional].slice(0, input.maxResults)
    : propositionSplit.exact.slice(0, input.maxResults);
  const casesNearMiss: NearMissCase[] = propositionSplit.nearMiss.slice(0, input.maxResults);

  const elapsedMs = Math.max(0, Date.now() - startAt);
  const status: SearchResponse["status"] =
    input.blockedKind && casesExact.length === 0
      ? "blocked"
      : casesExact.length === 0
        ? "no_match"
        : "completed";

  const notes: string[] = [
    "This tool does not bypass anti-bot systems and may return fewer results when blocked or throttled.",
    "Use this as research triage only. Validate every citation manually.",
    "Confidence uses calibrated bands and is not a legal-certainty percentage.",
  ];
  if (status === "blocked") {
    notes.push(
      input.retryAfterMs
        ? `Source access is temporarily throttled. Retry in about ${Math.max(1, Math.ceil(input.retryAfterMs / 1000))}s.`
        : "Source access is temporarily throttled. Retry shortly.",
    );
  }
  if (casesExact.length === 0 && status !== "blocked") {
    notes.push("No court-filtered exact matches found. Refine facts or add legal sections in the query.");
  }
  if (casesNearMiss.length > 0 && casesExact.length === 0) {
    notes.push("Near misses are available separately with missing mandatory proposition elements.");
  }

  return {
    requestId: input.requestId,
    status,
    retryAfterMs: input.retryAfterMs,
    blockedKind:
      input.blockedKind && input.blockedKind !== "cors"
        ? input.blockedKind
        : input.blockedKind === "cors"
          ? "cloudflare_challenge"
          : undefined,
    executionPath: input.executionPath,
    clientDirectAttempted: Boolean(input.clientDirectAttempted),
    clientDirectSucceeded: Boolean(input.clientDirectSucceeded),
    partialRun: false,
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
          ...(input.reasonerPlan?.must_have_terms ?? []),
          ...(input.reasonerPlan?.case_anchors ?? []),
        ],
        20,
      ),
      searchPhrases: uniqueLimit(
        [
          ...deterministicPlanner.keywordPack.searchPhrases,
          ...(input.reasonerPlan?.query_variants_strict ?? []),
          ...(input.reasonerPlan?.query_variants_broad ?? []),
        ],
        28,
      ),
    },
    totalFetched: sanitized.length,
    filteredCount: courtFiltered.length,
    cases: casesExact,
    casesExact,
    casesExactStrict,
    casesExactProvisional,
    casesNearMiss,
    insights: buildSearchInsights({
      context: intent.context,
      cases: casesExact,
      totalFetched: sanitized.length,
      filteredCount: courtFiltered.length,
    }),
    notes,
    pipelineTrace: {
      planner: {
        source: deterministicPlanner.plannerSource,
        modelId: deterministicPlanner.plannerModelId,
        error: deterministicPlanner.plannerError,
        variantCount: deterministicPlanner.variants.length,
        phaseCounts: deterministicPlanner.variants.reduce<Record<string, number>>((acc, variant) => {
          acc[variant.phase] = (acc[variant.phase] ?? 0) + 1;
          return acc;
        }, {}),
        selectedVariants: deterministicPlanner.variants.slice(0, 12).map((variant) => ({
          id: variant.id,
          phase: variant.phase,
          purpose: variant.purpose,
          courtScope: variant.courtScope,
          strictness: variant.strictness,
          phrase: variant.phrase,
        })),
      },
      scheduler: {
        globalBudget: deterministicPlanner.variants.length,
        attemptsUsed: input.debugDiagnostics?.sourceAttempts?.length ?? 0,
        skippedDuplicates: 0,
        blockedCount: input.blockedKind ? 1 : 0,
        stopReason: status === "blocked" ? "blocked" : "completed",
        blockedReason: input.blockedKind,
        blockedKind:
          input.blockedKind === "cors"
            ? "cloudflare_challenge"
            : (input.blockedKind as "local_cooldown" | "cloudflare_challenge" | "rate_limit" | undefined),
        retryAfterMs: input.retryAfterMs,
        partialDueToLatency: false,
        elapsedMs,
      },
      retrieval: {
        phaseAttempts: {},
        phaseSuccesses: {},
        statusCounts: {},
        challengeCount: input.blockedKind === "cloudflare_challenge" ? 1 : 0,
        rateLimitCount: input.blockedKind === "rate_limit" ? 1 : 0,
      },
      classification: {
        counts,
        strictCaseOnly: true,
        rejectionReasons: {},
        exactMatchCount: casesExact.length,
        strictExactCount: casesExactStrict.length,
        provisionalExactCount: casesExactProvisional.length,
        nearMissCount: casesNearMiss.length,
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
        highConfidenceEligibleCount: propositionSplit.highConfidenceEligibleCount,
        strictOnlyHighConfidence: true,
        cacheReplayGuardApplied: false,
        scoreCalibration: propositionSplit.scoreCalibration,
      },
      verification: {
        attempted: verified.summary.attempted,
        detailFetched: verified.summary.detailFetched,
        passedCaseGate: verified.summary.passedCaseGate,
        limit: DEFAULT_VERIFY_LIMIT,
      },
      routing: {
        decision: input.executionPath,
        reason: input.routingReason,
        clientProbe: input.clientProbe,
      },
      timing: {
        stageMs: {
          finalize: elapsedMs,
          ...(input.stageTimings ?? {}),
        },
      },
    },
  };
}
