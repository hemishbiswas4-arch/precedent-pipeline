import { createHash } from "crypto";
import { sharedCache } from "@/lib/cache/shared-cache";
import { NearMissCase, ScoredCase } from "@/lib/types";

export type RecallSignatureLevel = "exact" | "full" | "medium" | "broad";

type SignatureInput = {
  query: string;
  actors: string[];
  procedures: string[];
  statutes: string[];
  issues: string[];
  domains: string[];
};

type SignatureBundle = {
  exactHash: string;
  fullTokens: string[];
  mediumTokens: string[];
  broadTokens: string[];
};

type StoredRecallEntry = {
  version: "v1";
  savedAt: number;
  exactHash: string;
  signatures: {
    full: string[];
    medium: string[];
    broad: string[];
  };
  cases: NearMissCase[];
  tierCounts?: {
    exactStrict: number;
    exactProvisional: number;
    exploratory: number;
  };
};

type RecentIndex = {
  hashes: string[];
  updatedAt: number;
};

const ALWAYS_RETURN_V1_ENABLED = parseBooleanEnv(process.env.ALWAYS_RETURN_V1, true);
const STALE_FALLBACK_ENABLED = parseBooleanEnv(process.env.STALE_FALLBACK_ENABLED, true);
const STALE_FALLBACK_TTL_SEC = Math.max(
  3_600,
  Math.min(Number(process.env.STALE_FALLBACK_TTL_SEC ?? "86400"), 7 * 86_400),
);
const EXPLORATORY_CONFIDENCE_CAP = Math.min(
  0.55,
  Math.max(Number(process.env.EXPLORATORY_CONFIDENCE_CAP ?? "0.45"), 0.3),
);
const MIN_SIGNATURE_TOKEN_LENGTH = 2;
const MAX_RECENT_HASHES = 120;
const MAX_STORED_CASES = 12;
const RECENT_INDEX_KEY = "fallback_recall:v1:recent";
const ENTRY_KEY_PREFIX = "fallback_recall:v1:entry:";

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return fallback;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= MIN_SIGNATURE_TOKEN_LENGTH);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function hashedTokens(values: string[]): string[] {
  return unique(values.map((value) => value.trim()).filter(Boolean).map(hashToken)).sort();
}

function extractQueryFallbackTokens(query: string, limit: number): string[] {
  return tokenize(query).slice(0, limit);
}

function buildSignatureBundle(input: SignatureInput): SignatureBundle {
  const exactHash = hashText(normalizeText(input.query));

  const fullRaw = [
    ...input.actors.flatMap(tokenize),
    ...input.procedures.flatMap(tokenize),
    ...input.statutes.flatMap(tokenize),
    ...input.issues.flatMap(tokenize),
    ...extractQueryFallbackTokens(input.query, 8),
  ];
  const mediumRaw = [
    ...input.procedures.flatMap(tokenize),
    ...input.statutes.flatMap(tokenize),
    ...input.domains.flatMap(tokenize),
    ...extractQueryFallbackTokens(input.query, 6),
  ];
  const broadRaw = [
    ...input.domains.flatMap(tokenize),
    ...input.issues.flatMap(tokenize),
    ...extractQueryFallbackTokens(input.query, 4),
  ];

  const fullTokens = hashedTokens(fullRaw);
  const mediumTokens = hashedTokens(mediumRaw.length > 0 ? mediumRaw : fullRaw);
  const broadTokens = hashedTokens(broadRaw.length > 0 ? broadRaw : mediumRaw.length > 0 ? mediumRaw : fullRaw);

  return {
    exactHash,
    fullTokens,
    mediumTokens,
    broadTokens,
  };
}

function entryKey(hash: string): string {
  return `${ENTRY_KEY_PREFIX}${hash}`;
}

function jaccardScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  const union = leftSet.size + rightSet.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function capExploratoryConfidence(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return EXPLORATORY_CONFIDENCE_CAP;
  return Number(Math.min(Math.max(value, 0), EXPLORATORY_CONFIDENCE_CAP).toFixed(3));
}

function exploratoryBand(value: number): "LOW" | "MEDIUM" {
  return value >= 0.41 ? "MEDIUM" : "LOW";
}

function toNearMissCase(item: NearMissCase | ScoredCase): NearMissCase {
  const missingElements = "missingElements" in item && Array.isArray(item.missingElements)
    ? item.missingElements
    : item.gapSummary ?? item.missingCoreElements ?? [];
  const confidenceScore = capExploratoryConfidence(item.confidenceScore ?? item.score);

  return {
    ...item,
    score: confidenceScore,
    confidenceScore,
    confidenceBand: exploratoryBand(confidenceScore),
    retrievalTier: "exploratory",
    fallbackReason: item.fallbackReason ?? "none",
    gapSummary: item.gapSummary ?? missingElements,
    missingElements,
  };
}

function markStaleFallbackCase(item: NearMissCase): NearMissCase {
  const confidenceScore = capExploratoryConfidence(item.confidenceScore ?? item.score);
  return {
    ...item,
    score: confidenceScore,
    confidenceScore,
    confidenceBand: exploratoryBand(confidenceScore),
    retrievalTier: "exploratory",
    fallbackReason: "stale_cache",
    gapSummary: item.gapSummary ?? item.missingElements ?? [],
    missingElements: item.missingElements ?? item.gapSummary ?? [],
  };
}

async function loadRecentIndex(): Promise<RecentIndex> {
  const cached = await sharedCache.getJson<RecentIndex>(RECENT_INDEX_KEY);
  if (!cached || !Array.isArray(cached.hashes)) {
    return { hashes: [], updatedAt: Date.now() };
  }
  return {
    hashes: cached.hashes.filter((hash) => typeof hash === "string" && hash.length > 0).slice(0, MAX_RECENT_HASHES),
    updatedAt: cached.updatedAt ?? Date.now(),
  };
}

async function saveRecentIndex(index: RecentIndex): Promise<void> {
  await sharedCache.setJson(
    RECENT_INDEX_KEY,
    {
      hashes: index.hashes.slice(0, MAX_RECENT_HASHES),
      updatedAt: Date.now(),
    } satisfies RecentIndex,
    STALE_FALLBACK_TTL_SEC,
  );
}

async function readEntry(hash: string): Promise<StoredRecallEntry | null> {
  if (!hash) return null;
  const entry = await sharedCache.getJson<StoredRecallEntry>(entryKey(hash));
  if (!entry || entry.version !== "v1" || !Array.isArray(entry.cases)) {
    return null;
  }
  return entry;
}

export async function saveFallbackRecallEntry(input: {
  query: string;
  actors: string[];
  procedures: string[];
  statutes: string[];
  issues: string[];
  domains: string[];
  cases: Array<NearMissCase | ScoredCase>;
  tierCounts?: {
    exactStrict: number;
    exactProvisional: number;
    exploratory: number;
  };
}): Promise<void> {
  if (!ALWAYS_RETURN_V1_ENABLED || !STALE_FALLBACK_ENABLED) return;
  if (!input.query.trim() || input.cases.length === 0) return;

  const signatures = buildSignatureBundle({
    query: input.query,
    actors: input.actors,
    procedures: input.procedures,
    statutes: input.statutes,
    issues: input.issues,
    domains: input.domains,
  });

  const cases = input.cases
    .map(toNearMissCase)
    .filter((item) => item.court === "SC" || item.court === "HC")
    .slice(0, MAX_STORED_CASES);
  if (cases.length === 0) return;

  const payload: StoredRecallEntry = {
    version: "v1",
    savedAt: Date.now(),
    exactHash: signatures.exactHash,
    signatures: {
      full: signatures.fullTokens,
      medium: signatures.mediumTokens,
      broad: signatures.broadTokens,
    },
    cases,
    tierCounts: input.tierCounts,
  };

  await sharedCache.setJson(entryKey(signatures.exactHash), payload, STALE_FALLBACK_TTL_SEC);

  const recent = await loadRecentIndex();
  const nextHashes = [signatures.exactHash, ...recent.hashes.filter((hash) => hash !== signatures.exactHash)];
  await saveRecentIndex({
    hashes: nextHashes.slice(0, MAX_RECENT_HASHES),
    updatedAt: Date.now(),
  });
}

