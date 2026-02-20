import { IkApiClientError, IndianKanoonApiClient } from "@/lib/ingestion/ik-api-client";
import { normalizeIkDocuments } from "@/lib/ingestion/normalize";
import { runHybridSearch } from "@/lib/retrieval/hybrid";
import {
  RetrievalProvider,
  RetrievalProviderError,
  RetrievalSearchInput,
  RetrievalSearchResult,
} from "@/lib/retrieval/providers/types";

const IK_API_STRUCTURED_QUERY_V2_ENABLED = parseBoolean(process.env.IK_API_STRUCTURED_QUERY_V2, true);
const IK_CATEGORY_EXPANSION_V1_ENABLED = parseBoolean(process.env.IK_CATEGORY_EXPANSION_V1, true);
const IK_DOCMETA_ENRICH_V1_ENABLED = parseBoolean(process.env.IK_DOCMETA_ENRICH_V1, true);

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

function uniqueTerms(values: string[], limit: number, maxWords = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeTerm(value)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, Math.max(1, maxWords))
      .join(" ");
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

function buildFormInput(
  input: RetrievalSearchInput,
  options?: {
    categoryExpansions?: string[];
  },
): string {
  const base = normalizeTerm(input.compiledQuery?.trim() || input.phrase.trim()).toLowerCase();
  const baseTokenCount = base.split(/\s+/).filter(Boolean).length;
  const includeLimit =
    input.queryMode === "precision"
      ? baseTokenCount >= 8
        ? 3
        : 5
      : 6;
  const includeTerms = uniqueTerms(
    [
      ...(input.providerHints?.canonicalOrderTerms ?? []),
      ...(input.providerHints?.serperQuotedTerms ?? []),
      ...(input.titleTerms ?? []),
      ...(input.citeTerms ?? []),
      ...(input.authorTerms ?? []),
      ...(input.benchTerms ?? []),
      ...(input.includeTokens ?? []),
    ],
    includeLimit,
  );
  const excludeTerms = uniqueTerms(
    [
      ...(input.excludeTokens ?? []),
      ...(input.providerHints?.excludeTerms ?? []),
    ],
    input.queryMode === "precision" ? 3 : 5,
  );
  const expansionTerms = uniqueTerms(
    [
      ...(input.categoryExpansions ?? []),
      ...(options?.categoryExpansions ?? []),
    ],
    4,
  );
  const softTerms = uniqueTerms([...(input.providerHints?.softTerms ?? [])], input.queryMode === "precision" ? 2 : 5);
  const notificationTerms = uniqueTerms(
    [...(input.providerHints?.notificationTerms ?? [])],
    input.queryMode === "precision" ? 2 : 4,
    6,
  );

  if (!IK_API_STRUCTURED_QUERY_V2_ENABLED) {
    const legacyClauses: string[] = [];
    if (base) legacyClauses.push(base);
    for (const term of includeTerms) {
      const quoted = quoteTerm(term);
      if (quoted && !base.includes(term)) legacyClauses.push(quoted);
    }
    let query = legacyClauses.length > 0 ? legacyClauses.join(" ANDD ") : base;
    for (const term of excludeTerms) {
      const quoted = quoteTerm(term);
      if (!quoted) continue;
      query = query.length > 0 ? `${query} ANDD NOTT ${quoted}` : `NOTT ${quoted}`;
    }
    return query.trim() || base || input.phrase.trim();
  }

  const clauses: string[] = [];
  if (base) clauses.push(base);
  for (const term of includeTerms) {
    if (!term || base.includes(term)) continue;
    clauses.push(term);
  }

  let query = clauses.join(" ").replace(/\s+/g, " ").trim();
  const optionalTerms = uniqueTerms(
    [
      ...(input.queryMode === "expansion" ? expansionTerms : []),
      ...(input.queryMode === "precision" ? [] : softTerms),
      ...(input.queryMode === "precision" ? [] : notificationTerms),
    ],
    6,
    8,
  );
  if (optionalTerms.length > 0) {
    const optionalExpr = optionalTerms.map(quoteTerm).filter(Boolean).join(" ORR ");
    if (optionalExpr) {
      query = query.length > 0 ? `${query} ORR ${optionalExpr}` : optionalExpr;
    }
  }

  const shouldApplyNot =
    input.queryMode === "precision" &&
    (input.includeTokens?.length ?? 0) >= 2 &&
    excludeTerms.length > 0;
  if (shouldApplyNot) {
    for (const term of excludeTerms) {
      const quoted = quoteTerm(term);
      if (!quoted) continue;
      query = query.length > 0 ? `${query} ANDD NOTT ${quoted}` : `NOTT ${quoted}`;
    }
  }

  return query.trim() || base || input.phrase.trim();
}

