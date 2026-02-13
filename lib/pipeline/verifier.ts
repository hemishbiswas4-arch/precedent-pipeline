import {
  fetchIndianKanoonCaseDetail,
  resolveIndianKanoonDetailUrlByHint,
} from "@/lib/source-indiankanoon";
import { detailArtifactToText } from "@/lib/indiankanoon-detail-parser";
import { canonicalDocHref, inferCourtLevelFromText } from "@/lib/indiankanoon-parser";
import { ClassifiedCandidate, VerificationSummary } from "@/lib/pipeline/types";
import { classifyCandidate } from "@/lib/pipeline/classifier";
import { CourtLevel, DetailHydrationErrorCode } from "@/lib/types";

const VERIFY_CONCURRENCY = Math.max(1, Math.min(Number(process.env.VERIFY_CONCURRENCY ?? "4"), 6));
const VERIFY_DETAIL_TIMEOUT_MS = Math.max(
  1_800,
  Math.min(Number(process.env.VERIFY_DETAIL_TIMEOUT_MS ?? "2200"), 8_000),
);
const VERIFY_DETAIL_MAX_429_RETRIES = Math.max(
  0,
  Math.min(Number(process.env.VERIFY_DETAIL_MAX_429_RETRIES ?? "1"), 2),
);
const VERIFY_DETAIL_MAX_RETRY_AFTER_MS = Math.max(
  800,
  Math.min(Number(process.env.VERIFY_DETAIL_MAX_RETRY_AFTER_MS ?? "2500"), 5_000),
);
const VERIFY_DETAIL_CACHE_TTL_MS = Math.max(
  60_000,
  Math.min(Number(process.env.VERIFY_DETAIL_CACHE_TTL_MS ?? "300000"), 1_800_000),
);
const VERIFY_DETAIL_TRANSIENT_RETRIES = Math.max(
  0,
  Math.min(Number(process.env.VERIFY_DETAIL_TRANSIENT_RETRIES ?? "1"), 2),
);
const VERIFY_DETAIL_TRANSIENT_RETRY_BACKOFF_MS = Math.max(
  120,
  Math.min(Number(process.env.VERIFY_DETAIL_TRANSIENT_RETRY_BACKOFF_MS ?? "260"), 1_200),
);
const DETAIL_HYBRID_FALLBACK_ENABLED = (process.env.DETAIL_HYBRID_FALLBACK_ENABLED ?? "1") !== "0";
const DETAIL_HYBRID_FALLBACK_TOP_N = Math.max(
  1,
  Math.min(Number(process.env.DETAIL_HYBRID_FALLBACK_TOP_N ?? "8"), 16),
);
const DETAIL_FETCH_SAMPLE_ERROR_LIMIT = Math.max(
  2,
  Math.min(Number(process.env.DETAIL_FETCH_SAMPLE_ERROR_LIMIT ?? "8"), 20),
);
const DETAIL_SERPER_SNIPPET_FALLBACK_ENABLED =
  (process.env.DETAIL_SERPER_SNIPPET_FALLBACK_ENABLED ?? "1") !== "0";
const DETAIL_SERPER_SNIPPET_FALLBACK_TOP_N = Math.max(
  1,
  Math.min(Number(process.env.DETAIL_SERPER_SNIPPET_FALLBACK_TOP_N ?? "8"), 16),
);
const DETAIL_SERPER_SNIPPET_MIN_SNIPPETS = Math.max(
  1,
  Math.min(Number(process.env.DETAIL_SERPER_SNIPPET_MIN_SNIPPETS ?? "2"), 6),
);
const SERPER_ENDPOINT = "https://google.serper.dev/search";

type CachedDetail = {
  title: string;
  court: CourtLevel;
  detailText?: string;
  detailArtifact?: {
    title?: string;
    courtText?: string;
    court?: CourtLevel;
    equivalentCitations?: string;
    author?: string;
    bench?: string;
    citesCount?: number;
    citedByCount?: number;
    evidenceWindows: string[];
    bodyExcerpt: string[];
  };
  evidenceQuality?: {
    hasRelationSentence: boolean;
    hasPolaritySentence: boolean;
    hasHookIntersectionSentence: boolean;
    hasRoleSentence?: boolean;
    hasChainSentence?: boolean;
  };
  fetchedAt: number;
  finalUrl?: string;
};

