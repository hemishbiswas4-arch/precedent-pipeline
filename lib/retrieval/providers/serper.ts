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
const SERPER_MAX_RESULTS_PER_REQUEST = 20;
const SERPER_QUERY_V2_ENABLED = (() => {
  const raw = (process.env.SERPER_QUERY_V2 ?? "1").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
})();
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

function clampQueryTerm(value: string, maxWords: number): string {
  const normalized = normalizeQueryTerm(value);
  if (!normalized) return "";
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return tokens.slice(0, Math.max(1, maxWords)).join(" ");
}

function uniqueTerms(values: string[], limit: number, maxWords = 8): string[] {
  if (limit <= 0) return [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = clampQueryTerm(value, maxWords);
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

type SerperQueryRelaxation = "strict" | "balanced" | "broad";

function resolveQueryMode(input: RetrievalSearchInput): "precision" | "context" | "expansion" {
  if (input.queryMode === "precision" || input.queryMode === "expansion") return input.queryMode;
  return "context";
}

function queryLimits(input: {
  queryMode: "precision" | "context" | "expansion";
  relaxation: SerperQueryRelaxation;
}): {
  quoted: number;
  core: number;
  exclude: number;
  maxWords: number;
  siteConstraint: "doc" | "all";
} {
  const { queryMode, relaxation } = input;
  if (relaxation === "broad") {
    return {
      quoted: 0,
      core: queryMode === "expansion" ? 5 : 4,
      exclude: 0,
      maxWords: 5,
      siteConstraint: "all",
    };
  }
  if (queryMode === "precision") {
    return {
      quoted: relaxation === "balanced" ? 2 : 3,
      core: relaxation === "balanced" ? 5 : 6,
      exclude: relaxation === "balanced" ? 1 : 2,
      maxWords: relaxation === "balanced" ? 6 : 8,
      siteConstraint: "doc",
    };
  }
  if (queryMode === "expansion") {
    return {
      quoted: 0,
      core: relaxation === "balanced" ? 5 : 6,
      exclude: 0,
      maxWords: 6,
      siteConstraint: relaxation === "balanced" ? "all" : "doc",
    };
  }
  return {
    quoted: 0,
    core: relaxation === "balanced" ? 5 : 6,
    exclude: 0,
    maxWords: 6,
    siteConstraint: relaxation === "balanced" ? "all" : "doc",
  };
}

function buildSerperQueryV2(
  input: RetrievalSearchInput,
  relaxation: SerperQueryRelaxation,
): string {
  const queryMode = resolveQueryMode(input);
  const limits = queryLimits({ queryMode, relaxation });
  const seedPhrase = input.compiledQuery?.trim() || input.phrase.trim();
  const quotedTerms = uniqueTerms(
    [
      ...(input.providerHints?.serperQuotedTerms ?? []),
      ...(input.includeTokens ?? []).filter((token) => token.includes(" ")),
    ],
    limits.quoted,
    limits.maxWords,
  );
  const coreTerms = uniqueTerms(
    [
      seedPhrase,
      input.phrase.trim(),
      ...(input.providerHints?.serperCoreTerms ?? []),
      ...(input.providerHints?.canonicalOrderTerms ?? []).slice(0, 6),
      ...(input.includeTokens ?? []),
    ],
    limits.core,
    limits.maxWords,
  );
  const excludeTerms = uniqueTerms(
    [
      ...(input.excludeTokens ?? []),
      ...(input.providerHints?.excludeTerms ?? []),
    ],
    limits.exclude,
    4,
  );

  const terms = [
    limits.siteConstraint === "doc" ? "site:indiankanoon.org/doc" : "site:indiankanoon.org",
    ...quotedTerms
      .map((term) => quoteTerm(term))
      .filter((value) => Boolean(value)),
    ...coreTerms,
    ...excludeTerms.map((term) => `-"${term}"`),
  ];
  if (input.courtScope === "SC") terms.push("supreme court");
  if (input.courtScope === "HC") terms.push("high court");
  return terms.filter((term) => term.length > 0).join(" ").replace(/\s+/g, " ").trim();
}

function buildSerperQuery(input: RetrievalSearchInput): string {
  if (!SERPER_QUERY_V2_ENABLED) {
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
  return buildSerperQueryV2(input, "strict");
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
  queryMode: RetrievalSearchInput["queryMode"];
  status: number;
  ok: boolean;
  parsedCount: number;
  rawParsedCount: number;
  pagesScanned?: number;
  pageCaseCounts?: number[];
  blockedType?: "rate_limit";
  retryAfterMs?: number;
  htmlPreview?: string;
}): RetrievalSearchDebug {
  return {
    searchQuery: input.query,
    queryMode: input.queryMode,
    status: input.status,
    ok: input.ok,
    parsedCount: input.parsedCount,
    parserMode: "serper_api",
    pagesScanned: input.pagesScanned ?? 1,
    pageCaseCounts: input.pageCaseCounts ?? [input.parsedCount],
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

function parseOrganicToCases(input: {
  organic: SerperOrganicResult[];
  courtScope: RetrievalSearchInput["courtScope"];
}): CaseCandidate[] {
  const seen = new Set<string>();
  const cases: CaseCandidate[] = [];

  for (const item of input.organic) {
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
      retrieval: {
        sourceTags: ["web_search"],
      },
    });
  }
  return cases;
}

async function executeSerperSearch(input: {
  apiKey: string;
  query: string;
  num: number;
  queryMode?: RetrievalSearchInput["queryMode"];
}): Promise<{ organic: SerperOrganicResult[]; status: number }> {
  const num = Math.max(1, Math.min(SERPER_MAX_RESULTS_PER_REQUEST, Math.floor(input.num)));
  const response = await fetch(SERPER_ENDPOINT, {
    method: "POST",
    headers: {
      "X-API-KEY": input.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: input.query,
      num,
    }),
    cache: "no-store",
  });
  if (!response.ok) {
    const retryAfterMs =
      response.status === 429 ? parseRetryAfterMs(response.headers.get("retry-after")) : undefined;
    const debug = buildDebug({
      query: input.query,
      queryMode: input.queryMode,
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
  return { organic, status: response.status };
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
          queryMode: input.queryMode,
          status: 200,
          ok: true,
          parsedCount: cached.cases.length,
          rawParsedCount: cached.rawParsedCount,
          htmlPreview: "serper_cache_hit",
        }),
      };
    }

    const queryMode = resolveQueryMode(input);
    const pageCaseCounts: number[] = [];
    const rawOrganicBatches: SerperOrganicResult[][] = [];
    const searchQueries: string[] = [searchQuery];

    const primary = await executeSerperSearch({
      apiKey,
      query: searchQuery,
      num: Math.min(24, Math.max(8, input.maxResultsPerPhrase + 4)),
      queryMode: input.queryMode,
    });
    rawOrganicBatches.push(primary.organic);
    const primaryCases = parseOrganicToCases({
      organic: primary.organic,
      courtScope: input.courtScope,
    });
    pageCaseCounts.push(primaryCases.length);

    const shouldRelax =
      SERPER_QUERY_V2_ENABLED &&
      primaryCases.length === 0 &&
      (queryMode === "context" || queryMode === "expansion");
    if (shouldRelax) {
      const relaxedQuery = buildSerperQueryV2(
        input,
        queryMode === "expansion" ? "broad" : "balanced",
      );
      if (relaxedQuery && relaxedQuery !== searchQuery) {
        searchQueries.push(relaxedQuery);
        try {
          const fallback = await executeSerperSearch({
            apiKey,
            query: relaxedQuery,
            num: Math.min(28, Math.max(10, input.maxResultsPerPhrase + 6)),
            queryMode: input.queryMode,
          });
          rawOrganicBatches.push(fallback.organic);
          const fallbackCases = parseOrganicToCases({
            organic: fallback.organic,
            courtScope: input.courtScope,
          });
          pageCaseCounts.push(fallbackCases.length);
        } catch (error) {
          // Keep primary result; fallback broadening is best-effort only.
          pageCaseCounts.push(0);
          if (hasFallbackDebug(error)) {
            // no-op; status is captured in html preview below.
          }
        }
      }
    }

    const mergedOrganic = rawOrganicBatches.flat();
    const cases = parseOrganicToCases({
      organic: mergedOrganic,
      courtScope: input.courtScope,
    });

    if (cases.length > 0) {
      await sharedCache.setJson(
        cacheKey,
        {
          query: searchQuery,
          cases,
          rawParsedCount: mergedOrganic.length,
        } satisfies CachedSerperPayload,
        SERPER_CACHE_TTL_SEC,
      );
    }

    const htmlPreview =
      searchQueries.length > 1
        ? `serper_ok_relaxed:${searchQueries.join(" || ")}`
        : "serper_ok";
    return {
      cases,
      debug: buildDebug({
        query: searchQueries.join(" || "),
        queryMode: input.queryMode,
        status: 200,
        ok: true,
        parsedCount: cases.length,
        rawParsedCount: mergedOrganic.length,
        pagesScanned: searchQueries.length,
        pageCaseCounts,
        htmlPreview,
      }),
    };
  },
};

function hasFallbackDebug(error: unknown): error is { debug: RetrievalSearchDebug } {
  return typeof error === "object" && error !== null && "debug" in error;
}
