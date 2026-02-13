import {
  CaseCandidate,
  CandidateKind,
  ContextProfile,
  KeywordPack,
  NearMissCase,
  PipelineStopReason,
  ScoredCase,
} from "@/lib/types";

export type QueryPhase = "primary" | "fallback" | "rescue" | "micro" | "revolving" | "browse";
export type CourtScope = "SC" | "HC" | "ANY";
export type QueryStrictness = "strict" | "relaxed";

export type QueryProviderHints = {
  compiledQuery?: string;
  serperQuotedTerms?: string[];
  serperCoreTerms?: string[];
  canonicalOrderTerms?: string[];
  excludeTerms?: string[];
};

export type QueryVariant = {
  id: string;
  phrase: string;
  phase: QueryPhase;
  purpose: string;
  courtScope: CourtScope;
  strictness: QueryStrictness;
  tokens: string[];
  canonicalKey?: string;
  priority?: number;
  mustIncludeTokens?: string[];
  mustExcludeTokens?: string[];
  providerHints?: QueryProviderHints;
};

export type IntentProfile = {
  query: string;
  cleanedQuery: string;
  context: ContextProfile;
  domains: string[];
  issues: string[];
  statutes: string[];
  procedures: string[];
  actors: string[];
  anchors: string[];
  courtHint: CourtScope;
  dateWindow: {
    fromDate?: string;
    toDate?: string;
  };
};

export type PlannerOutput = {
  keywordPack: KeywordPack;
  plannerSource: "bedrock" | "fallback";
  plannerModelId?: string;
  plannerError?: string;
  strictGroupCount?: number;
  strictVariantsPreservedAllGroups?: boolean;
  variants: QueryVariant[];
};

export type CandidateClassification = {
  kind: CandidateKind;
  reasons: string[];
};

export type ClassifiedCandidate = CaseCandidate & {
  classification: CandidateClassification;
};

export type RetrievalAttempt = {
  providerId?: string;
  phase: QueryPhase;
  courtScope?: CourtScope;
  variantId: string;
  canonicalKey?: string;
  variantPriority?: number;
  phrase: string;
  searchQuery?: string;
  status: number;
  ok: boolean;
  parsedCount: number;
  utilityScore?: number;
  caseLikeRatio?: number;
  statuteLikeRatio?: number;
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
  htmlPreview?: string;
  error: string | null;
};

export type SchedulerConfig = {
  strictCaseOnly: boolean;
  verifyLimit: number;
  globalBudget: number;
  phaseLimits: Record<QueryPhase, number>;
  blockedThreshold: number;
  minCaseTarget: number;
  requireSupremeCourt: boolean;
  maxElapsedMs: number;
  stopOnCandidateTarget?: boolean;
  fetchTimeoutMs?: number;
  max429Retries?: number;
  maxRetryAfterMs?: number;
};

export type VariantUtilitySnapshot = {
  attempts: number;
  meanUtility: number;
  caseLikeRate: number;
  statuteLikeRate: number;
  challengeRate: number;
  timeoutRate: number;
  lastStatus?: number;
  updatedAtMs: number;
};

export type CandidateProvenance = {
  variantIds: string[];
  canonicalKeys: string[];
  phases: QueryPhase[];
  bestUtility: number;
  strictHits: number;
  relaxedHits: number;
  highPriorityHits: number;
};

export type SchedulerCarryState = {
  startedAtMs: number;
  seenSignatures: string[];
  attemptsUsed: number;
  skippedDuplicates: number;
  blockedCount: number;
  blockedReason?: string;
  blockedKind?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
  retryAfterMs?: number;
  variantUtility?: Record<string, VariantUtilitySnapshot>;
  candidateProvenance?: Record<string, CandidateProvenance>;
  attempts: RetrievalAttempt[];
  candidates: CaseCandidate[];
};

export type SchedulerResult = {
  attempts: RetrievalAttempt[];
  skippedDuplicates: number;
  stopReason: PipelineStopReason;
  blockedCount: number;
  blockedReason?: string;
  blockedKind?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
  retryAfterMs?: number;
  variantUtility?: Record<string, VariantUtilitySnapshot>;
  candidateProvenance?: Record<string, CandidateProvenance>;
  candidates: CaseCandidate[];
  carryState: SchedulerCarryState;
};

export type VerificationSummary = {
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

export type PropositionSplit = {
  exactStrict: ScoredCase[];
  exactProvisional: ScoredCase[];
  exact: ScoredCase[];
  nearMiss: NearMissCase[];
  exactMatchCount: number;
  strictExactCount: number;
  provisionalExactCount: number;
  nearMissCount: number;
  missingElementBreakdown: Record<string, number>;
  coreFailureBreakdown: Record<string, number>;
  requiredElementCoverageAvg: number;
  contradictionRejectCount: number;
  hookGroupCoverageAvg: number;
  chainCoverageAvg: number;
  roleConstraintFailureCount: number;
  chainMandatoryFailureBreakdown: Record<string, number>;
  relationFailureCount: number;
  polarityMismatchCount: number;
  highConfidenceEligibleCount: number;
  scoreCalibration: {
    maxConfidence: number;
    saturationPreventedCount: number;
  };
};
