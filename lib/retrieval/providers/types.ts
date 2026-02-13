import { CaseCandidate } from "@/lib/types";

export type RetrievalProviderId = "indiankanoon_html" | "serper";

export type RetrievalBlockedType = "local_cooldown" | "cloudflare_challenge" | "rate_limit";

export type RetrievalSearchInput = {
  phrase: string;
  courtScope: "SC" | "HC" | "ANY";
  courtType?: "supremecourt" | "highcourts";
  fromDate?: string;
  toDate?: string;
  sortByMostRecent?: boolean;
  maxResultsPerPhrase: number;
  maxPages: number;
  crawlMaxElapsedMs: number;
  fetchTimeoutMs: number;
  max429Retries: number;
  maxRetryAfterMs?: number;
  cooldownScope?: string;
};

export type RetrievalSearchDebug = {
  searchQuery: string;
  status: number;
  ok: boolean;
  parsedCount: number;
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
  blockedType?: RetrievalBlockedType;
  timedOut?: boolean;
  fetchTimeoutMsUsed?: number;
  htmlPreview?: string;
};

export type RetrievalSearchResult = {
  cases: CaseCandidate[];
  debug: RetrievalSearchDebug;
};

export interface RetrievalProvider {
  id: RetrievalProviderId;
  supportsDetailFetch: boolean;
  search(input: RetrievalSearchInput): Promise<RetrievalSearchResult>;
}

export class RetrievalProviderError extends Error {
  readonly debug: RetrievalSearchDebug;

  constructor(message: string, debug: RetrievalSearchDebug) {
    super(message);
    this.name = "RetrievalProviderError";
    this.debug = debug;
  }
}

export function hasRetrievalDebug(error: unknown): error is { debug: RetrievalSearchDebug } {
  return typeof error === "object" && error !== null && "debug" in error;
}