type CandidateFetchError = {
  code: DetailHydrationErrorCode;
  message: string;
  url?: string;
};

type CachedDetailFailure = {
  errorCode: DetailHydrationErrorCode;
  fetchedAt: number;
};

const detailCacheByUrl = new Map<string, CachedDetail>();
const detailCacheByDocId = new Map<string, CachedDetail>();
const detailFailureCacheByUrl = new Map<string, CachedDetailFailure>();
const detailFailureCacheByDocId = new Map<string, CachedDetailFailure>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractDocIdFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/\/(?:doc|docfragment)\/(\d+)\/?/i);
  return match?.[1];
}

function detailFetchUrls(candidate: ClassifiedCandidate): string[] {
  const docId =
    extractDocIdFromUrl(candidate.url) ??
    extractDocIdFromUrl(candidate.fullDocumentUrl);
  const ordered = [
    candidate.url,
    candidate.fullDocumentUrl,
    canonicalDocHref(candidate.url),
    canonicalDocHref(candidate.fullDocumentUrl ?? ""),
    docId ? `https://indiankanoon.org/doc/${docId}/` : undefined,
    docId ? `https://indiankanoon.org/docfragment/${docId}/` : undefined,
  ];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const value of ordered) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    urls.push(value);
  }
  return urls;
}

function isPseudoTitle(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return /^(search|full document|similar judgments?)$/i.test(value.trim());
}

function isLikelySearchPageDetail(detailText: string): boolean {
  const lower = detailText.toLowerCase();
  return (
    lower.includes("search engine for indian law") ||
    lower.includes("skip to main content indian kanoon") ||
    lower.includes("no matching results")
  );
}

function hasUsableDetail(
  detailText: string,
  artifact: Awaited<ReturnType<typeof fetchIndianKanoonCaseDetail>>,
): boolean {
  if (isLikelySearchPageDetail(detailText)) {
    return false;
  }
  if ((artifact.evidenceWindows?.length ?? 0) > 0) {
    return true;
  }
  return (artifact.bodyExcerpt?.length ?? 0) > 0;
}

function detectEvidenceQuality(detailText: string | undefined): {
  hasRelationSentence: boolean;
  hasPolaritySentence: boolean;
  hasHookIntersectionSentence: boolean;
  hasRoleSentence: boolean;
  hasChainSentence: boolean;
} | undefined {
  if (!detailText) return undefined;
  const normalized = detailText.toLowerCase();
  const sentences = normalized.split(/[\n.!?]+/).map((line) => line.trim()).filter((line) => line.length > 30);
  if (sentences.length === 0) return undefined;

  const relationCues = /(read with|vis[-\s]?a[-\s]?vis|interplay|interaction|requires under|applies to)/;
  const polarityCues =
    /(required|not required|mandatory|necessary|refused|dismissed|rejected|not condoned|time barred|allowed|quashed)/;
  const hookCues = /(section\s*\d+[a-z]?(?:\([0-9a-z]+\))?|crpc|ipc|cpc|prevention of corruption act|pc act|limitation act)/;
  const roleCues =
    /(appellant|respondent|petitioner|accused|state of|government|prosecution|filed appeal|preferred appeal)/;
  const chainCues =
    /(condonation of delay|delay condonation|application for condonation|not condoned|time barred|dismissed as barred)/;

  let hasRelationSentence = false;
  let hasPolaritySentence = false;
  let hasHookIntersectionSentence = false;
  let hasRoleSentence = false;
  let hasChainSentence = false;

  for (const sentence of sentences.slice(0, 160)) {
    const relation = relationCues.test(sentence);
    const polarity = polarityCues.test(sentence);
    const role = roleCues.test(sentence);
    const chain = chainCues.test(sentence);
    const hooks = sentence.match(new RegExp(hookCues, "g")) ?? [];
    const uniqueHooks = new Set(hooks.map((entry) => entry.replace(/\s+/g, " ").trim()));
    if (relation) hasRelationSentence = true;
    if (polarity) hasPolaritySentence = true;
    if (role) hasRoleSentence = true;
    if (chain && (polarity || /appeal/.test(sentence))) hasChainSentence = true;
    if (uniqueHooks.size >= 2 && (relation || polarity)) hasHookIntersectionSentence = true;
    if (hasRelationSentence && hasPolaritySentence && hasHookIntersectionSentence && hasRoleSentence && hasChainSentence)
      break;
  }

  return {
    hasRelationSentence,
    hasPolaritySentence,
    hasHookIntersectionSentence,
    hasRoleSentence,
    hasChainSentence,
  };
}

