import { CaseCandidate, CourtLevel } from "@/lib/types";
import { parseIndianKanoonSearchPage } from "@/lib/indiankanoon-parser";

export type IndianKanoonFetchDebug = {
  phrase: string;
  searchQuery: string;
  url: string;
  status: number;
  ok: boolean;
  contentType: string;
  serverHeader: string;
  cfRay: string;
  cloudflareDetected: boolean;
  challengeDetected: boolean;
  cooldownActive?: boolean;
  retryAfterMs?: number;
  blockedType?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
  timedOut?: boolean;
  fetchTimeoutMsUsed?: number;
  parserMode:
    | "result_container"
    | "result_title"
    | "h4_anchor"
    | "generic_anchor"
    | "doc_link_harvest";
  pagesScanned: number;
  pageCaseCounts: number[];
  nextPageDetected: boolean;
  rawParsedCount: number;
  excludedStatuteCount: number;
  excludedWeakCount: number;
  parsedCount: number;
  htmlPreview: string;
};

export class IndianKanoonFetchError extends Error {
  debug: IndianKanoonFetchDebug;

  constructor(message: string, debug: IndianKanoonFetchDebug) {
    super(message);
    this.name = "IndianKanoonFetchError";
    this.debug = debug;
  }
}

export type IndianKanoonFetchResult = {
  cases: CaseCandidate[];
  debug: IndianKanoonFetchDebug;
};

export type IndianKanoonSearchOptions = {
  maxResultsPerPhrase?: number;
  courtHint?: CourtLevel;
  courtType?: "supremecourt" | "highcourts";
  fromDate?: string;
  toDate?: string;
  sortByMostRecent?: boolean;
  maxPages?: number;
  crawlMaxElapsedMs?: number;
  fetchTimeoutMs?: number;
  max429Retries?: number;
  maxRetryAfterMs?: number;
  cooldownScope?: string;
};

const DEFAULT_CHALLENGE_COOLDOWN_MS = 30_000;
const DEFAULT_FETCH_TIMEOUT_MS = 3_500;
const DEFAULT_MAX_429_RETRIES = 0;
const DEFAULT_MAX_RETRY_AFTER_MS = 1_500;
const configuredCooldown = Number(process.env.IK_CHALLENGE_COOLDOWN_MS ?? DEFAULT_CHALLENGE_COOLDOWN_MS);
const CHALLENGE_COOLDOWN_MS = Number.isFinite(configuredCooldown)
  ? Math.max(10_000, configuredCooldown)
  : DEFAULT_CHALLENGE_COOLDOWN_MS;
const configuredFetchTimeout = Number(process.env.IK_FETCH_TIMEOUT_MS ?? DEFAULT_FETCH_TIMEOUT_MS);
const FETCH_TIMEOUT_MS = Number.isFinite(configuredFetchTimeout)
  ? Math.max(1_500, Math.min(15_000, configuredFetchTimeout))
  : DEFAULT_FETCH_TIMEOUT_MS;
const configuredMax429Retries = Number(process.env.IK_MAX_429_RETRIES ?? DEFAULT_MAX_429_RETRIES);
const MAX_429_RETRIES = Number.isFinite(configuredMax429Retries)
  ? Math.max(0, Math.min(3, Math.floor(configuredMax429Retries)))
  : DEFAULT_MAX_429_RETRIES;
const configuredMaxRetryAfter = Number(process.env.IK_MAX_RETRY_AFTER_MS ?? DEFAULT_MAX_RETRY_AFTER_MS);
const MAX_RETRY_AFTER_MS = Number.isFinite(configuredMaxRetryAfter)
  ? Math.max(500, Math.min(5_000, Math.floor(configuredMaxRetryAfter)))
  : DEFAULT_MAX_RETRY_AFTER_MS;
const challengeCooldownByScope = new Map<string, number>();

