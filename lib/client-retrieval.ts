import { parseIndianKanoonSearchPage } from "@/lib/indiankanoon-parser";
import { QueryVariant } from "@/lib/pipeline/types";
import { CaseCandidate } from "@/lib/types";

export type ClientProbeResult = {
  supported: boolean;
  reason?: string;
  checkedAt: number;
};

export type ClientRetrievalAttempt = {
  variantId: string;
  phrase: string;
  courtScope: QueryVariant["courtScope"];
  url: string;
  ok: boolean;
  status?: number;
  parsedCount: number;
  parserMode?: string;
  challenge?: boolean;
  noMatch?: boolean;
  error?: string;
  elapsedMs: number;
};

export type ClientRetrievalResult = {
  attempted: boolean;
  supported: boolean;
  succeeded: boolean;
  blockedKind?: "cloudflare_challenge" | "rate_limit" | "cors";
  retryAfterMs?: number;
  candidates: CaseCandidate[];
  attempts: ClientRetrievalAttempt[];
  reason?: string;
};

const PROBE_CACHE_KEY = "ik_client_probe_v1";
const DEFAULT_PROBE_TTL_MS = Number(process.env.NEXT_PUBLIC_CLIENT_DIRECT_PROBE_TTL_MS ?? "1800000");

function nowMs(): number {
  return Date.now();
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`client_timeout:${timeoutMs}`)), timeoutMs);
    task
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function normalizeQueryPhrase(phrase: string): string {
  return phrase
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(supreme court|high court)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchQuery(variant: QueryVariant): string {
  const phrase = normalizeQueryPhrase(variant.phrase);
  const parts: string[] = [];
  if (variant.courtScope === "SC") parts.push("doctypes:supremecourt");
  if (variant.courtScope === "HC") parts.push("doctypes:highcourts");
  parts.push(phrase);
  return parts.join(" ").trim();
}

function buildSearchUrl(variant: QueryVariant): string {
  return `https://indiankanoon.org/search/?formInput=${encodeURIComponent(buildSearchQuery(variant))}`;
}

function dedupeCandidates(candidates: CaseCandidate[]): CaseCandidate[] {
  const seen = new Set<string>();
  const out: CaseCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.url || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    out.push(candidate);
  }
  return out;
}

function readProbeCache(): ClientProbeResult | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(PROBE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClientProbeResult;
    if (!parsed || typeof parsed.checkedAt !== "number") return null;
    if (nowMs() - parsed.checkedAt > Math.max(30_000, DEFAULT_PROBE_TTL_MS)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeProbeCache(value: ClientProbeResult): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(PROBE_CACHE_KEY, JSON.stringify(value));
  } catch {
    // ignore storage failures
  }
}

export async function probeClientDirectRetrieval(force = false): Promise<ClientProbeResult> {
  if (typeof window === "undefined") {
    return { supported: false, reason: "server_context", checkedAt: nowMs() };
  }

  if (!force) {
    const cached = readProbeCache();
    if (cached) return cached;
  }

  const probeUrl = "https://indiankanoon.org/search/?formInput=criminal%20appeal";
  const startedAt = nowMs();
  try {
    const response = await withTimeout(
      fetch(probeUrl, {
        method: "GET",
        cache: "no-store",
      }),
      3200,
    );

    const html = await withTimeout(response.text(), 1800);
    const parsed = parseIndianKanoonSearchPage(html);

    if (response.status === 429 || parsed.challenge) {
      const result: ClientProbeResult = {
        supported: false,
        reason: response.status === 429 ? "rate_limit" : "cloudflare_challenge",
        checkedAt: startedAt,
      };
      writeProbeCache(result);
      return result;
    }

    const result: ClientProbeResult = {
      supported: response.ok,
      reason: response.ok ? undefined : `http_${response.status}`,
      checkedAt: startedAt,
    };
    writeProbeCache(result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "client_probe_failed";
    const result: ClientProbeResult = {
      supported: false,
      reason: /Failed to fetch|network|cors/i.test(message) ? "cors_or_network" : message,
      checkedAt: startedAt,
    };
    writeProbeCache(result);
    return result;
  }
}

export async function runClientDirectRetrieval(input: {
  variants: QueryVariant[];
  maxVariants: number;
  fetchTimeoutMs?: number;
}): Promise<ClientRetrievalResult> {
  const probe = await probeClientDirectRetrieval();
  if (!probe.supported) {
    return {
      attempted: false,
      supported: false,
      succeeded: false,
      blockedKind: /challenge/i.test(probe.reason ?? "") ? "cloudflare_challenge" : undefined,
      candidates: [],
      attempts: [],
      reason: probe.reason ?? "probe_not_supported",
    };
  }

  const selected = input.variants
    .filter((variant) => variant.strictness === "strict")
    .slice(0, Math.max(1, input.maxVariants));

  const attempts: ClientRetrievalAttempt[] = [];
  const candidates: CaseCandidate[] = [];
  const timeoutMs = Math.max(2200, Math.min(input.fetchTimeoutMs ?? 3800, 7000));

  for (const variant of selected) {
    const url = buildSearchUrl(variant);
    const started = nowMs();
    try {
      const response = await withTimeout(
        fetch(url, {
          method: "GET",
          cache: "no-store",
        }),
        timeoutMs,
      );
      const html = await withTimeout(response.text(), Math.max(1400, timeoutMs - 800));
      const parsed = parseIndianKanoonSearchPage(html);
      const cleaned = parsed.rawCases.filter((item) => item.url.includes("indiankanoon.org/doc"));
      candidates.push(...cleaned);

      attempts.push({
        variantId: variant.id,
        phrase: variant.phrase,
        courtScope: variant.courtScope,
        url,
        ok: response.ok,
        status: response.status,
        parsedCount: cleaned.length,
        parserMode: parsed.parserMode,
        challenge: parsed.challenge,
        noMatch: parsed.noMatch,
        elapsedMs: nowMs() - started,
      });

      if (response.status === 429 || parsed.challenge) {
        return {
          attempted: true,
          supported: true,
          succeeded: false,
          blockedKind: response.status === 429 ? "rate_limit" : "cloudflare_challenge",
          retryAfterMs: 30_000,
          candidates: dedupeCandidates(candidates),
          attempts,
          reason: response.status === 429 ? "rate_limit" : "challenge_detected",
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "client_fetch_error";
      attempts.push({
        variantId: variant.id,
        phrase: variant.phrase,
        courtScope: variant.courtScope,
        url,
        ok: false,
        parsedCount: 0,
        error: message,
        elapsedMs: nowMs() - started,
      });

      return {
        attempted: true,
        supported: true,
        succeeded: false,
        blockedKind: /Failed to fetch|cors/i.test(message) ? "cors" : undefined,
        candidates: dedupeCandidates(candidates),
        attempts,
        reason: message,
      };
    }
  }

  const deduped = dedupeCandidates(candidates);
  return {
    attempted: true,
    supported: true,
    succeeded: deduped.length > 0,
    candidates: deduped,
    attempts,
    reason: deduped.length > 0 ? "client_direct_success" : "no_candidates",
  };
}