function resolveDoctypes(input: RetrievalSearchInput): string | undefined {
  if (input.doctypeProfile === "judgments_sc_hc_tribunal") return "supremecourt,highcourts,tribunals";
  if (input.doctypeProfile === "supremecourt") return "supremecourt";
  if (input.doctypeProfile === "highcourts") return "highcourts";
  if (input.courtType === "supremecourt") return "supremecourt";
  if (input.courtType === "highcourts") return "highcourts";
  if (input.courtScope === "SC") return "supremecourt";
  if (input.courtScope === "HC") return "highcourts";
  return "supremecourt,highcourts,tribunals";
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
const DOCMETA_TOP_N = Math.max(0, Math.min(Number(process.env.IK_API_DOCMETA_TOP_N ?? "4"), 12));
const DOCMETA_CONCURRENCY = Math.max(
  1,
  Math.min(Number(process.env.IK_API_DOCMETA_CONCURRENCY ?? "2"), 6),
);
const DOCMETA_TIMEOUT_MS = Math.max(
  400,
  Math.min(Number(process.env.IK_API_DOCMETA_TIMEOUT_MS ?? "1200"), 3500),
);
const HYBRID_SHADOW_CAPTURE = parseBoolean(process.env.HYBRID_SHADOW_CAPTURE, true);
const HYBRID_SHADOW_TIMEOUT_MS = Math.max(
  100,
  Math.min(Number(process.env.HYBRID_SHADOW_TIMEOUT_MS ?? "900"), 2500),
);

function parseCategoryTerms(value: unknown): string[] {
  const output: string[] = [];
  const pushValue = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const normalized = normalizeTerm(raw).toLowerCase();
    if (!normalized || output.includes(normalized)) return;
    output.push(normalized);
  };

  if (Array.isArray(value)) {
    for (const row of value) {
      if (typeof row === "string") {
        pushValue(row);
        continue;
      }
      if (row && typeof row === "object") {
        const payload = row as Record<string, unknown>;
        pushValue(payload.name);
        pushValue(payload.label);
        pushValue(payload.category);
      }
    }
  } else if (value && typeof value === "object") {
    const payload = value as Record<string, unknown>;
    for (const entry of Object.values(payload)) {
      if (Array.isArray(entry)) {
        for (const item of entry) pushValue(item);
      } else {
        pushValue(entry);
      }
    }
  }

  return output.slice(0, 6);
}

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