function stripTags(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCooldownScope(scope?: string): string {
  const value = (scope ?? "global").trim().toLowerCase();
  return value.length > 0 ? value : "global";
}

function challengeCooldownRemainingMs(scope?: string): number {
  const key = normalizeCooldownScope(scope);
  const until = challengeCooldownByScope.get(key) ?? 0;
  return Math.max(0, until - Date.now());
}

function setChallengeCooldown(scope: string | undefined, durationMs: number = CHALLENGE_COOLDOWN_MS): void {
  const key = normalizeCooldownScope(scope);
  const until = Date.now() + Math.max(1_000, durationMs);
  const current = challengeCooldownByScope.get(key) ?? 0;
  challengeCooldownByScope.set(key, Math.max(current, until));
}

function isLikelyStatute(title: string, snippet: string): boolean {
  const text = `${title} ${snippet}`.toLowerCase();
  return (
    /\bindian penal code\b/.test(text) ||
    /\bpenal code,\s*\d{4}\b/.test(text) ||
    /\bcode of criminal procedure\b/.test(text) ||
    /\bcriminal procedure code\b/.test(text) ||
    /\bsection\s+\d+[a-z]?\b[\s\S]{0,60}\b(?:punishment|whoever|shall be punished)\b/.test(text) ||
    /\bconstitution of india\b/.test(text) ||
    /\bact,\s*\d{4}\b/.test(text) ||
    /\bcode,\s*\d{4}\b/.test(text) ||
    /\brules,\s*\d{4}\b/.test(text) ||
    /\bregulations?\b/.test(text) ||
    /\bmunicipal(?:ity|ities)? act\b/.test(text) ||
    /\bgoods and services tax act\b/.test(text)
  );
}

function isLikelyCaseLaw(title: string, snippet: string): boolean {
  const titleText = title.toLowerCase();
  const snippetText = snippet.toLowerCase();
  const titleSignals =
    /\b v(?:s\.?|\.?) \b/.test(titleText) ||
    /\bon\s+\d{1,2}\s+[a-z]{3,9}\s+\d{4}\b/.test(titleText) ||
    /\b(?:petitioner|respondent|appellant|appeal|criminal appeal|writ petition|judgment)\b/.test(
      titleText,
    );
  const snippetSignals =
    /\b v(?:s\.?|\.?) \b/.test(snippetText) ||
    /\b(?:petitioner|respondent|appellant|appeal|criminal appeal|writ petition|judgment)\b/.test(
      snippetText,
    );
  return (
    titleSignals ||
    (snippetSignals && !isLikelyStatute(title, ""))
  );
}

function normalizeSearchHref(href: string): string | null {
  if (!href) {
    return null;
  }
  try {
    if (href.startsWith("http://") || href.startsWith("https://")) {
      return href;
    }
    if (href.startsWith("//")) {
      return `https:${href}`;
    }
    return new URL(href, "https://indiankanoon.org").toString();
  } catch {
    return null;
  }
}

function parseIntSafe(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/,/g, "").trim();
  const asNumber = Number(normalized);
  return Number.isFinite(asNumber) ? asNumber : undefined;
}

