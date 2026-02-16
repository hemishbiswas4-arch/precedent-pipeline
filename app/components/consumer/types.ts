import { SearchResponse } from "@/lib/types";

export type ResultMode = "exact" | "best_available" | "blocked" | "partial" | "empty";

export type BedrockHealthResponse = {
  ok: boolean;
  region: string;
  modelId: string | null;
  latencyMs?: number;
  preview?: string;
  timeoutMs?: number;
  aborted?: boolean;
  errorName?: string;
  httpStatusCode?: number;
  hint?: string;
  error?: string;
};

export type IndianKanoonHealthResponse = {
  ok: boolean;
  baseUrl: string;
  status?: number;
  latencyMs?: number;
  timeoutMs?: number;
  rows?: number;
  found?: number | string;
  query?: string;
  endpoint?: string;
  retryAfterMs?: number;
  detail?: string;
  hint?: string;
  error?: string;
};

export type DebugPayload = {
  requestId: string;
  cleanedQuery?: string;
  planner?: {
    source: "bedrock" | "fallback";
    modelId?: string;
    error?: string;
    reasonerMode?: "opus" | "deterministic";
    reasonerDegraded?: boolean;
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
    reasonerError?: string;
    reasonerWarnings?: string[];
    reasonerTimeoutMsUsed?: number;
    reasonerLatencyMs?: number;
  };
  phrases: string[];
  source: Array<{
    phrase: string;
    searchQuery?: string;
    status: number;
    ok: boolean;
    phase?: string;
    parserMode?: string;
    challengeDetected?: boolean;
    blockedType?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
    parsedCount: number;
    error: string | null;
    htmlPreview?: string;
  }>;
};

export type SessionSummary = {
  totalRuns: number;
  successRate: number;
  avgCasesPerRun: number;
  avgScore: number;
  blockedRuns: number;
};

export type ResearchSummaryStats = {
  scCount: number;
  hcCount: number;
  avgConfidence: number;
  detailCoverage: number;
  retrievalEfficiency: number;
  partialRun: boolean;
  elapsedMs: number;
};

export type SearchStatus = SearchResponse["status"];
