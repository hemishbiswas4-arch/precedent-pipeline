export type CourtLevel = "SC" | "HC" | "UNKNOWN";
export type CandidateKind = "case" | "statute" | "noise" | "unknown";
export type PipelineStopReason =
  | "enough_candidates"
  | "budget_exhausted"
  | "blocked"
  | "completed";

export type ConfidenceBand = "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW";

export type SearchInsights = {
  summary: string;
  topSignals: {
    anchors: string[];
    issues: string[];
    procedures: string[];
    statutes: string[];
  };
  quality: {
    averageScore: number;
    verificationCoverage: number;
    totalCases: number;
    scCount: number;
    hcCount: number;
    retrievalEfficiency: number;
  };
};

export type ContextProfile = {
  domains: string[];
  issues: string[];
  statutesOrSections: string[];
  procedures: string[];
  actors: string[];
  anchors: string[];
};

export type KeywordPack = {
  primary: string[];
  legalSignals: string[];
  searchPhrases: string[];
};

export type CaseCandidate = {
  source: "indiankanoon";
  title: string;
  url: string;
  snippet: string;
  court: CourtLevel;
  courtText?: string;
  citesCount?: number;
  citedByCount?: number;
  author?: string;
  fullDocumentUrl?: string;
  detailText?: string;
  evidenceQuality?: {
    hasRelationSentence: boolean;
    hasPolaritySentence: boolean;
    hasHookIntersectionSentence: boolean;
    hasRoleSentence?: boolean;
    hasChainSentence?: boolean;
  };
};

export type ScoredCase = CaseCandidate & {
  score: number;
  rankingScore?: number;
  confidenceScore?: number;
  confidenceBand?: ConfidenceBand;
  exactnessType?: "strict" | "provisional";
  missingCoreElements?: string[];
  missingMandatorySteps?: string[];
  reasons: string[];
  selectionSummary: string;
  matchEvidence?: string[];
  propositionStepEvidence?: string[];
  roleMatch?: {
    actorRoleSatisfied: boolean;
    proceedingRoleSatisfied: boolean;
  };
  verification: {
    anchorsMatched: number;
    issuesMatched: number;
    proceduresMatched: number;
    detailChecked: boolean;
    hasRelationSentence?: boolean;
    hasPolaritySentence?: boolean;
    hasHookIntersectionSentence?: boolean;
    hasRoleSentence?: boolean;
    hasChainSentence?: boolean;
  };
};

export type NearMissCase = ScoredCase & {
  missingElements: string[];
};

export type SearchReasoning = {
  mode: "opus" | "deterministic";
  cacheHit: boolean;
  latencyMs?: number;
  degraded?: boolean;
};

export type SearchResponse = {
  requestId?: string;
  status?: "completed" | "blocked" | "partial" | "no_match";
  retryAfterMs?: number;
  blockedKind?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
  executionPath?: "client_first" | "server_fallback" | "server_only";
  clientDirectAttempted?: boolean;
  clientDirectSucceeded?: boolean;
  partialRun?: boolean;
  query: string;
  context: ContextProfile;
  proposition?: {
    requiredElements: string[];
    optionalElements: string[];
    constraints?: {
      hookGroups: Array<{
        groupId: string;
        label: string;
        required: boolean;
        minMatch: number;
      }>;
      relations: Array<{
        relationId: string;
        type: string;
        leftGroupId: string;
        rightGroupId: string;
        required: boolean;
      }>;
      outcomeConstraint: {
        polarity: string;
        required: boolean;
      };
      interactionRequired: boolean;
    };
  };
  keywordPack: KeywordPack;
  totalFetched: number;
  filteredCount: number;
  cases: ScoredCase[];
  casesExact?: ScoredCase[];
  casesExactStrict?: ScoredCase[];
  casesExactProvisional?: ScoredCase[];
  casesNearMiss?: NearMissCase[];
  reasoning?: SearchReasoning;
  insights?: SearchInsights;
  notes: string[];
  pipelineTrace?: {
    planner: {
      source: "bedrock" | "fallback";
      modelId?: string;
      error?: string;
      traceInvoked?: boolean;
      traceReason?: string;
      traceVariantCount?: number;
      aiInvoked?: boolean;
      aiInvocationReason?: string;
      aiError?: string;
      reasonerSource?: "opus" | "deterministic";
      reasonerCacheHit?: boolean;
      reasonerLatencyMs?: number;
      reasonerTimeoutMsUsed?: number;
      reasonerAdaptiveTimeoutApplied?: boolean;
      reasonerTimeout?: boolean;
      reasonerDegraded?: boolean;
      reasonerError?: string;
      reasonerAttempted?: boolean;
      reasonerStatus?:
        | "ok"
        | "timeout"
        | "circuit_open"
        | "config_error"
        | "rate_limited"
        | "lock_timeout"
        | "semaphore_saturated"
        | "disabled"
        | "error";
      reasonerSkipReason?: string;
      pass1Invoked?: boolean;
      pass2Invoked?: boolean;
      pass2Reason?: string;
      pass2LatencyMs?: number;
      strictGroupsEnforced?: number;
      strictVariantsPreservedAllGroups?: boolean;
      timeoutRecoveryMode?: string;
      extendedDeterministicUsed?: boolean;
      variantCount: number;
      phaseCounts: Record<string, number>;
      proposition?: {
        requiredElements: string[];
        optionalElements: string[];
        courtHint: "SC" | "HC" | "ANY";
        contradictionTerms: string[];
      };
      selectedVariants: Array<{
        id: string;
        phase: string;
        purpose: string;
        courtScope: string;
        strictness: string;
        phrase: string;
      }>;
    };
    scheduler: {
      globalBudget: number;
      attemptsUsed: number;
      skippedDuplicates: number;
      blockedCount: number;
      stopReason: PipelineStopReason;
      blockedReason?: string;
      blockedKind?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
      retryAfterMs?: number;
      partialDueToLatency?: boolean;
      elapsedMs?: number;
    };
    retrieval: {
      phaseAttempts: Record<string, number>;
      phaseSuccesses: Record<string, number>;
      statusCounts: Record<string, number>;
      challengeCount: number;
      rateLimitCount: number;
      cooldownSkipCount?: number;
      timeoutCount?: number;
      fetchTimeoutMsUsed?: number;
    };
      classification: {
        counts: Record<CandidateKind, number>;
        strictCaseOnly: boolean;
        rejectionReasons: Record<string, number>;
        coreFailureBreakdown?: Record<string, number>;
        chainMandatoryFailureBreakdown?: Record<string, number>;
        exactMatchCount?: number;
        strictExactCount?: number;
        provisionalExactCount?: number;
        highConfidenceEligibleCount?: number;
        strictOnlyHighConfidence?: true;
        cacheReplayGuardApplied?: boolean;
        nearMissCount?: number;
        missingElementBreakdown?: Record<string, number>;
        requiredElementCoverageAvg?: number;
        contradictionRejectCount?: number;
        hookGroupCoverageAvg?: number;
        chainCoverageAvg?: number;
        roleConstraintFailureCount?: number;
        relationFailureCount?: number;
        polarityMismatchCount?: number;
        scoreCalibration?: {
          maxConfidence: number;
          saturationPreventedCount: number;
        };
      };
    verification: {
      attempted: number;
      detailFetched: number;
      passedCaseGate: number;
      limit: number;
    };
    routing?: {
      decision: "client_first" | "server_fallback" | "server_only";
      reason: string;
      clientProbe?: string;
    };
    timing?: {
      stageMs: Record<string, number>;
    };
  };
};
