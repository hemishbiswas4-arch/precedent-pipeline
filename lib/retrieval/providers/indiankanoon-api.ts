import { IkApiClientError, IndianKanoonApiClient } from "@/lib/ingestion/ik-api-client";
import { normalizeIkDocuments } from "@/lib/ingestion/normalize";
import { runHybridSearch } from "@/lib/retrieval/hybrid";
import {
  RetrievalProvider,
  RetrievalProviderError,
  RetrievalSearchInput,
  RetrievalSearchResult,
} from "@/lib/retrieval/providers/types";

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseStatusFromError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  const matched = message.match(/(\d{3})/);
  if (matched) return Number(matched[1]);
  return 500;
}

function parseRetryAfterFromError(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const matched = message.match(/retryafter[:=](\d+)/i);
  if (!matched) return undefined;
  const seconds = Number(matched[1]);
  if (!Number.isFinite(seconds)) return undefined;
  return seconds * 1000;
}

function normalizeTerm(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/["'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueTerms(values: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeTerm(value).toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function quoteTerm(value: string): string {
  const normalized = normalizeTerm(value);
  if (!normalized) return "";
  if (normalized.includes(" ")) return `\"${normalized}\"`;
  return normalized;
}

function buildFormInput(input: RetrievalSearchInput): string {
  const base = normalizeTerm(input.compiledQuery?.trim() || input.phrase.trim()).toLowerCase();
  const includeTerms = uniqueTerms(
    [
      ...(input.providerHints?.canonicalOrderTerms ?? []),
      ...(input.providerHints?.serperQuotedTerms ?? []),
      ...(input.includeTokens ?? []),
    ],
    6,
  );
  const excludeTerms = uniqueTerms(
    [
      ...(input.excludeTokens ?? []),
      ...(input.providerHints?.excludeTerms ?? []),
    ],
    5,
  );

  const clauses: string[] = [];
  if (base) clauses.push(base);
  for (const term of includeTerms) {
    const quoted = quoteTerm(term);
    if (quoted && !base.includes(term)) clauses.push(quoted);
  }

  let query = clauses.length > 0 ? clauses.join(" ANDD ") : base;
  for (const term of excludeTerms) {
    const quoted = quoteTerm(term);
    if (!quoted) continue;
    query = query.length > 0 ? `${query} ANDD NOTT ${quoted}` : `NOTT ${quoted}`;
  }

  return query.trim() || base || input.phrase.trim();
}

function resolveDoctypes(input: RetrievalSearchInput): string | undefined {
  if (input.courtType === "supremecourt") return "supremecourt";
  if (input.courtType === "highcourts") return "highcourts";
  if (input.courtScope === "SC") return "supremecourt";
  if (input.courtScope === "HC") return "highcourts";
  return undefined;
}

function extractDocId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.match(/\/(?:doc|docfragment)\/(\d+)\/?/i)?.[1];
}

const DOCFRAGMENT_TOP_N = Math.max(0, Math.min(Number(process.env.IK_API_DOCFRAGMENT_TOP_N ?? "4"), 12));
const DOCFRAGMENT_CONCURRENCY = Math.max(
  1,
  Math.min(Number(process.env.IK_API_DOCFRAGMENT_CONCURRENCY ?? "2"), 6),
);
const DOCFRAGMENT_TIMEOUT_MS = Math.max(
  400,
  Math.min(Number(process.env.IK_API_DOCFRAGMENT_TIMEOUT_MS ?? "1200"), 3000),
);
const DOCFRAGMENT_MIN_SNIPPET_CHARS = Math.max(
  16,
  Math.min(Number(process.env.IK_API_DOCFRAGMENT_MIN_SNIPPET_CHARS ?? "48"), 220),
);
const HYBRID_SHADOW_CAPTURE = parseBoolean(process.env.HYBRID_SHADOW_CAPTURE, true);
const HYBRID_SHADOW_TIMEOUT_MS = Math.max(
  100,
  Math.min(Number(process.env.HYBRID_SHADOW_TIMEOUT_MS ?? "900"), 2500),
);

function classifyDocSource(value: string | undefined): "judgment" | "non_judgment" | "unknown" {
  if (!value) return "unknown";
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "unknown";

  if (
    normalized.includes("supreme") ||
    normalized.includes("high court") ||
    normalized.includes("district court") ||
    normalized.includes("tribunal") ||
    normalized.includes("court")
  ) {
    return "judgment";
  }

  if (
    normalized.includes("act") ||
    normalized.includes("rules") ||
    normalized.includes("regulation") ||
    normalized.includes("notification") ||
    normalized.includes("ordinance") ||
    normalized.includes("constitution") ||
    normalized.includes("law")
  ) {
    return "non_judgment";
  }

  return "unknown";
}

