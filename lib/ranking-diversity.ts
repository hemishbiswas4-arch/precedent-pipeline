import { ScoredCase } from "@/lib/types";

const LEGAL_CORE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "under",
  "where",
  "when",
  "case",
  "appeal",
  "application",
  "filed",
  "state",
  "order",
  "court",
  "high",
  "supreme",
  "condonation",
  "delay",
]);

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bon\s+\d{1,2}\s+[a-z]{3,9},?\s+\d{4}\b/g, " ")
    .replace(/\bvs\.?\b/g, " v ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDateLabel(title: string): string | null {
  const match = title.match(/\bon\s+(\d{1,2}\s+[a-z]{3,9},?\s+\d{4})\b/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function extractDocId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/(?:doc|docfragment)\/(\d+)\/?/i);
  return match?.[1] ?? null;
}

function extractEquivalentCitationKey(detailText: string | undefined): string | null {
  if (!detailText) return null;
  const match = detailText.match(/^Equivalent citations:\s*(.+)$/im);
  if (!match?.[1]) return null;

  let normalized = match[1].trim();
  while (/^equivalent citations:\s*/i.test(normalized)) {
    normalized = normalized.replace(/^equivalent citations:\s*/i, "").trim();
  }

  const compact = normalizeText(normalized).replace(/\s+/g, "");
  if (compact.length < 8) return null;
  return `eq:${compact.slice(0, 180)}`;
}

function detailBodySeed(detailText: string | undefined): string {
  if (!detailText) return "";
  const match = detailText.match(/Body:\s*([\s\S]+)/i);
  const source = (match?.[1] ?? detailText).slice(0, 1000);
  return normalizeText(source).slice(0, 280);
}

function legalCoreSeed(item: ScoredCase): string {
  const raw = `${item.snippet} ${item.detailText ?? ""}`;
  const tokens = normalizeText(raw)
    .split(/\s+/)
    .filter((token) => token.length > 4 && !LEGAL_CORE_STOPWORDS.has(token))
    .slice(0, 28);
  return [...new Set(tokens)].slice(0, 14).join(" ");
}

function contentIdentityKey(item: ScoredCase): string | null {
  const dateLabel = extractDateLabel(item.title) ?? "unknown";
  const snippetSeed = normalizeText(item.snippet).slice(0, 220);
  const bodySeed = detailBodySeed(item.detailText);
  const seed = bodySeed.length >= 80 ? bodySeed : snippetSeed;
  if (seed.length < 60) return null;
  return `content:${item.court}:${dateLabel}:${seed}`;
}

function legalCoreIdentityKey(item: ScoredCase): string | null {
  const dateLabel = extractDateLabel(item.title) ?? "unknown";
  const core = legalCoreSeed(item);
  if (core.length < 30) return null;
  return `core:${item.court}:${dateLabel}:${core}`;
}

function fingerprint(item: ScoredCase): string {
  const base = `${normalizeText(item.title)} ${normalizeText(item.snippet).slice(0, 220)}`;
  return base.slice(0, 280);
}

function identityKeys(item: ScoredCase): string[] {
  const keys: string[] = [];
  const equivalent = extractEquivalentCitationKey(item.detailText);
  if (equivalent) keys.push(equivalent);
  if (item.retrieval?.semanticHash) keys.push(`sem:${item.retrieval.semanticHash}`);

  const primaryDocId = extractDocId(item.url);
  if (primaryDocId) keys.push(`doc:${primaryDocId}`);

  const fullDocId = extractDocId(item.fullDocumentUrl);
  if (fullDocId) keys.push(`doc:${fullDocId}`);

  const contentKey = contentIdentityKey(item);
  if (contentKey) keys.push(contentKey);
  const coreKey = legalCoreIdentityKey(item);
  if (coreKey) keys.push(coreKey);

  return [...new Set(keys)];
}

export function diversifyRankedCases(
  items: ScoredCase[],
  options?: {
    maxPerFingerprint?: number;
    maxPerCourtDay?: number;
  },
): ScoredCase[] {
  const maxPerFingerprint = Math.max(1, options?.maxPerFingerprint ?? 1);
  const maxPerCourtDay = Math.max(1, options?.maxPerCourtDay ?? 2);

  const kept: ScoredCase[] = [];
  const fingerprintCount = new Map<string, number>();
  const courtDayCount = new Map<string, number>();
  const seenIdentity = new Set<string>();

  for (const item of items) {
    const itemKeys = identityKeys(item);
    if (itemKeys.some((key) => seenIdentity.has(key))) {
      continue;
    }

    const sig = fingerprint(item);
    const existingFingerprint = fingerprintCount.get(sig) ?? 0;
    if (existingFingerprint >= maxPerFingerprint) {
      continue;
    }

    const dateLabel = extractDateLabel(item.title) ?? "unknown";
    const courtDayKey = `${item.court}:${dateLabel}`;
    const existingCourtDay = courtDayCount.get(courtDayKey) ?? 0;
    if (existingCourtDay >= maxPerCourtDay) {
      continue;
    }

    kept.push(item);
    fingerprintCount.set(sig, existingFingerprint + 1);
    courtDayCount.set(courtDayKey, existingCourtDay + 1);
    for (const key of itemKeys) {
      seenIdentity.add(key);
    }
  }

  return kept;
}
