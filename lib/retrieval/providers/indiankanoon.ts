import { IndianKanoonFetchError, searchIndianKanoon } from "@/lib/source-indiankanoon";
import {
  RetrievalProvider,
  RetrievalProviderError,
  RetrievalSearchInput,
  RetrievalSearchResult,
} from "@/lib/retrieval/providers/types";

export const indianKanoonHtmlProvider: RetrievalProvider = {
  id: "indiankanoon_html",
  supportsDetailFetch: true,
  async search(input: RetrievalSearchInput): Promise<RetrievalSearchResult> {
    try {
      const result = await searchIndianKanoon(input.phrase, {
        maxResultsPerPhrase: input.maxResultsPerPhrase,
        maxPages: input.maxPages,
        courtHint:
          input.courtScope === "SC"
            ? "SC"
            : input.courtScope === "HC"
              ? "HC"
              : "UNKNOWN",
        courtType: input.courtType,
        fromDate: input.fromDate,
        toDate: input.toDate,
        sortByMostRecent: input.sortByMostRecent,
        crawlMaxElapsedMs: input.crawlMaxElapsedMs,
        fetchTimeoutMs: input.fetchTimeoutMs,
        max429Retries: input.max429Retries,
        maxRetryAfterMs: input.maxRetryAfterMs,
        cooldownScope: input.cooldownScope,
      });

      return {
        cases: result.cases,
        debug: {
          searchQuery: result.debug.searchQuery,
          status: result.debug.status,
          ok: result.debug.ok,
          parsedCount: result.debug.parsedCount,
          parserMode: result.debug.parserMode,
          pagesScanned: result.debug.pagesScanned,
          pageCaseCounts: result.debug.pageCaseCounts,
          nextPageDetected: result.debug.nextPageDetected,
          rawParsedCount: result.debug.rawParsedCount,
          excludedStatuteCount: result.debug.excludedStatuteCount,
          excludedWeakCount: result.debug.excludedWeakCount,
          cloudflareDetected: result.debug.cloudflareDetected,
          challengeDetected: result.debug.challengeDetected,
          cooldownActive: result.debug.cooldownActive,
          retryAfterMs: result.debug.retryAfterMs,
          blockedType: result.debug.blockedType,
          timedOut: result.debug.timedOut,
          fetchTimeoutMsUsed: result.debug.fetchTimeoutMsUsed,
          htmlPreview: result.debug.htmlPreview,
        },
      };
    } catch (error) {
      if (error instanceof IndianKanoonFetchError) {
        throw new RetrievalProviderError(error.message, {
          searchQuery: error.debug.searchQuery,
          status: error.debug.status,
          ok: error.debug.ok,
          parsedCount: error.debug.parsedCount,
          parserMode: error.debug.parserMode,
          pagesScanned: error.debug.pagesScanned,
          pageCaseCounts: error.debug.pageCaseCounts,
          nextPageDetected: error.debug.nextPageDetected,
          rawParsedCount: error.debug.rawParsedCount,
          excludedStatuteCount: error.debug.excludedStatuteCount,
          excludedWeakCount: error.debug.excludedWeakCount,
          cloudflareDetected: error.debug.cloudflareDetected,
          challengeDetected: error.debug.challengeDetected,
          cooldownActive: error.debug.cooldownActive,
          retryAfterMs: error.debug.retryAfterMs,
          blockedType: error.debug.blockedType,
          timedOut: error.debug.timedOut,
          fetchTimeoutMsUsed: error.debug.fetchTimeoutMsUsed,
          htmlPreview: error.debug.htmlPreview,
        });
      }
      throw error;
    }
  },
};