function shouldSkipDocFragment(input: {
  snippet: string;
  docSource: string | undefined;
}): boolean {
  if (normalizeTerm(input.snippet).length < DOCFRAGMENT_MIN_SNIPPET_CHARS) {
    return true;
  }
  return classifyDocSource(input.docSource) === "non_judgment";
}

async function runWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<void>,
): Promise<void> {
  if (values.length === 0) return;
  const cap = Math.max(1, Math.min(concurrency, values.length));
  let cursor = 0;

  const runners = Array.from({ length: cap }, async () => {
    while (cursor < values.length) {
      const current = cursor;
      cursor += 1;
      await worker(values[current], current);
    }
  });
  await Promise.all(runners);
}

async function settleWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean }> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ ok: false; timedOut: true }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
  });

  try {
    const result = await Promise.race([
      promise.then((value) => ({ ok: true as const, value })),
      timeoutPromise,
    ]);
    return result;
  } catch {
    return { ok: false, timedOut: false };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function enrichWithDocFragments(
  client: IndianKanoonApiClient,
  formInput: string,
  cases: RetrievalSearchResult["cases"],
  docSourceByDocId: Map<string, string | undefined>,
): Promise<{
  cases: RetrievalSearchResult["cases"];
  docFragmentHydrationMs: number;
  docFragmentCalls: number;
}> {
  if (DOCFRAGMENT_TOP_N <= 0 || formInput.length < 3 || cases.length === 0) {
    return {
      cases,
      docFragmentHydrationMs: 0,
      docFragmentCalls: 0,
    };
  }

  const out = [...cases];
  const targets: Array<{
    index: number;
    docId: string;
    item: RetrievalSearchResult["cases"][number];
  }> = [];

  for (let i = 0; i < Math.min(DOCFRAGMENT_TOP_N, out.length); i += 1) {
    const item = out[i];
    const docId = extractDocId(item.url) ?? extractDocId(item.fullDocumentUrl);
    if (!docId) continue;
    const docSource = docSourceByDocId.get(docId);
    if (shouldSkipDocFragment({ snippet: item.snippet, docSource })) continue;
    targets.push({ index: i, docId, item });
  }

  if (targets.length === 0) {
    return {
      cases: out,
      docFragmentHydrationMs: 0,
      docFragmentCalls: 0,
    };
  }

  const startedAt = Date.now();
  let docFragmentCalls = 0;
  await runWithConcurrency(targets, DOCFRAGMENT_CONCURRENCY, async (target) => {
    docFragmentCalls += 1;
    try {
      const fragment = await client.fetchDocFragment(target.docId, formInput, {
        timeoutMs: DOCFRAGMENT_TIMEOUT_MS,
      });
      const snippet = normalizeTerm(fragment.snippet ?? fragment.headline ?? "");
      if (snippet.length >= DOCFRAGMENT_MIN_SNIPPET_CHARS) {
        out[target.index] = {
          ...target.item,
          snippet: snippet.slice(0, 900),
        };
      }
    } catch {
      // fail-open: keep lexical snippet
    }
  });

  return {
    cases: out,
    docFragmentHydrationMs: Math.max(0, Date.now() - startedAt),
    docFragmentCalls,
  };
}

function withShadowTelemetry(
  lexicalResult: RetrievalSearchResult,
  shadowResult: RetrievalSearchResult | undefined,
): RetrievalSearchResult {
  const lexicalCount = shadowResult?.debug.lexicalCandidateCount ?? lexicalResult.cases.length;
  const semanticCount = shadowResult?.debug.semanticCandidateCount ?? 0;
  const fusedCount = shadowResult?.debug.fusedCandidateCount ?? lexicalResult.cases.length;

  return {
    ...lexicalResult,
    debug: {
      ...lexicalResult.debug,
      sourceTag: lexicalResult.debug.sourceTag ?? "lexical_api",
      lexicalCandidateCount: lexicalCount,
      semanticCandidateCount: semanticCount,
      fusedCandidateCount: fusedCount,
      rerankApplied: shadowResult?.debug.rerankApplied ?? false,
      fusionLatencyMs: shadowResult?.debug.fusionLatencyMs,
    },
  };
}

const ikApiLexicalProvider: RetrievalProvider = {
  id: "indiankanoon_api",
  supportsDetailFetch: true,
  async search(input: RetrievalSearchInput): Promise<RetrievalSearchResult> {
    let client: IndianKanoonApiClient;
    try {
      client = new IndianKanoonApiClient();
    } catch (error) {
      throw new RetrievalProviderError(error instanceof Error ? error.message : "ik_api_not_configured", {
        searchQuery: input.compiledQuery ?? input.phrase,
        status: 500,
        ok: false,
        parsedCount: 0,
        parserMode: "ik_api",
        cloudflareDetected: false,
        challengeDetected: false,
        htmlPreview: "ik_api_config_missing",
        sourceTag: "lexical_api",
      });
    }

    const formInput = buildFormInput(input);
    const doctypes = resolveDoctypes(input);

    try {
      const response = await client.search({
        formInput,
        pagenum: 0,
        maxpages: Math.max(1, Math.min(input.maxPages, 1000)),
        doctypes,
        fromdate: input.fromDate,
        todate: input.toDate,
        maxcites: Math.max(0, Math.min(Number(process.env.IK_API_MAXCITES ?? "0"), 50)),
      });

      const normalizedDocs = normalizeIkDocuments(response.rows, "ik_api_v1");
      const docSourceByDocId = new Map<string, string | undefined>();
      for (const row of response.rows) {
        const docIdCandidate = row.docId ?? row.documentId ?? row.id ?? row.tid;
        if (docIdCandidate === undefined || docIdCandidate === null) continue;
        const docId = String(docIdCandidate).trim();
        if (!docId || docSourceByDocId.has(docId)) continue;
        const docSource = typeof row.docsource === "string"
          ? row.docsource
          : typeof row.court === "string"
            ? row.court
            : undefined;
        docSourceByDocId.set(docId, docSource);
      }
      const baseCases = normalizedDocs.map((doc) => ({
        source: "indiankanoon" as const,
        title: doc.title,
        url: doc.url,
        snippet: doc.text.slice(0, 900),
        court: doc.court,
        fullDocumentUrl: doc.url,
        retrieval: {
          sourceTags: ["lexical_api" as const],
          sourceVersion: doc.sourceVersion,
        },
      }));
      const enriched = await enrichWithDocFragments(client, formInput, baseCases, docSourceByDocId);

      return {
        cases: enriched.cases,
        debug: {
          searchQuery: formInput,
          status: response.status,
          ok: true,
          parsedCount: enriched.cases.length,
          parserMode: "ik_api",
          pagesScanned: Math.max(1, Math.min(input.maxPages, 1000)),
          pageCaseCounts: [enriched.cases.length],
          nextPageDetected: false,
          rawParsedCount: response.rows.length,
          excludedStatuteCount: 0,
          excludedWeakCount: Math.max(0, response.rows.length - enriched.cases.length),
          cloudflareDetected: false,
          challengeDetected: false,
          retryAfterMs: response.retryAfterMs,
          sourceTag: "lexical_api",
          docFragmentHydrationMs:
            enriched.docFragmentHydrationMs > 0 ? enriched.docFragmentHydrationMs : undefined,
          docFragmentCalls: enriched.docFragmentCalls > 0 ? enriched.docFragmentCalls : undefined,
        },
      };
    } catch (error) {
      const status = error instanceof IkApiClientError ? error.status : parseStatusFromError(error);
      const retryAfterMs =
        error instanceof IkApiClientError
          ? error.retryAfterMs
          : parseRetryAfterFromError(error);
      const message =
        status === 403
          ? "IK API returned 403. Verify IK_API_KEY permissions/account agreement and any source-IP restrictions."
          : error instanceof Error
            ? error.message
            : "ik_api_failed";
      throw new RetrievalProviderError(message, {
        searchQuery: formInput,
        status,
        ok: false,
        parsedCount: 0,
        parserMode: "ik_api",
        cloudflareDetected: false,
        challengeDetected: false,
        retryAfterMs,
        blockedType: status === 429 ? "rate_limit" : undefined,
        htmlPreview: status === 403 ? "ik_api_error_403_auth_or_acl" : `ik_api_error_${status}`,
        sourceTag: "lexical_api",
      });
    }
  },
};

export const indianKanoonApiProvider: RetrievalProvider = {
  id: "indiankanoon_api",
  supportsDetailFetch: true,
  async search(input: RetrievalSearchInput): Promise<RetrievalSearchResult> {
    const hybridEnabled = parseBoolean(process.env.HYBRID_RETRIEVAL_V1, false);
    if (hybridEnabled) {
      try {
        return await runHybridSearch({
          searchInput: input,
          lexicalProvider: ikApiLexicalProvider,
        });
      } catch {
        // Fail-open to lexical-only API search if hybrid path errors.
        return ikApiLexicalProvider.search(input);
      }
    }

    if (!HYBRID_SHADOW_CAPTURE) {
      return ikApiLexicalProvider.search(input);
    }

    const lexicalPromise = ikApiLexicalProvider.search(input);
    const shadowPromise = runHybridSearch({
      searchInput: input,
      lexicalProvider: ikApiLexicalProvider,
    });

    const lexicalResult = await lexicalPromise;
    const shadowSettled = await settleWithTimeout(shadowPromise, HYBRID_SHADOW_TIMEOUT_MS);
    if (!shadowSettled.ok) {
      return withShadowTelemetry(lexicalResult, undefined);
    }
    return withShadowTelemetry(lexicalResult, shadowSettled.value);
  },
};
