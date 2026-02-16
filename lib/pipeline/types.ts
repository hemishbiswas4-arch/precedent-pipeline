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
export type RetrievalQueryMode = "precision" | "context" | "expansion";
export type RetrievalDoctypeProfile =
  | "judgments_sc_hc_tribunal"
  | "supremecourt"
  | "highcourts"
  | "any";

export type QueryProviderHints = {
  compiledQuery?: string;
  serperQuotedTerms?: string[];
  serperCoreTerms?: string[];
  canonicalOrderTerms?: string[];
  excludeTerms?: string[];
};

export type QueryRetrievalDirectives = {
  queryMode: RetrievalQueryMode;
  doctypeProfile?: RetrievalDoctypeProfile;
  titleTerms?: string[];
  citeTerms?: string[];
  authorTerms?: string[];
  benchTerms?: string[];
  categoryExpansions?: string[];
  applyContradictionExclusions?: boolean;
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
  retrievalDirectives?: QueryRetrievalDirectives;
};

export type RetrievalIntentProfile = {
  actors: string[];
  proceeding: string[];
  hookGroups: Array<{
    groupId: string;
    terms: string[];
    required: boolean;
  }>;
  outcomePolarity:
    | "required"
    | "not_required"
    | "allowed"
    | "refused"
    | "dismissed"
    | "quashed"
    | "unknown";
  citationHints: string[];
  judgeHints: string[];
  dateWindow: {
    fromDate?: string;
    toDate?: string;
  };
  doctypeProfile: RetrievalDoctypeProfile;
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
  retrievalIntent: RetrievalIntentProfile;
  entities: {
    person: string[];
    org: string[];
    statute: string[];
    section: string[];
    case_citation: string[];
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
  sourceLabel?: "lexical_api" | "lexical_html" | "web_search" | "semantic_vector" | "fused";
  queryMode?: RetrievalQueryMode;
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
  lexicalCandidateCount?: number;
  semanticCandidateCount?: number;
  fusedCandidateCount?: number;
  rerankApplied?: boolean;
  fusionLatencyMs?: number;
  docFragmentHydrationMs?: number;
  docFragmentCalls?: number;
  categoryExpansionCount?: number;
  docmetaHydrationMs?: number;
  docmetaCalls?: number;
  docmetaHydrated?: number;
  error: string | null;
};

export type SchedulerConfig = {
  strictCaseOnly: boolean;
  verifyLimit: number;
  globalBudget: number;
  phaseLimits: Record<QueryPhase, number>;
  maxPagesByPhase?: {
    primary: number;
    fallback: number;
    other: number;
  };
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