function parseNextPageUrl(html: string): string | null {
  const relNext =
    html.match(/<a[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i) ??
    html.match(/<a[^>]+href=["']([^"']+)["'][^>]+rel=["']next["']/i);
  if (relNext) {
    return normalizeSearchHref(relNext[1]);
  }
  const textNext = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*>\s*Next\s*<\/a>/i);
  if (textNext) {
    return normalizeSearchHref(textNext[1]);
  }
  return null;
}

function withPageNum(searchUrl: string, pageNum: number): string {
  try {
    const parsed = new URL(searchUrl);
    parsed.searchParams.set("pagenum", String(pageNum));
    return parsed.toString();
  } catch {
    return searchUrl;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) {
    return Math.min(1500, MAX_RETRY_AFTER_MS);
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(dateMs - Date.now(), 500), MAX_RETRY_AFTER_MS);
  }
  return Math.min(1500, MAX_RETRY_AFTER_MS);
}

function makeBlockedDebug(
  phrase: string,
  searchQuery: string,
  url: string,
  preview: string,
  options?: {
    retryAfterMs?: number;
    blockedType?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
    fetchTimeoutMsUsed?: number;
  },
): IndianKanoonFetchDebug {
  return {
    phrase,
    searchQuery,
    url,
    status: 429,
    ok: false,
    contentType: "text/html",
    serverHeader: "cloudflare",
    cfRay: "",
    cloudflareDetected: true,
    challengeDetected: true,
    cooldownActive: options?.blockedType === "local_cooldown",
    retryAfterMs: options?.retryAfterMs,
    blockedType: options?.blockedType ?? "cloudflare_challenge",
    timedOut: false,
    fetchTimeoutMsUsed: options?.fetchTimeoutMsUsed,
    parserMode: "generic_anchor",
    pagesScanned: 0,
    pageCaseCounts: [],
    nextPageDetected: false,
    rawParsedCount: 0,
    excludedStatuteCount: 0,
    excludedWeakCount: 0,
    parsedCount: 0,
    htmlPreview: preview,
  };
}

class FetchTimeoutError extends Error {
  timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`fetch_timeout:${timeoutMs}`);
    this.name = "FetchTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

async function fetchWithRateLimitHandling(
  url: string,
  options?: {
    fetchTimeoutMs?: number;
    max429Retries?: number;
    maxRetryAfterMs?: number;
    cooldownScope?: string;
    applyCooldownOn429?: boolean;
  },
): Promise<Response> {
  const fetchTimeoutMs = Math.max(1_500, Math.min(options?.fetchTimeoutMs ?? FETCH_TIMEOUT_MS, 15_000));
  const max429Retries = Math.max(0, Math.min(options?.max429Retries ?? MAX_429_RETRIES, 3));
  const maxRetryAfterMs = Math.max(500, Math.min(options?.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS, 5_000));
  const applyCooldownOn429 = options?.applyCooldownOn429 ?? true;
  const maxAttempts = max429Retries + 1;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 precedentfinding/1.0",
          Accept: "text/html,application/xhtml+xml",
        },
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new FetchTimeoutError(fetchTimeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    lastResponse = response;

    if (response.status === 429 && applyCooldownOn429) {
      const retryAfterMs = Math.min(parseRetryAfterMs(response.headers.get("retry-after")), maxRetryAfterMs);
      setChallengeCooldown(options?.cooldownScope, retryAfterMs + 1_000);
    }

    if (response.status !== 429 || attempt === maxAttempts) {
      return response;
    }

    const retryAfterMs = Math.min(parseRetryAfterMs(response.headers.get("retry-after")), maxRetryAfterMs);
    const jitter = 200 + Math.floor(Math.random() * 400);
    await sleep(retryAfterMs + jitter);
  }

  return lastResponse as Response;
}

function buildSearchQuery(phrase: string, options: IndianKanoonSearchOptions): string {
  const parts: string[] = [];
  if (options.courtType) {
    parts.push(`doctypes:${options.courtType}`);
  }
  if (options.fromDate) {
    parts.push(`fromdate:${options.fromDate}`);
  }
  if (options.toDate) {
    parts.push(`todate:${options.toDate}`);
  }
  if (options.sortByMostRecent === true) {
    parts.push("sortby:mostrecent");
  }
  parts.push(phrase.trim());
  return parts.filter((v) => v.length > 0).join(" ").replace(/\s+/g, " ").trim();
}

