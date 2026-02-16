import { createHash } from "crypto";
import { sharedCache } from "@/lib/cache/shared-cache";
import { canonicalDocHref, inferCourtLevelFromText, normalizeDocHref } from "@/lib/indiankanoon-parser";
import { CaseCandidate } from "@/lib/types";
import {
  RetrievalProvider,
  RetrievalProviderError,
  RetrievalSearchDebug,
  RetrievalSearchInput,
  RetrievalSearchResult,
} from "@/lib/retrieval/providers/types";

type SerperOrganicResult = {
  title?: string;
  link?: string;
  snippet?: string;
};

type SerperSearchResponse = {
  organic?: SerperOrganicResult[];
};

type CachedSerperPayload = {
  query: string;
  cases: CaseCandidate[];
  rawParsedCount: number;
};

const SERPER_ENDPOINT = "https://google.serper.dev/search";
const SERPER_CACHE_TTL_SEC = Math.min(
  900,
  Math.max(300, Number(process.env.SERPER_CACHE_TTL_SEC ?? "600")),
);
const SERPER_ENABLE_DETAIL_FETCH = (() => {
  const raw = (process.env.SERPER_ENABLE_DETAIL_FETCH ?? "1").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return true;
})();

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.max(500, Math.min(numeric * 1000, 20_000));
  }
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    return Math.max(500, Math.min(asDate - Date.now(), 20_000));
  }
  return undefined;
}