export async function lookupFallbackRecallEntry(input: {
  query: string;
  actors: string[];
  procedures: string[];
  statutes: string[];
  issues: string[];
  domains: string[];
  maxCases: number;
  minSimilarity?: number;
}): Promise<{
  signatureLevel: RecallSignatureLevel;
  similarity: number;
  cases: NearMissCase[];
} | null> {
  if (!ALWAYS_RETURN_V1_ENABLED || !STALE_FALLBACK_ENABLED) return null;
  if (!input.query.trim()) return null;

  const minSimilarity = Math.max(0, Math.min(input.minSimilarity ?? 0.55, 1));
  const signatures = buildSignatureBundle({
    query: input.query,
    actors: input.actors,
    procedures: input.procedures,
    statutes: input.statutes,
    issues: input.issues,
    domains: input.domains,
  });

  const exactEntry = await readEntry(signatures.exactHash);
  if (exactEntry && exactEntry.cases.length > 0) {
    return {
      signatureLevel: "exact",
      similarity: 1,
      cases: exactEntry.cases.map(markStaleFallbackCase).slice(0, Math.max(1, input.maxCases)),
    };
  }

  const recent = await loadRecentIndex();
  if (recent.hashes.length === 0) return null;

  let bestFull: { score: number; entry: StoredRecallEntry } | null = null;
  let bestMedium: { score: number; entry: StoredRecallEntry } | null = null;
  let bestBroad: { score: number; entry: StoredRecallEntry } | null = null;

  for (const hash of recent.hashes.slice(0, MAX_RECENT_HASHES)) {
    const entry = await readEntry(hash);
    if (!entry) continue;
    const fullScore = jaccardScore(signatures.fullTokens, entry.signatures.full);
    const mediumScore = jaccardScore(signatures.mediumTokens, entry.signatures.medium);
    const broadScore = jaccardScore(signatures.broadTokens, entry.signatures.broad);

    if (!bestFull || fullScore > bestFull.score) {
      bestFull = { score: fullScore, entry };
    }
    if (!bestMedium || mediumScore > bestMedium.score) {
      bestMedium = { score: mediumScore, entry };
    }
    if (!bestBroad || broadScore > bestBroad.score) {
      bestBroad = { score: broadScore, entry };
    }
  }

  const levelCandidates: Array<{
    level: RecallSignatureLevel;
    score: number;
    entry: StoredRecallEntry;
  }> = [];
  if (bestFull) levelCandidates.push({ level: "full", score: bestFull.score, entry: bestFull.entry });
  if (bestMedium) levelCandidates.push({ level: "medium", score: bestMedium.score, entry: bestMedium.entry });
  if (bestBroad) levelCandidates.push({ level: "broad", score: bestBroad.score, entry: bestBroad.entry });

  const orderedLevels: RecallSignatureLevel[] = ["full", "medium", "broad"];
  for (const level of orderedLevels) {
    const candidate = levelCandidates.find((item) => item.level === level);
    if (!candidate) continue;
    if (candidate.score < minSimilarity) continue;
    if (candidate.entry.cases.length === 0) continue;
    return {
      signatureLevel: level,
      similarity: Number(candidate.score.toFixed(3)),
      cases: candidate.entry.cases.map(markStaleFallbackCase).slice(0, Math.max(1, input.maxCases)),
    };
  }

  return null;
}
