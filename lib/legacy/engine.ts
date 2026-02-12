import { buildKeywordPackWithAI } from "@/lib/ai-keyword-planner";
import { buildSearchInsights } from "@/lib/insights";
import { buildKeywordPack } from "@/lib/keywords";
import { classifyCandidates } from "@/lib/pipeline/classifier";
import { buildIntentProfile } from "@/lib/pipeline/intent";
import { verifyCandidates } from "@/lib/pipeline/verifier";
import { diversifyRankedCases } from "@/lib/ranking-diversity";
import { scoreCases } from "@/lib/scoring";
import { IndianKanoonFetchError, searchIndianKanoon } from "@/lib/source-indiankanoon";
import { CaseCandidate, SearchResponse } from "@/lib/types";

type LegacyDebug = {
  requestId: string;
  cleanedQuery: string;
  planner: {
    source: "bedrock" | "fallback";
    modelId?: string;
    error?: string;
  };
  phrases: string[];
  source: Array<{
    phrase: string;
    searchQuery?: string;
    status: number;
    ok: boolean;
    phase: string;
    parserMode?: string;
    pagesScanned?: number;
    pageCaseCounts?: number[];
    nextPageDetected?: boolean;
    rawParsedCount?: number;
    excludedStatuteCount?: number;
    excludedWeakCount?: number;
    cloudflareDetected: boolean;
    challengeDetected: boolean;
    parsedCount: number;
    htmlPreview?: string;
    error: string | null;
    variantId?: string;
  }>;
  courtBreakdown: {
    sc: number;
    hc: number;
    unknown: number;
  };
  phaseBreakdown: Record<string, number>;
  diagnostics: {
    challengeCount: number;
    rateLimitCount: number;
    noMatchCount: number;
    successCount: number;
    blockedState: boolean;
    stopReason: string;
    blockedReason?: string;
    skippedDuplicates: number;
    rejectionReasons: Record<string, number>;
  };
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dedupeCandidates(values: CaseCandidate[]): CaseCandidate[] {
  const seen = new Set<string>();
  const output: CaseCandidate[] = [];
  for (const value of values) {
    if (seen.has(value.url)) continue;
    seen.add(value.url);
    output.push(value);
  }
  return output;
}

function inferLegacyCourtType(phrase: string): "supremecourt" | "highcourts" | undefined {
  const lower = phrase.toLowerCase();
  if (lower.includes("supreme court")) return "supremecourt";
  if (lower.includes("high court")) return "highcourts";
  return undefined;
}

function stripCourtSuffix(phrase: string): string {
  return phrase.replace(/\b(supreme court|high court)\b/gi, " ").replace(/\s+/g, " ").trim();
}

export async function runLegacySearch(input: {
  query: string;
  maxResults: number;
  requestId: string;
  debugEnabled: boolean;
}): Promise<{ response: SearchResponse; debug?: LegacyDebug }> {
  const intent = buildIntentProfile(input.query);
  const deterministicPack = buildKeywordPack(intent.cleanedQuery, intent.context);
  const aiPlan = await buildKeywordPackWithAI(intent.cleanedQuery, intent.context, deterministicPack);
  const keywordPack = aiPlan.keywordPack;

  const phrases = unique([
    ...keywordPack.searchPhrases,
    ...keywordPack.primary.slice(0, 8),
    ...intent.context.issues.slice(0, 4),
  ])
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length >= 6)
    .slice(0, 12);

  const attempts: LegacyDebug["source"] = [];
  const candidates: CaseCandidate[] = [];
  let blockedCount = 0;
  let blockedReason: string | undefined;

  for (const phrase of phrases) {
    const courtType = inferLegacyCourtType(phrase);
    const searchPhrase = stripCourtSuffix(phrase);
    if (!searchPhrase) continue;

    try {
      const result = await searchIndianKanoon(searchPhrase, {
        maxResultsPerPhrase: 12,
        maxPages: 2,
        courtType,
        sortByMostRecent: true,
      });
      attempts.push({
        phrase,
        searchQuery: result.debug.searchQuery,
        status: result.debug.status,
        ok: result.debug.ok,
        phase: "legacy",
        parserMode: result.debug.parserMode,
        pagesScanned: result.debug.pagesScanned,
        pageCaseCounts: result.debug.pageCaseCounts,
        nextPageDetected: result.debug.nextPageDetected,
        rawParsedCount: result.debug.rawParsedCount,
        excludedStatuteCount: result.debug.excludedStatuteCount,
        excludedWeakCount: result.debug.excludedWeakCount,
        cloudflareDetected: result.debug.cloudflareDetected,
        challengeDetected: result.debug.challengeDetected,
        parsedCount: result.debug.parsedCount,
        htmlPreview: result.debug.htmlPreview,
        error: null,
      });
      candidates.push(...result.cases);
      if (result.debug.challengeDetected || result.debug.status === 429) {
        blockedCount += 1;
      } else {
        blockedCount = 0;
      }
    } catch (error) {
      if (error instanceof IndianKanoonFetchError) {
        attempts.push({
          phrase,
          searchQuery: error.debug.searchQuery,
          status: error.debug.status,
          ok: error.debug.ok,
          phase: "legacy",
          parserMode: error.debug.parserMode,
          pagesScanned: error.debug.pagesScanned,
          pageCaseCounts: error.debug.pageCaseCounts,
          nextPageDetected: error.debug.nextPageDetected,
          rawParsedCount: error.debug.rawParsedCount,
          excludedStatuteCount: error.debug.excludedStatuteCount,
          excludedWeakCount: error.debug.excludedWeakCount,
          cloudflareDetected: error.debug.cloudflareDetected,
          challengeDetected: error.debug.challengeDetected,
          parsedCount: error.debug.parsedCount,
          htmlPreview: error.debug.htmlPreview,
          error: error.message,
        });
        if (error.debug.challengeDetected || error.debug.status === 429) {
          blockedCount += 1;
        } else {
          blockedCount = 0;
        }
      } else {
        attempts.push({
          phrase,
          status: 500,
          ok: false,
          phase: "legacy",
          cloudflareDetected: false,
          challengeDetected: false,
          parsedCount: 0,
          error: error instanceof Error ? error.message : "Unknown source error",
        });
      }
    }

    if (blockedCount >= 3) {
      blockedReason = `legacy_blocked_threshold:${blockedCount}`;
      break;
    }
    await sleep(220 + Math.floor(Math.random() * 260));
  }

  const deduped = dedupeCandidates(candidates);
  const classified = classifyCandidates(deduped);
  const verified = await verifyCandidates(classified, 10);
  const rejectionReasons = verified.verified
    .filter((item) => item.classification.kind !== "case")
    .flatMap((item) => item.classification.reasons)
    .reduce<Record<string, number>>((acc, reason) => {
      acc[reason] = (acc[reason] ?? 0) + 1;
      return acc;
    }, {});

  const caseOnly = verified.verified
    .filter((item) => item.classification.kind === "case")
    .map((item) => {
      const { classification, ...candidate } = item;
      void classification;
      return candidate;
    });

  const courtFiltered = caseOnly.filter((item) => item.court === "SC" || item.court === "HC");
  const scored = scoreCases(input.query, intent.context, courtFiltered.length > 0 ? courtFiltered : caseOnly);
  const finalCases = diversifyRankedCases(scored).slice(0, input.maxResults);

  const response: SearchResponse = {
    requestId: input.requestId,
    query: input.query,
    context: intent.context,
    keywordPack,
    totalFetched: deduped.length,
    filteredCount: courtFiltered.length,
    cases: finalCases,
    insights: buildSearchInsights({
      context: intent.context,
      cases: finalCases,
      totalFetched: deduped.length,
      filteredCount: courtFiltered.length,
    }),
    notes: [
      "Legacy retrieval path is active (PIPELINE_V2=0).",
      "This tool does not bypass anti-bot systems and may return fewer results when blocked or throttled.",
      "Use this as research triage only. Validate every citation manually.",
    ],
  };

  if (!input.debugEnabled) {
    return { response };
  }

  const challengeCount = attempts.filter((attempt) => attempt.challengeDetected).length;
  const rateLimitCount = attempts.filter((attempt) => attempt.status === 429).length;
  const noMatchCount = attempts.filter((attempt) =>
    /no matching results/i.test(attempt.htmlPreview ?? ""),
  ).length;
  const successCount = attempts.filter((attempt) => attempt.ok && attempt.parsedCount > 0).length;

  return {
    response,
    debug: {
      requestId: input.requestId,
      cleanedQuery: intent.cleanedQuery,
      planner: {
        source: aiPlan.source,
        modelId: aiPlan.modelId,
        error: aiPlan.error,
      },
      phrases,
      source: attempts,
      courtBreakdown: {
        sc: deduped.filter((item) => item.court === "SC").length,
        hc: deduped.filter((item) => item.court === "HC").length,
        unknown: deduped.filter((item) => item.court === "UNKNOWN").length,
      },
      phaseBreakdown: { legacy: attempts.length },
      diagnostics: {
        challengeCount,
        rateLimitCount,
        noMatchCount,
        successCount,
        blockedState: Boolean(blockedReason),
        stopReason: blockedReason ? "blocked" : "legacy_completed",
        blockedReason,
        skippedDuplicates: 0,
        rejectionReasons,
      },
    },
  };
}