function normalizeQueryTerm(value: string): string {
  return value
    .toLowerCase()
    .replace(/["']/g, " ")
    .replace(/[^a-z0-9\s()/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueTerms(values: string[], limit: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeQueryTerm(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

function quoteTerm(value: string): string {
  const normalized = normalizeQueryTerm(value);
  if (!normalized) return "";
  return `"${normalized}"`;
}

function buildSerperQuery(input: RetrievalSearchInput): string {
  if (input.compiledQuery?.trim()) {
    return input.compiledQuery.replace(/\s+/g, " ").trim();
  }

  const quotedTerms = uniqueTerms(
    [
      ...(input.providerHints?.serperQuotedTerms ?? []),
      ...(input.includeTokens ?? []).filter((token) => token.includes(" ")),
    ],
    4,
  );
  const coreTerms = uniqueTerms(
    [
      input.phrase.trim(),
      ...(input.providerHints?.serperCoreTerms ?? []),
      ...(input.includeTokens ?? []),
    ],
    6,
  );
  const excludeTerms = uniqueTerms(
    [
      ...(input.excludeTokens ?? []),
      ...(input.providerHints?.excludeTerms ?? []),
    ],
    4,
  );

  const terms = [
    "site:indiankanoon.org/doc",
    ...quotedTerms.map(quoteTerm).filter(Boolean),
    ...coreTerms,
    ...excludeTerms.map((term) => `-"${term}"`),
  ];
  if (input.courtScope === "SC") terms.push("supreme court");
  if (input.courtScope === "HC") terms.push("high court");
  return terms.filter((term) => term.length > 0).join(" ").replace(/\s+/g, " ").trim();
}

export function buildSerperQueryForTest(input: RetrievalSearchInput): string {
  return buildSerperQuery(input);
}

function toSerperCacheKey(query: string): string {
  const hash = createHash("sha256").update(query).digest("hex");
  return `serper:v1:${hash}`;
}

function buildDebug(input: {
  query: string;
  status: number;
  ok: boolean;
  parsedCount: number;
  rawParsedCount: number;
  blockedType?: "rate_limit";
  retryAfterMs?: number;
  htmlPreview?: string;
}): RetrievalSearchDebug {
  return {
    searchQuery: input.query,
    status: input.status,
    ok: input.ok,
    parsedCount: input.parsedCount,
    parserMode: "serper_api",
    pagesScanned: 1,
    pageCaseCounts: [input.parsedCount],
    nextPageDetected: false,
    rawParsedCount: input.rawParsedCount,
    excludedStatuteCount: 0,
    excludedWeakCount: Math.max(0, input.rawParsedCount - input.parsedCount),
    cloudflareDetected: false,
    challengeDetected: false,
    retryAfterMs: input.retryAfterMs,
    blockedType: input.blockedType,
    htmlPreview: input.htmlPreview,
    sourceTag: "web_search",
  };
}

async function parseSerperResponse(response: Response): Promise<SerperSearchResponse> {
  try {
    const payload = (await response.json()) as SerperSearchResponse;
    return payload;
  } catch {
    return {};
  }
}

export const serperProvider: RetrievalProvider = {
  id: "serper",
  supportsDetailFetch: SERPER_ENABLE_DETAIL_FETCH,
  async search(input: RetrievalSearchInput): Promise<RetrievalSearchResult> {
    const apiKey = process.env.SERPER_API_KEY?.trim();
    if (!apiKey) {
      throw new RetrievalProviderError("SERPER_API_KEY missing", {
        searchQuery: "",
        status: 500,
        ok: false,
        parsedCount: 0,
        parserMode: "serper_api",
        cloudflareDetected: false,
        challengeDetected: false,
        htmlPreview: "serper_missing_key",
      });
    }

    const searchQuery = buildSerperQuery(input);
    const cacheKey = toSerperCacheKey(searchQuery);
    const cached = await sharedCache.getJson<CachedSerperPayload>(cacheKey);
    if (cached?.cases && cached.query === searchQuery) {
      return {
        cases: cached.cases,
        debug: buildDebug({
          query: searchQuery,
          status: 200,
          ok: true,
          parsedCount: cached.cases.length,
          rawParsedCount: cached.rawParsedCount,
          htmlPreview: "serper_cache_hit",
        }),
      };
    }

    const response = await fetch(SERPER_ENDPOINT, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: searchQuery,
        num: Math.min(20, Math.max(6, input.maxResultsPerPhrase)),
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      const retryAfterMs =
        response.status === 429 ? parseRetryAfterMs(response.headers.get("retry-after")) : undefined;
      const debug = buildDebug({
        query: searchQuery,
        status: response.status,
        ok: false,
        parsedCount: 0,
        rawParsedCount: 0,
        blockedType: response.status === 429 ? "rate_limit" : undefined,
        retryAfterMs,
        htmlPreview: `serper_http_${response.status}`,
      });
      throw new RetrievalProviderError(`Serper returned ${response.status}`, debug);
    }

    const payload = await parseSerperResponse(response);
    const organic = Array.isArray(payload.organic) ? payload.organic : [];
    const seen = new Set<string>();
    const cases: CaseCandidate[] = [];

    for (const item of organic) {
      const normalizedUrl = normalizeDocHref(item.link ?? "");
      const canonicalUrl = canonicalDocHref(item.link ?? "") ?? canonicalDocHref(normalizedUrl ?? "");
      const url = normalizedUrl ?? canonicalUrl;
      if (!url || seen.has(url)) continue;
      if (!/indiankanoon\.org\/(?:doc|docfragment)\//i.test(url)) continue;
      seen.add(url);

      const title = stripHtml(item.title ?? "").slice(0, 400);
      const snippet = stripHtml(item.snippet ?? "").slice(0, 800);
      const inferredCourt = inferCourtLevelFromText(`${title} ${snippet}`);
      const court =
        inferredCourt === "UNKNOWN" && input.courtScope !== "ANY"
          ? input.courtScope
          : inferredCourt;
      cases.push({
        source: "indiankanoon",
        title: title || "Untitled case",
        url,
        snippet,
        court,
        fullDocumentUrl: canonicalUrl ?? url,
      });
    }

    if (cases.length > 0) {
      await sharedCache.setJson(
        cacheKey,
        {
          query: searchQuery,
          cases,
          rawParsedCount: organic.length,
        } satisfies CachedSerperPayload,
        SERPER_CACHE_TTL_SEC,
      );
    }

    return {
      cases,
      debug: buildDebug({
        query: searchQuery,
        status: 200,
        ok: true,
        parsedCount: cases.length,
        rawParsedCount: organic.length,
        htmlPreview: "serper_ok",
      }),
    };
  },
};
