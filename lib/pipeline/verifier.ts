import { fetchIndianKanoonCaseDetail } from "@/lib/source-indiankanoon";
import { ClassifiedCandidate, VerificationSummary } from "@/lib/pipeline/types";
import { classifyCandidate } from "@/lib/pipeline/classifier";
import { CourtLevel } from "@/lib/types";

const VERIFY_CONCURRENCY = Math.max(1, Math.min(Number(process.env.VERIFY_CONCURRENCY ?? "4"), 6));
const VERIFY_DETAIL_TIMEOUT_MS = Math.max(
  1_800,
  Math.min(Number(process.env.VERIFY_DETAIL_TIMEOUT_MS ?? "2200"), 8_000),
);
const VERIFY_DETAIL_CACHE_TTL_MS = Math.max(
  60_000,
  Math.min(Number(process.env.VERIFY_DETAIL_CACHE_TTL_MS ?? "300000"), 1_800_000),
);

type CachedDetail = {
  title: string;
  court: CourtLevel;
  detailText?: string;
  evidenceQuality?: {
    hasRelationSentence: boolean;
    hasPolaritySentence: boolean;
    hasHookIntersectionSentence: boolean;
    hasRoleSentence?: boolean;
    hasChainSentence?: boolean;
  };
  fetchedAt: number;
};

const detailCache = new Map<string, CachedDetail>();

function extractLineField(detailText: string, prefix: string): string | undefined {
  const pattern = new RegExp(`^${prefix}:\\s*(.+)$`, "im");
  const match = detailText.match(pattern);
  return match?.[1]?.trim();
}

function inferCourtFromText(value: string | undefined): CourtLevel | undefined {
  if (!value) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (lower.includes("supreme court")) return "SC";
  if (lower.includes("high court")) return "HC";
  return undefined;
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

export async function verifyCandidates(
  candidates: ClassifiedCandidate[],
  limit: number,
): Promise<{ verified: ClassifiedCandidate[]; summary: VerificationSummary }> {
  const verified: ClassifiedCandidate[] = [];
  let detailFetched = 0;
  const verifyPool = candidates.slice(0, limit);
  const rest = candidates.slice(limit);

  const resolved = new Array<ClassifiedCandidate>(verifyPool.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= verifyPool.length) return;
      const candidate = verifyPool[index];
      let current = candidate;
      try {
        const cached = detailCache.get(candidate.url);
        if (cached && Date.now() - cached.fetchedAt <= VERIFY_DETAIL_CACHE_TTL_MS) {
          current = {
            ...candidate,
            title: cached.title,
            court: cached.court,
            detailText: cached.detailText,
            evidenceQuality: cached.evidenceQuality,
          };
        } else {
          const detailText = await fetchIndianKanoonCaseDetail(candidate.url, {
            fetchTimeoutMs: VERIFY_DETAIL_TIMEOUT_MS,
            max429Retries: 0,
            maxRetryAfterMs: 1200,
          });
          detailFetched += 1;
          const detailLooksInvalid = isLikelySearchPageDetail(detailText);
          const normalizedTitle = extractLineField(detailText, "Title");
          const normalizedCourt = inferCourtFromText(extractLineField(detailText, "Court"));
          const safeTitle =
            normalizedTitle && !isPseudoTitle(normalizedTitle) ? normalizedTitle : candidate.title;
          current = {
            ...candidate,
            title: safeTitle,
            court: normalizedCourt || candidate.court,
            detailText: detailLooksInvalid ? undefined : detailText,
            evidenceQuality: detailLooksInvalid ? undefined : detectEvidenceQuality(detailText),
          };
          detailCache.set(candidate.url, {
            title: current.title,
            court: current.court,
            detailText: current.detailText,
            evidenceQuality: current.evidenceQuality,
            fetchedAt: Date.now(),
          });
        }
      } catch {
        // keep candidate as-is
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

  return {
    verified: combined,
    summary: {
      attempted: verifyPool.length,
      detailFetched,
      passedCaseGate,
    },
  };
}