function isStatutoryTitleLike(title: string): boolean {
  const normalized = normalizeTerm(title).toLowerCase();
  if (!normalized) return false;
  if (/\b v(?:s\.?|\.?) \b/.test(normalized)) return false;
  return (
    /\bact,\s*\d{4}\b/.test(normalized) ||
    /\brules,\s*\d{4}\b/.test(normalized) ||
    /\bcode,\s*\d{4}\b/.test(normalized) ||
    /\bconstitution of india\b/.test(normalized) ||
    /\bregulation\b/.test(normalized)
  );
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
  queryMode: RetrievalSearchInput["queryMode"],
  cases: RetrievalSearchResult["cases"],
  docSourceByDocId: Map<string, string | undefined>,
): Promise<{
  cases: RetrievalSearchResult["cases"];
  docFragmentHydrationMs: number;
  docFragmentCalls: number;
}> {
  const effectiveTopN =
    queryMode === "precision"
      ? Math.max(DOCFRAGMENT_TOP_N, 6)
      : queryMode === "context"
        ? Math.max(DOCFRAGMENT_TOP_N, 4)
        : DOCFRAGMENT_TOP_N;
  if (effectiveTopN <= 0 || formInput.length < 3 || cases.length === 0) {
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

  for (let i = 0; i < Math.min(effectiveTopN, out.length); i += 1) {
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

async function enrichWithDocMeta(
  client: IndianKanoonApiClient,
  queryMode: RetrievalSearchInput["queryMode"],
  cases: RetrievalSearchResult["cases"],
): Promise<{
  cases: RetrievalSearchResult["cases"];
  docmetaHydrationMs: number;
  docmetaCalls: number;
  docmetaHydrated: number;
}> {
  if (!IK_DOCMETA_ENRICH_V1_ENABLED || DOCMETA_TOP_N <= 0 || cases.length === 0) {
    return {
      cases,
      docmetaHydrationMs: 0,
      docmetaCalls: 0,
      docmetaHydrated: 0,
    };
  }

  const effectiveTopN = queryMode === "precision" ? Math.max(DOCMETA_TOP_N, 6) : DOCMETA_TOP_N;
  const out = [...cases];
  const targets: Array<{ index: number; docId: string; item: RetrievalSearchResult["cases"][number] }> = [];
  for (let i = 0; i < Math.min(effectiveTopN, out.length); i += 1) {
    const item = out[i];
    const docId = extractDocId(item.url) ?? extractDocId(item.fullDocumentUrl);
    if (!docId) continue;
    targets.push({ index: i, docId, item });
  }
  if (targets.length === 0) {
    return {
      cases: out,
      docmetaHydrationMs: 0,
      docmetaCalls: 0,
      docmetaHydrated: 0,
    };
  }

  const startedAt = Date.now();
  let docmetaCalls = 0;
  let docmetaHydrated = 0;
  await runWithConcurrency(targets, DOCMETA_CONCURRENCY, async (target) => {
    docmetaCalls += 1;
    const metaSettled = await settleWithTimeout(client.fetchDocMeta(target.docId), DOCMETA_TIMEOUT_MS);
    if (!metaSettled.ok) return;
    const meta = metaSettled.value;
    const citesCount =
      typeof meta.numcites === "number"
        ? meta.numcites
        : Array.isArray(meta.citations)
          ? meta.citations.length
          : target.item.citesCount;
    const citedByCount =
      typeof meta.numcitedby === "number"
        ? meta.numcitedby
        : Array.isArray(meta.equivalentCitations)
          ? meta.equivalentCitations.length
          : target.item.citedByCount;
    const author = normalizeTerm(meta.author ?? "");
    const bench = normalizeTerm(meta.bench ?? "");

    out[target.index] = {
      ...target.item,
      author: author || target.item.author,
      bench: bench || target.item.bench,
      citesCount,
      citedByCount,
    };
    docmetaHydrated += 1;
  });

  return {
    cases: out,
    docmetaHydrationMs: Math.max(0, Date.now() - startedAt),
    docmetaCalls,
    docmetaHydrated,
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
      queryMode: lexicalResult.debug.queryMode ?? shadowResult?.debug.queryMode,
      categoryExpansionCount:
        lexicalResult.debug.categoryExpansionCount ?? shadowResult?.debug.categoryExpansionCount,
      docmetaHydrationMs: lexicalResult.debug.docmetaHydrationMs,
      docmetaCalls: lexicalResult.debug.docmetaCalls,
      docmetaHydrated: lexicalResult.debug.docmetaHydrated,
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

    const queryMode = input.queryMode ?? "context";
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
        title: input.titleTerms?.slice(0, 2).join(" "),
        cite: input.citeTerms?.[0],
        author: input.authorTerms?.[0],
        bench: input.benchTerms?.[0],
        maxcites: Math.max(0, Math.min(Number(process.env.IK_API_MAXCITES ?? "0"), 50)),
      });
      let mergedRows = [...response.rows];
      let categoryExpansionCount = 0;
      const discoveredCategoryTerms = parseCategoryTerms(response.categories);
      const categoryTerms = uniqueTerms(
        [
          ...(input.categoryExpansions ?? []),
          ...discoveredCategoryTerms,
        ],
        4,
      );
      const shouldExpandByCategory =
        IK_CATEGORY_EXPANSION_V1_ENABLED &&
        queryMode !== "precision" &&
        categoryTerms.length > 0 &&
        response.rows.length < Math.max(8, input.maxResultsPerPhrase);
      if (shouldExpandByCategory) {
        const expansionFormInput = buildFormInput(
          {
            ...input,
            queryMode: "expansion",
            categoryExpansions: categoryTerms,
          },
          {
            categoryExpansions: categoryTerms,
          },
        );
        if (expansionFormInput && expansionFormInput !== formInput) {
          const expansionResponse = await client.search({
            formInput: expansionFormInput,
            pagenum: 0,
            maxpages: Math.max(1, Math.min(input.maxPages, 1000)),
            doctypes,
            fromdate: input.fromDate,
            todate: input.toDate,
            title: input.titleTerms?.slice(0, 2).join(" "),
            cite: input.citeTerms?.[0],
            author: input.authorTerms?.[0],
            bench: input.benchTerms?.[0],
            maxcites: Math.max(0, Math.min(Number(process.env.IK_API_MAXCITES ?? "0"), 50)),
          });
          const dedupedByDoc = new Map<string, (typeof mergedRows)[number]>();
          for (const row of [...mergedRows, ...expansionResponse.rows]) {
            const key = String(row.docId ?? row.documentId ?? row.id ?? row.tid ?? row.url ?? "").trim();
            if (!key) continue;
            if (!dedupedByDoc.has(key)) dedupedByDoc.set(key, row);
          }
          mergedRows = Array.from(dedupedByDoc.values());
          categoryExpansionCount = categoryTerms.length;
        }
      }

      const normalizedDocs = normalizeIkDocuments(mergedRows, "ik_api_v1");
      const docSourceByDocId = new Map<string, string | undefined>();
      const rowMetaByDocId = new Map<
        string,
        {
          author?: string;
          bench?: string;
          numcites?: number;
          numcitedby?: number;
        }
      >();
      for (const row of mergedRows) {
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
        rowMetaByDocId.set(docId, {
          author: typeof row.author === "string" ? row.author : undefined,
          bench: typeof row.bench === "string" ? row.bench : undefined,
          numcites: typeof row.numcites === "number" ? row.numcites : undefined,
          numcitedby: typeof row.numcitedby === "number" ? row.numcitedby : undefined,
        });
      }
      const baseCases = normalizedDocs.map((doc) => ({
        ...(rowMetaByDocId.get(doc.docId) ?? {}),
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
      const judgmentFocusedCases = baseCases.filter((candidate) => {
        const docId = extractDocId(candidate.url) ?? extractDocId(candidate.fullDocumentUrl);
        const docSource = docId ? docSourceByDocId.get(docId) : undefined;
        if (classifyDocSource(docSource) === "non_judgment") return false;
        if (isStatutoryTitleLike(candidate.title)) return false;
        return true;
      });
      const lexicalCases = judgmentFocusedCases.length > 0 ? judgmentFocusedCases : baseCases;
      const enriched = await enrichWithDocFragments(
        client,
        formInput,
        queryMode,
        lexicalCases,
        docSourceByDocId,
      );
      const docmetaEnriched = await enrichWithDocMeta(client, queryMode, enriched.cases);

      return {
        cases: docmetaEnriched.cases,
        debug: {
          searchQuery: formInput,
          queryMode,
          status: response.status,
          ok: true,
          parsedCount: docmetaEnriched.cases.length,
          parserMode: "ik_api",
          pagesScanned: Math.max(1, Math.min(input.maxPages, 1000)),
          pageCaseCounts: [docmetaEnriched.cases.length],
          nextPageDetected: false,
          rawParsedCount: mergedRows.length,
          excludedStatuteCount: 0,
          excludedWeakCount: Math.max(0, mergedRows.length - docmetaEnriched.cases.length),
          cloudflareDetected: false,
          challengeDetected: false,
          retryAfterMs: response.retryAfterMs,
          sourceTag: "lexical_api",
          docFragmentHydrationMs:
            enriched.docFragmentHydrationMs > 0 ? enriched.docFragmentHydrationMs : undefined,
          docFragmentCalls: enriched.docFragmentCalls > 0 ? enriched.docFragmentCalls : undefined,
          categoryExpansionCount: categoryExpansionCount > 0 ? categoryExpansionCount : undefined,
          docmetaHydrationMs:
            docmetaEnriched.docmetaHydrationMs > 0 ? docmetaEnriched.docmetaHydrationMs : undefined,
          docmetaCalls: docmetaEnriched.docmetaCalls > 0 ? docmetaEnriched.docmetaCalls : undefined,
          docmetaHydrated:
            docmetaEnriched.docmetaHydrated > 0 ? docmetaEnriched.docmetaHydrated : undefined,
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
        queryMode,
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
    const hybridEnabled = parseBoolean(
      process.env.HYBRID_RETRIEVAL_V2,
      parseBoolean(process.env.HYBRID_RETRIEVAL_V1, true),
    );
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

export const ikApiProviderTestUtils = {
  buildFormInput,
  resolveDoctypes,
  parseCategoryTerms,
};