async function crawlSearchPages(
  startUrl: string,
  phrase: string,
  searchQuery: string,
  options: IndianKanoonSearchOptions = {},
): Promise<IndianKanoonFetchResult> {
  const cooldownScope = options.cooldownScope;
  const cooldownRemaining = challengeCooldownRemainingMs(cooldownScope);
  if (cooldownRemaining > 0) {
    const retryAfterMs = Math.ceil(cooldownRemaining);
    const preview = `Local Cloudflare cooldown active for ${Math.ceil(
      cooldownRemaining / 1000,
    )}s; request skipped to avoid repeated blocking.`;
    throw new IndianKanoonFetchError(
      `Cloudflare cooldown active (${Math.ceil(cooldownRemaining / 1000)}s remaining)`,
      makeBlockedDebug(phrase, searchQuery, startUrl, preview, {
        retryAfterMs,
        blockedType: "local_cooldown",
      }),
    );
  }

  const maxResultsPerPhrase = options.maxResultsPerPhrase ?? 12;
  const courtHint = options.courtHint ?? "UNKNOWN";
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 3, 10));
  const crawlStartedAt = Date.now();
  const crawlMaxElapsedMs = Math.max(
    2_000,
    Math.min(
      options.crawlMaxElapsedMs ?? (Math.max(3_000, (options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS) + 1_500)),
      20_000,
    ),
  );
  const usePageNumLoop = startUrl.includes("/search/?");

  const collected: CaseCandidate[] = [];
  const seenCaseUrls = new Set<string>();
  const seenSearchUrls = new Set<string>();
  const pageCaseCounts: number[] = [];

  let rawParsedCount = 0;
  let excludedStatuteCount = 0;
  let excludedWeakCount = 0;
  let pagesScanned = 0;
  let nextPageDetected = false;

  let finalStatus = 0;
  let finalOk = false;
  let finalContentType = "";
  let finalServerHeader = "";
  let finalCfRay = "";
  let anyCloudflareDetected = false;
  let anyChallengeDetected = false;
  let parserMode: IndianKanoonFetchDebug["parserMode"] = "generic_anchor";
  let htmlPreview = "";

  let currentUrl: string | null = usePageNumLoop ? withPageNum(startUrl, 0) : startUrl;
  let pageNum = 0;
  while (currentUrl && pagesScanned < maxPages && !seenSearchUrls.has(currentUrl)) {
    if (Date.now() - crawlStartedAt >= crawlMaxElapsedMs) {
      if (!htmlPreview) {
        htmlPreview = `Search crawl budget reached at ${crawlMaxElapsedMs}ms; returning partial candidates.`;
      } else {
        htmlPreview = `${htmlPreview} | crawlBudgetMs=${crawlMaxElapsedMs}`;
      }
      break;
    }
    seenSearchUrls.add(currentUrl);
    let res: Response;
    try {
      res = await fetchWithRateLimitHandling(currentUrl, {
        fetchTimeoutMs: options.fetchTimeoutMs,
        max429Retries: options.max429Retries,
        maxRetryAfterMs: options.maxRetryAfterMs,
        cooldownScope,
        applyCooldownOn429: true,
      });
    } catch (error) {
      if (error instanceof FetchTimeoutError) {
        throw new IndianKanoonFetchError(
          `Indian Kanoon fetch timed out after ${error.timeoutMs}ms`,
          {
            phrase,
            searchQuery,
            url: currentUrl,
            status: 408,
            ok: false,
            contentType: "text/html",
            serverHeader: "",
            cfRay: "",
            cloudflareDetected: false,
            challengeDetected: false,
            cooldownActive: false,
            retryAfterMs: undefined,
            blockedType: undefined,
            timedOut: true,
            fetchTimeoutMsUsed: error.timeoutMs,
            parserMode: "generic_anchor",
            pagesScanned,
            pageCaseCounts,
            nextPageDetected,
            rawParsedCount,
            excludedStatuteCount,
            excludedWeakCount,
            parsedCount: collected.length,
            htmlPreview: `Source fetch timed out after ${error.timeoutMs}ms.`,
          },
        );
      }
      throw error;
    }
    const html = await res.text();
    pagesScanned += 1;

    finalStatus = finalStatus || res.status;
    finalOk = finalOk || res.ok;
    finalContentType = finalContentType || (res.headers.get("content-type") ?? "");
    finalServerHeader = finalServerHeader || (res.headers.get("server") ?? "");
    finalCfRay = finalCfRay || (res.headers.get("cf-ray") ?? "");
    anyCloudflareDetected =
      anyCloudflareDetected ||
      (res.headers.get("server") ?? "").toLowerCase().includes("cloudflare") ||
      (res.headers.get("cf-ray") ?? "").length > 0;
    const parsedPage = parseIndianKanoonSearchPage(html);
    const challengePage = parsedPage.challenge;
    anyChallengeDetected = anyChallengeDetected || challengePage;
    if (challengePage) {
      setChallengeCooldown(cooldownScope, CHALLENGE_COOLDOWN_MS);
    }
    const noMatchPage = parsedPage.noMatch;
    const docLinkSignals = parsedPage.docLinkSignals;
    const resultSignals = parsedPage.resultSignals;
    if (!htmlPreview) {
      htmlPreview = `meta:docLinks=${docLinkSignals};resultSignals=${resultSignals};noMatch=${String(
        noMatchPage,
      )};challenge=${String(challengePage)}; ${stripTags(html).slice(0, 220)}`;
    }

    const effectiveParsed = noMatchPage
      ? { rawCases: [] as CaseCandidate[], parserMode: "generic_anchor" as const }
      : { rawCases: parsedPage.rawCases, parserMode: parsedPage.parserMode };
    parserMode = effectiveParsed.parserMode;
    rawParsedCount += effectiveParsed.rawCases.length;

    const cleaned = effectiveParsed.rawCases.filter((item) => {
      const statuteLike = isLikelyStatute(item.title, item.snippet);
      const caseLike = isLikelyCaseLaw(item.title, item.snippet);
      if (statuteLike) {
        excludedStatuteCount += 1;
        return false;
      }
      if (!caseLike) {
        excludedWeakCount += 1;
        return false;
      }
      return true;
    });

    pageCaseCounts.push(cleaned.length);
    for (const item of cleaned) {
      const shaped =
        item.court === "UNKNOWN" && courtHint !== "UNKNOWN" ? { ...item, court: courtHint } : item;
      if (!seenCaseUrls.has(shaped.url)) {
        collected.push(shaped);
        seenCaseUrls.add(shaped.url);
      }
    }

    if (!res.ok) {
      break;
    }
    if (noMatchPage || challengePage) {
      break;
    }

    if (usePageNumLoop) {
      const explicitNextUrl = parseNextPageUrl(html);
      pageNum += 1;
      const nextUrl = explicitNextUrl ?? withPageNum(startUrl, pageNum);
      if (pageNum < maxPages && nextUrl && !seenSearchUrls.has(nextUrl)) {
        nextPageDetected = true;
        await sleep(250);
        currentUrl = nextUrl;
      } else {
        currentUrl = null;
      }
    } else {
      const nextUrl = parseNextPageUrl(html);
      if (nextUrl && !seenSearchUrls.has(nextUrl)) {
        nextPageDetected = true;
        await sleep(250);
        currentUrl = nextUrl;
      } else {
        currentUrl = null;
      }
    }
  }

  const parsed = collected.slice(0, maxResultsPerPhrase);
  const debug: IndianKanoonFetchDebug = {
    phrase,
    searchQuery,
    url: startUrl,
    status: finalStatus || 500,
    ok: finalOk,
    contentType: finalContentType,
    serverHeader: finalServerHeader,
    cfRay: finalCfRay,
    cloudflareDetected: anyCloudflareDetected,
    challengeDetected: anyChallengeDetected,
    cooldownActive: false,
    timedOut: false,
    fetchTimeoutMsUsed: Math.max(1_500, Math.min(options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS, 15_000)),
    parserMode,
    pagesScanned,
    pageCaseCounts,
    nextPageDetected,
    rawParsedCount,
    excludedStatuteCount,
    excludedWeakCount,
    parsedCount: parsed.length,
    htmlPreview,
  };

  if (!finalOk) {
    if (debug.status === 429) {
      setChallengeCooldown(cooldownScope, CHALLENGE_COOLDOWN_MS);
      debug.blockedType = "rate_limit";
      debug.retryAfterMs = Math.max(1_000, challengeCooldownRemainingMs(cooldownScope));
    }
    throw new IndianKanoonFetchError(`Indian Kanoon returned ${debug.status}`, debug);
  }
  if (debug.challengeDetected && parsed.length === 0) {
    setChallengeCooldown(cooldownScope, CHALLENGE_COOLDOWN_MS);
    debug.blockedType = "cloudflare_challenge";
    debug.retryAfterMs = Math.max(1_000, challengeCooldownRemainingMs(cooldownScope));
    throw new IndianKanoonFetchError("Cloudflare challenge detected", debug);
  }
  return { cases: parsed, debug };
}