function mapDetailFetchErrorCode(error: unknown): DetailHydrationErrorCode {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
  if (/\b403\b|forbidden/.test(message)) return "http_403";
  if (/cloudflare|challenge|just a moment/.test(message)) return "http_403";
  if (/\b429\b|rate[_\s-]?limit|throttle/.test(message)) return "http_429";
  if (/timeout|timed out|abort|fetch_timeout/.test(message)) return "timeout";
  if (/detail_parse_empty|empty detail|no evidence windows/.test(message)) return "parse_empty";
  if (/network|fetch failed|econn|enotfound|socket|dns/.test(message)) return "network";
  return "unknown";
}

function isTransientDetailErrorCode(code: DetailHydrationErrorCode): boolean {
  return code === "timeout" || code === "network";
}

function isCacheableDetailFailure(code: DetailHydrationErrorCode): boolean {
  return code === "http_403" || code === "http_429" || code === "parse_empty";
}

function preferKnownCourt(primary: CourtLevel | undefined, fallback: CourtLevel): CourtLevel {
  if (primary && primary !== "UNKNOWN") return primary;
  return fallback;
}

function detailErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "detail_fetch_error");
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitleForQuery(title: string): string {
  return title
    .replace(/\s+-\s*indian kanoon\s*$/i, "")
    .replace(/\s+on\s+\d{1,2}\s+[a-z]{3,12},?\s+\d{4}\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeSnippet(value: string): string | null {
  const cleaned = stripHtml(value).replace(/\s+/g, " ").trim();
  if (cleaned.length < 40) return null;
  return cleaned.slice(0, 500);
}

function sanitizeSerperTitle(value: string): string {
  return stripHtml(value).slice(0, 320);
}

function titleOverlapScore(left: string, right: string): number {
  const normalize = (input: string) =>
    input
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
  const leftTokens = [...new Set(normalize(left))];
  const rightTokens = new Set(normalize(right));
  if (leftTokens.length === 0 || rightTokens.size === 0) return 0;
  const overlap = leftTokens.filter((token) => rightTokens.has(token)).length;
  return overlap / Math.max(leftTokens.length, rightTokens.size);
}

function buildSerperFallbackQueries(candidate: ClassifiedCandidate): string[] {
  const docId =
    extractDocIdFromUrl(candidate.url) ??
    extractDocIdFromUrl(candidate.fullDocumentUrl);
  const titleCore = normalizeTitleForQuery(candidate.title);
  const queries = [
    docId ? `site:indiankanoon.org/doc ${docId}` : "",
    titleCore ? `site:indiankanoon.org/doc \"${titleCore}\"` : "",
    titleCore ? `\"${titleCore}\" indiankanoon` : "",
  ];
  const output: string[] = [];
  for (const query of queries) {
    const normalized = query.replace(/\s+/g, " ").trim();
    if (!normalized || output.includes(normalized)) continue;
    output.push(normalized);
    if (output.length >= 2) break;
  }
  return output;
}

async function searchSerperOrganic(query: string, num: number): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const apiKey = process.env.SERPER_API_KEY?.trim();
  if (!apiKey) return [];
  const controller = new AbortController();
  const timeoutMs = Math.max(1_500, Math.min(VERIFY_DETAIL_TIMEOUT_MS, 8_000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(SERPER_ENDPOINT, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        num: Math.max(6, Math.min(num, 20)),
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
    const organic = Array.isArray(payload.organic) ? payload.organic : [];
    const rows: Array<{ title: string; link: string; snippet: string }> = [];
    for (const row of organic) {
      const title = sanitizeSerperTitle(row.title ?? "");
      const link = String(row.link ?? "").trim();
      const snippet = sanitizeSnippet(row.snippet ?? "");
      if (!link || !snippet) continue;
      rows.push({ title, link, snippet });
    }
    return rows;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function buildSerperSnippetFallback(candidate: ClassifiedCandidate): Promise<{
  snippets: string[];
  finalUrl?: string;
}> {
  const queries = buildSerperFallbackQueries(candidate);
  if (queries.length === 0) return { snippets: [] };

  const docId =
    extractDocIdFromUrl(candidate.url) ??
    extractDocIdFromUrl(candidate.fullDocumentUrl);
  const snippets: string[] = [];
  const seenSnippet = new Set<string>();
  let finalUrl: string | undefined;

  for (const query of queries) {
    const rows = await searchSerperOrganic(query, 12);
    for (const row of rows) {
      const sameDoc = Boolean(docId && row.link.includes(`/${docId}/`));
      const sameHost = /indiankanoon\.org\/(?:doc|docfragment)\//i.test(row.link);
      const titleScore = titleOverlapScore(candidate.title, row.title);
      if (!sameDoc && !sameHost && titleScore < 0.45) continue;
      if (!seenSnippet.has(row.snippet)) {
        seenSnippet.add(row.snippet);
        snippets.push(row.snippet);
      }
      if (!finalUrl && (sameDoc || sameHost)) {
        finalUrl = row.link;
      }
      if (snippets.length >= 18) {
        return { snippets, finalUrl };
      }
    }
  }

  return { snippets, finalUrl };
}

function hydrateCandidateWithDetail(input: {
  candidate: ClassifiedCandidate;
  detailText: string;
  artifact: Awaited<ReturnType<typeof fetchIndianKanoonCaseDetail>>;
  finalUrl: string;
  attemptedUrls: string[];
  hydrationStatus: "success" | "fallback_success";
}): ClassifiedCandidate {
  const safeTitle =
    input.artifact.title && !isPseudoTitle(input.artifact.title)
      ? input.artifact.title
      : input.candidate.title;

  return {
    ...input.candidate,
    title: safeTitle,
    court: preferKnownCourt(input.artifact.court, input.candidate.court),
    courtText: input.artifact.courtText || input.candidate.courtText,
    citesCount:
      typeof input.artifact.citesCount === "number" ? input.artifact.citesCount : input.candidate.citesCount,
    citedByCount:
      typeof input.artifact.citedByCount === "number"
        ? input.artifact.citedByCount
        : input.candidate.citedByCount,
    detailText: input.detailText,
    detailArtifact: input.artifact,
    evidenceQuality: detectEvidenceQuality(input.detailText),
    detailHydration: {
      status: input.hydrationStatus,
      attemptedUrls: input.attemptedUrls,
      finalUrl: input.finalUrl,
    },
  };
}

function cacheHydratedDetail(candidate: ClassifiedCandidate, detail: CachedDetail, attemptedUrls: string[]): void {
  const docId = extractDocIdFromUrl(candidate.url) ?? extractDocIdFromUrl(candidate.fullDocumentUrl);
  const cacheUrls = [
    candidate.url,
    candidate.fullDocumentUrl,
    canonicalDocHref(candidate.url),
    canonicalDocHref(candidate.fullDocumentUrl ?? ""),
    ...attemptedUrls,
  ];
  for (const url of cacheUrls) {
    if (!url) continue;
    detailCacheByUrl.set(url, detail);
    detailFailureCacheByUrl.delete(url);
  }
  if (docId) {
    detailCacheByDocId.set(docId, detail);
    detailFailureCacheByDocId.delete(docId);
  }
}

function cacheDetailFailure(
  candidate: ClassifiedCandidate,
  attemptedUrls: string[],
  errorCode: DetailHydrationErrorCode,
): void {
  if (!isCacheableDetailFailure(errorCode)) {
    return;
  }
  const entry: CachedDetailFailure = {
    errorCode,
    fetchedAt: Date.now(),
  };
  const docId = extractDocIdFromUrl(candidate.url) ?? extractDocIdFromUrl(candidate.fullDocumentUrl);
  const cacheUrls = [
    candidate.url,
    candidate.fullDocumentUrl,
    canonicalDocHref(candidate.url),
    canonicalDocHref(candidate.fullDocumentUrl ?? ""),
    ...attemptedUrls,
  ];
  for (const url of cacheUrls) {
    if (!url) continue;
    if (detailCacheByUrl.has(url)) continue;
    detailFailureCacheByUrl.set(url, entry);
  }
  if (docId && !detailCacheByDocId.has(docId)) {
    detailFailureCacheByDocId.set(docId, entry);
  }
}

function readCachedDetail(candidate: ClassifiedCandidate): CachedDetail | undefined {
  const now = Date.now();
  const cacheUrls = [
    candidate.url,
    candidate.fullDocumentUrl,
    canonicalDocHref(candidate.url),
    canonicalDocHref(candidate.fullDocumentUrl ?? ""),
  ].filter(
    (url): url is string => Boolean(url),
  );
  for (const url of cacheUrls) {
    const cached = detailCacheByUrl.get(url);
    if (cached && now - cached.fetchedAt <= VERIFY_DETAIL_CACHE_TTL_MS) {
      return cached;
    }
  }
  const docId = extractDocIdFromUrl(candidate.url) ?? extractDocIdFromUrl(candidate.fullDocumentUrl);
  if (!docId) {
    return undefined;
  }
  const cachedByDocId = detailCacheByDocId.get(docId);
  if (!cachedByDocId) {
    return undefined;
  }
  if (now - cachedByDocId.fetchedAt > VERIFY_DETAIL_CACHE_TTL_MS) {
    return undefined;
  }
  return cachedByDocId;
}

function readCachedFailure(candidate: ClassifiedCandidate): CachedDetailFailure | undefined {
  const now = Date.now();
  const cacheUrls = [
    candidate.url,
    candidate.fullDocumentUrl,
    canonicalDocHref(candidate.url),
    canonicalDocHref(candidate.fullDocumentUrl ?? ""),
  ].filter((url): url is string => Boolean(url));
  for (const url of cacheUrls) {
    const cached = detailFailureCacheByUrl.get(url);
    if (!cached) continue;
    if (now - cached.fetchedAt > VERIFY_DETAIL_CACHE_TTL_MS) continue;
    return cached;
  }
  const docId = extractDocIdFromUrl(candidate.url) ?? extractDocIdFromUrl(candidate.fullDocumentUrl);
  if (!docId) return undefined;
  const cachedByDocId = detailFailureCacheByDocId.get(docId);
  if (!cachedByDocId) return undefined;
  if (now - cachedByDocId.fetchedAt > VERIFY_DETAIL_CACHE_TTL_MS) return undefined;
  return cachedByDocId;
}

function appendSampleError(
  samples: string[],
  candidate: ClassifiedCandidate,
  code: DetailHydrationErrorCode,
  message: string,
  url?: string,
): void {
  if (samples.length >= DETAIL_FETCH_SAMPLE_ERROR_LIMIT) return;
  const title = candidate.title.replace(/\s+/g, " ").trim().slice(0, 80);
  const context = [
    `code=${code}`,
    url ? `url=${url}` : "",
    message ? `error=${message.slice(0, 120)}` : "",
    title ? `title=${title}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  samples.push(context);
}

export async function verifyCandidates(
  candidates: ClassifiedCandidate[],
  limit: number,
  options?: {
    allowNetworkFetch?: boolean;
  },
): Promise<{ verified: ClassifiedCandidate[]; summary: VerificationSummary }> {
  const allowNetworkFetch = options?.allowNetworkFetch ?? true;
  const verified: ClassifiedCandidate[] = [];
  let detailFetched = 0;
  let detailFetchFailed = 0;
  let detailFetchFallbackUsed = 0;
  let hybridFallbackUsed = 0;
  let hybridFallbackSuccesses = 0;
  const detailFetchErrorCounts: Record<string, number> = {};
  const detailFetchSampleErrors: string[] = [];

  const verifyPool = candidates.slice(0, limit);
  const rest = candidates.slice(limit);
  const hybridFallbackCutoff = Math.min(DETAIL_HYBRID_FALLBACK_TOP_N, verifyPool.length);

  const resolved = new Array<ClassifiedCandidate>(verifyPool.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= verifyPool.length) return;

      const candidate = verifyPool[index];
      let current = candidate;
      const attemptedUrls: string[] = [];
      const candidateErrors: CandidateFetchError[] = [];

      try {
        if (candidate.detailArtifact && candidate.detailArtifact.evidenceWindows) {
          const detailText = candidate.detailText || detailArtifactToText(candidate.detailArtifact);
          const evidenceQuality = candidate.evidenceQuality ?? detectEvidenceQuality(detailText);
          current = {
            ...candidate,
            title:
              candidate.detailArtifact.title && !isPseudoTitle(candidate.detailArtifact.title)
                ? candidate.detailArtifact.title
                : candidate.title,
            court: preferKnownCourt(candidate.detailArtifact.court, candidate.court),
            courtText: candidate.detailArtifact.courtText || candidate.courtText,
            citesCount:
              typeof candidate.detailArtifact.citesCount === "number"
                ? candidate.detailArtifact.citesCount
                : candidate.citesCount,
            citedByCount:
              typeof candidate.detailArtifact.citedByCount === "number"
                ? candidate.detailArtifact.citedByCount
                : candidate.citedByCount,
            detailText,
            evidenceQuality,
            detailHydration: {
              status: "success",
              finalUrl: candidate.url,
              attemptedUrls,
            },
          };
          detailFetched += 1;
          cacheHydratedDetail(
            candidate,
            {
              title: current.title,
              court: current.court,
              detailText,
              detailArtifact: candidate.detailArtifact,
              evidenceQuality,
              fetchedAt: Date.now(),
              finalUrl: candidate.url,
            },
            attemptedUrls,
          );
        } else if (allowNetworkFetch) {
          const cached = readCachedDetail(candidate);
          if (cached) {
            current = {
              ...candidate,
              title: cached.title,
              court: cached.court,
              detailText: cached.detailText,
              detailArtifact: cached.detailArtifact,
              evidenceQuality: cached.evidenceQuality,
              detailHydration: {
                status: "success",
                attemptedUrls,
                finalUrl: cached.finalUrl ?? candidate.url,
              },
              };
            detailFetched += 1;
          } else {
            let successfulDirect:
              | {
                  artifact: Awaited<ReturnType<typeof fetchIndianKanoonCaseDetail>>;
                  detailText: string;
                  url: string;
                }
              | undefined;
            const cachedFailure = readCachedFailure(candidate);
            if (cachedFailure) {
              candidateErrors.push({
                code: cachedFailure.errorCode,
                message: `cached_failure:${cachedFailure.errorCode}`,
              });
            } else {
              const detailUrls = detailFetchUrls(candidate);
              for (const detailUrl of detailUrls) {
                attemptedUrls.push(detailUrl);
                const maxAttempts = 1 + VERIFY_DETAIL_TRANSIENT_RETRIES;
                let resolved = false;
                for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                  try {
                    const artifact = await fetchIndianKanoonCaseDetail(detailUrl, {
                      fetchTimeoutMs: VERIFY_DETAIL_TIMEOUT_MS,
                      max429Retries: VERIFY_DETAIL_MAX_429_RETRIES,
                      maxRetryAfterMs: VERIFY_DETAIL_MAX_RETRY_AFTER_MS,
                    });
                    const detailText = detailArtifactToText(artifact);
                    if (!hasUsableDetail(detailText, artifact)) {
                      throw new Error("detail_parse_empty");
                    }
                    successfulDirect = { artifact, detailText, url: detailUrl };
                    resolved = true;
                    break;
                  } catch (error) {
                    const code = mapDetailFetchErrorCode(error);
                    const isTransient = isTransientDetailErrorCode(code);
                    if (isTransient && attempt < maxAttempts) {
                      const waitMs = VERIFY_DETAIL_TRANSIENT_RETRY_BACKOFF_MS * attempt;
                      await sleep(waitMs);
                      continue;
                    }
                    candidateErrors.push({
                      code,
                      message: detailErrorMessage(error),
                      url: detailUrl,
                    });
                    break;
                  }
                }
                if (resolved) {
                  break;
                }
              }
            }

            if (successfulDirect) {
              detailFetched += 1;
              if (successfulDirect.url !== candidate.url) {
                detailFetchFallbackUsed += 1;
              }
              current = hydrateCandidateWithDetail({
                candidate,
                detailText: successfulDirect.detailText,
                artifact: successfulDirect.artifact,
                finalUrl: successfulDirect.url,
                attemptedUrls,
                hydrationStatus: "success",
              });
              cacheHydratedDetail(
                candidate,
                {
                  title: current.title,
                  court: current.court,
                  detailText: current.detailText,
                  detailArtifact: current.detailArtifact,
                  evidenceQuality: current.evidenceQuality,
                  fetchedAt: Date.now(),
                  finalUrl: successfulDirect.url,
                },
                attemptedUrls,
              );
            } else {
              const directBlockedByAntiBot = candidateErrors.some(
                (entry) =>
                  entry.code === "http_403" ||
                  /cloudflare|challenge|just a moment/i.test(entry.message),
              );
              const shouldTryHybridFallback =
                DETAIL_HYBRID_FALLBACK_ENABLED &&
                index < hybridFallbackCutoff &&
                !directBlockedByAntiBot;
              let hybridAttempted = false;

              if (shouldTryHybridFallback) {
                hybridAttempted = true;
                hybridFallbackUsed += 1;
                const docId =
                  extractDocIdFromUrl(candidate.url) ??
                  extractDocIdFromUrl(candidate.fullDocumentUrl);
                try {
                  const fallbackUrl = await resolveIndianKanoonDetailUrlByHint({
                    title: candidate.title,
                    docId,
                    court: candidate.court,
                    fetchTimeoutMs: VERIFY_DETAIL_TIMEOUT_MS,
                    max429Retries: VERIFY_DETAIL_MAX_429_RETRIES,
                    maxRetryAfterMs: VERIFY_DETAIL_MAX_RETRY_AFTER_MS,
                  });
                  if (fallbackUrl) {
                    if (!attemptedUrls.includes(fallbackUrl)) {
                      attemptedUrls.push(fallbackUrl);
                    }
                    const artifact = await fetchIndianKanoonCaseDetail(fallbackUrl, {
                      fetchTimeoutMs: VERIFY_DETAIL_TIMEOUT_MS,
                      max429Retries: VERIFY_DETAIL_MAX_429_RETRIES,
                      maxRetryAfterMs: VERIFY_DETAIL_MAX_RETRY_AFTER_MS,
                    });
                    const detailText = detailArtifactToText(artifact);
                    if (!hasUsableDetail(detailText, artifact)) {
                      throw new Error("detail_parse_empty");
                    }
                    hybridFallbackSuccesses += 1;
                    detailFetched += 1;
                    if (fallbackUrl !== candidate.url) {
                      detailFetchFallbackUsed += 1;
                    }
                    current = hydrateCandidateWithDetail({
                      candidate,
                      detailText,
                      artifact,
                      finalUrl: fallbackUrl,
                      attemptedUrls,
                      hydrationStatus: "fallback_success",
                    });
                    cacheHydratedDetail(
                      candidate,
                      {
                        title: current.title,
                        court: current.court,
                        detailText: current.detailText,
                        detailArtifact: current.detailArtifact,
                        evidenceQuality: current.evidenceQuality,
                        fetchedAt: Date.now(),
                        finalUrl: fallbackUrl,
                      },
                      attemptedUrls,
                    );
                  } else {
                    candidateErrors.push({
                      code: "parse_empty",
                      message: "hybrid_fallback_no_matching_doc",
                    });
                  }
                } catch (error) {
                  candidateErrors.push({
                    code: mapDetailFetchErrorCode(error),
                    message: detailErrorMessage(error),
                  });
                }
              }

              const shouldTrySerperSnippetFallback =
                DETAIL_SERPER_SNIPPET_FALLBACK_ENABLED &&
                index < DETAIL_SERPER_SNIPPET_FALLBACK_TOP_N &&
                !current.detailText;
              if (shouldTrySerperSnippetFallback) {
                hybridAttempted = true;
                hybridFallbackUsed += 1;
                try {
                  const snippetFallback = await buildSerperSnippetFallback(candidate);
                  if (snippetFallback.snippets.length >= DETAIL_SERPER_SNIPPET_MIN_SNIPPETS) {
                    const snippetCourt = preferKnownCourt(
                      inferCourtLevelFromText(
                        `${candidate.title} ${snippetFallback.snippets.slice(0, 6).join(" ")}`,
                      ),
                      candidate.court,
                    );
                    const syntheticArtifact = {
                      title: candidate.title,
                      courtText:
                        snippetCourt === "SC"
                          ? "Supreme Court of India"
                          : snippetCourt === "HC"
                            ? "High Court"
                            : undefined,
                      court: snippetCourt,
                      evidenceWindows: snippetFallback.snippets.slice(0, 14),
                      bodyExcerpt: snippetFallback.snippets.slice(0, 18),
                    };
                    const detailText = detailArtifactToText(syntheticArtifact);
                    hybridFallbackSuccesses += 1;
                    detailFetched += 1;
                    if ((snippetFallback.finalUrl ?? candidate.url) !== candidate.url) {
                      detailFetchFallbackUsed += 1;
                    }
                    current = {
                      ...candidate,
                      court: snippetCourt,
                      detailText,
                      detailArtifact: syntheticArtifact,
                      evidenceQuality: detectEvidenceQuality(detailText),
                      detailHydration: {
                        status: "fallback_success",
                        attemptedUrls,
                        finalUrl: snippetFallback.finalUrl ?? candidate.url,
                      },
                    };
                    cacheHydratedDetail(
                      candidate,
                      {
                        title: current.title,
                        court: current.court,
                        detailText: current.detailText,
                        detailArtifact: current.detailArtifact,
                        evidenceQuality: current.evidenceQuality,
                        fetchedAt: Date.now(),
                        finalUrl: snippetFallback.finalUrl ?? candidate.url,
                      },
                      attemptedUrls,
                    );
                  } else {
                    candidateErrors.push({
                      code: "parse_empty",
                      message: "serper_snippet_fallback_insufficient_evidence",
                    });
                  }
                } catch (error) {
                  candidateErrors.push({
                    code: mapDetailFetchErrorCode(error),
                    message: detailErrorMessage(error),
                  });
                }
              }

              if (!current.detailText) {
                detailFetchFailed += 1;
                const finalError =
                  candidateErrors[candidateErrors.length - 1] ??
                  ({ code: "unknown", message: "detail_fetch_failed" } satisfies CandidateFetchError);
                cacheDetailFailure(candidate, attemptedUrls, finalError.code);
                detailFetchErrorCounts[finalError.code] =
                  (detailFetchErrorCounts[finalError.code] ?? 0) + 1;
                appendSampleError(
                  detailFetchSampleErrors,
                  candidate,
                  finalError.code,
                  finalError.message,
                  finalError.url,
                );
                current = {
                  ...candidate,
                  detailHydration: {
                    status: hybridAttempted ? "fallback_failed" : "failed",
                    errorCode: finalError.code,
                    attemptedUrls,
                  },
                };
              }
            }
          }
        } else {
          current = {
            ...candidate,
            detailHydration: {
              status: "failed",
              errorCode: "network",
              attemptedUrls,
            },
          };
        }
      } catch (error) {
        detailFetchFailed += 1;
        const code = mapDetailFetchErrorCode(error);
        cacheDetailFailure(candidate, attemptedUrls, code);
        detailFetchErrorCounts[code] = (detailFetchErrorCounts[code] ?? 0) + 1;
        appendSampleError(detailFetchSampleErrors, candidate, code, detailErrorMessage(error));
        current = {
          ...candidate,
          detailHydration: {
            status: "failed",
            errorCode: code,
            attemptedUrls,
          },
        };
      }

      const classification = classifyCandidate(current);
      resolved[index] = { ...current, classification };
    }
  }

  const workers = Array.from({ length: Math.min(VERIFY_CONCURRENCY, Math.max(1, verifyPool.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);

  for (const item of resolved) {
    if (item) verified.push(item);
  }

  const reclassifiedRest = rest.map((item) => ({
    ...item,
    classification: classifyCandidate(item),
  }));

  const combined = [...verified, ...reclassifiedRest];
  const passedCaseGate = combined.filter((item) => item.classification.kind === "case").length;
  const detailHydrationCoverage =
    verifyPool.length > 0 ? Number((detailFetched / verifyPool.length).toFixed(3)) : 0;

  return {
    verified: combined,
    summary: {
      attempted: verifyPool.length,
      detailFetched,
      detailFetchFailed,
      detailFetchFallbackUsed,
      detailFetchErrorCounts:
        Object.keys(detailFetchErrorCounts).length > 0 ? detailFetchErrorCounts : undefined,
      detailFetchSampleErrors:
        detailFetchSampleErrors.length > 0 ? detailFetchSampleErrors : undefined,
      hybridFallbackUsed,
      hybridFallbackSuccesses,
      detailHydrationCoverage,
      passedCaseGate,
    },
  };
}
