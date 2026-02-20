import { CaseCandidate } from "@/lib/types";

export type RetrievalProviderId = "indiankanoon_api" | "indiankanoon_html" | "serper";
export type RetrievalSourceTag =
  | "lexical_api"
  | "lexical_html"
  | "web_search"
  | "semantic_vector"
  | "fused";
export type RetrievalQueryMode = "precision" | "context" | "expansion";
export type RetrievalDoctypeProfile =
  | "judgments_sc_hc_tribunal"
  | "supremecourt"
  | "highcourts"
  | "any";

export type RetrievalBlockedType = "local_cooldown" | "cloudflare_challenge" | "rate_limit";

export type RetrievalSearchInput = {
  phrase: string;
  courtScope: "SC" | "HC" | "ANY";
  courtType?: "supremecourt" | "highcourts";
  fromDate?: string;
  toDate?: string;
  sortByMostRecent?: boolean;
  queryMode?: RetrievalQueryMode;
  doctypeProfile?: RetrievalDoctypeProfile;
  titleTerms?: string[];
  citeTerms?: string[];
  authorTerms?: string[];
  benchTerms?: string[];
  categoryExpansions?: string[];
  compiledQuery?: string;
  includeTokens?: string[];
  excludeTokens?: string[];
  providerHints?: {
    serperQuotedTerms?: string[];
    serperCoreTerms?: string[];
    canonicalOrderTerms?: string[];
    excludeTerms?: string[];
    softTerms?: string[];
    notificationTerms?: string[];
  };
  variantPriority?: number;
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
  queryMode?: RetrievalQueryMode;
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
  sourceTag?: RetrievalSourceTag;
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