export async function searchIndianKanoon(
  phrase: string,
  options: IndianKanoonSearchOptions = {},
): Promise<IndianKanoonFetchResult> {
  const searchQuery = buildSearchQuery(phrase, options);
  const startUrl = `https://indiankanoon.org/search/?formInput=${encodeURIComponent(searchQuery)}`;
  return crawlSearchPages(startUrl, phrase, searchQuery, options);
}

export async function searchIndianKanoonByUrl(
  label: string,
  url: string,
  options: IndianKanoonSearchOptions = {},
): Promise<IndianKanoonFetchResult> {
  return crawlSearchPages(url, label, label, options);
}

export async function discoverSupremeCourtBrowseMonthUrls(year: number): Promise<string[]> {
  const browseUrl = `https://indiankanoon.org/browse/supremecourt/${year}/`;
  const res = await fetchWithRateLimitHandling(browseUrl);
  if (!res.ok) {
    return [];
  }

  const html = await res.text();
  const infoBlock =
    html.match(
      /<div[^>]*class=["'][^"']*info_indian_kanoon[^"']*["'][^>]*>[\s\S]*?<\/div>/im,
    )?.[0] ?? html;
  const links = Array.from(infoBlock.matchAll(/<a[^>]+href=["']([^"']+)["']/gim))
    .map((m) => normalizeSearchHref(m[1]))
    .filter((v): v is string => Boolean(v))
    .filter((v) => v.includes("/browse/") || v.includes("/search/"));
  return [...new Set(links)];
}

function splitEvidenceSentences(text: string): string[] {
  return text
    .split(/[\n.!?]+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 30);
}

function extractEvidenceWindows(blocks: string[], limit: number): string[] {
  const relationCue = /(read with|vis[-\s]?a[-\s]?vis|interplay|interaction|requires under|applies to)/i;
  const polarityCue =
    /(required|not required|mandatory|necessary|refused|dismissed|rejected|not condoned|time barred|allowed|quashed)/i;
  const hookCue = /(section\s*\d+[a-z]?(?:\([0-9a-z]+\))?|crpc|ipc|cpc|prevention of corruption act|pc act|limitation act)/i;
  const roleCue =
    /(appellant|respondent|petitioner|accused|state of|government|prosecution|filed appeal|preferred appeal)/i;
  const chainCue = /(condonation of delay|delay condonation|application for condonation|not condoned|barred by limitation)/i;

  const windows: string[] = [];
  for (const block of blocks) {
    for (const sentence of splitEvidenceSentences(block)) {
      const relation = relationCue.test(sentence);
      const polarity = polarityCue.test(sentence);
      const hook = hookCue.test(sentence);
      const role = roleCue.test(sentence);
      const chain = chainCue.test(sentence);
      if ((relation && hook) || (polarity && hook) || (relation && polarity) || (role && polarity) || (chain && polarity)) {
        windows.push(sentence);
      }
      if (windows.length >= limit) return windows;
    }
  }
  return windows;
}

export async function fetchIndianKanoonCaseDetail(
  url: string,
  options?: {
    fetchTimeoutMs?: number;
    max429Retries?: number;
    maxRetryAfterMs?: number;
    cooldownScope?: string;
  },
): Promise<string> {
  const res = await fetchWithRateLimitHandling(url, {
    ...options,
    applyCooldownOn429: false,
  });

  if (!res.ok) {
    throw new Error(`Case page returned ${res.status}`);
  }

  const html = await res.text();
  const title = stripTags(html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/im)?.[1] ?? "");
  const h3Matches = Array.from(html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gim)).map((m) =>
    stripTags(m[1] ?? ""),
  );
  const courtName = h3Matches.find((item) => /\bcourt\b/i.test(item)) ?? "";
  const equivalentCitations =
    h3Matches.find((item) => /^equivalent citations:/i.test(item)) ?? "";
  const authorLine = h3Matches.find((item) => /^author:/i.test(item)) ?? "";
  const benchLine = h3Matches.find((item) => /^bench:/i.test(item)) ?? "";

  const citesCount = parseIntSafe(html.match(/>\s*Cites\s*([0-9,]+)\s*</im)?.[1]);
  const citedByCount = parseIntSafe(html.match(/>\s*Cited\s*by\s*([0-9,]+)\s*</im)?.[1]);

  const blockquotes = Array.from(
    html.matchAll(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gim),
  )
    .map((m) => stripTags(m[1] ?? ""))
    .filter((item) => item.length > 30)
    .slice(0, 80);

  const paragraphFallback =
    blockquotes.length > 0
      ? []
      : Array.from(html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gim))
          .map((m) => stripTags(m[1] ?? ""))
          .filter((item) => item.length > 40)
          .slice(0, 30);
  const evidenceWindows = extractEvidenceWindows(blockquotes.length > 0 ? blockquotes : paragraphFallback, 28);

  const parts = [
    title ? `Title: ${title}` : "",
    courtName ? `Court: ${courtName}` : "",
    equivalentCitations ? `Equivalent citations: ${equivalentCitations}` : "",
    authorLine ? `Author: ${authorLine.replace(/^author:\s*/i, "")}` : "",
    benchLine ? `Bench: ${benchLine.replace(/^bench:\s*/i, "")}` : "",
    typeof citesCount === "number" ? `Cites count: ${citesCount}` : "",
    typeof citedByCount === "number" ? `Cited by count: ${citedByCount}` : "",
    evidenceWindows.length > 0 ? `Evidence windows:\n${evidenceWindows.join("\n")}` : "",
    blockquotes.length > 0
      ? `Body:\n${blockquotes.join("\n")}`
      : paragraphFallback.length > 0
        ? `Body:\n${paragraphFallback.join("\n")}`
        : "",
  ]
    .filter((v) => v.length > 0)
    .join("\n");

  return parts.slice(0, 12000);
}
