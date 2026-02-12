import { PHASE_LIMITS } from "@/lib/kb/query-templates";
import { IndianKanoonFetchError, searchIndianKanoon } from "@/lib/source-indiankanoon";
import { classifyCandidate } from "@/lib/pipeline/classifier";
import {
  IntentProfile,
  QueryPhase,
  QueryVariant,
  SchedulerCarryState,
  SchedulerConfig,
  SchedulerResult,
} from "@/lib/pipeline/types";
import { CaseCandidate } from "@/lib/types";

const ATTEMPT_FETCH_TIMEOUT_CAP_MS = Math.max(
  1_400,
  Number(process.env.ATTEMPT_FETCH_TIMEOUT_CAP_MS ?? "3500"),
);
const PRIMARY_MAX_PAGES = Math.max(1, Math.min(Number(process.env.PRIMARY_MAX_PAGES ?? "1"), 2));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function phraseForStructuredSearch(phrase: string): string {
  const stripped = phrase
    .replace(/\b(supreme court|high court|judgment)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) {
    return "";
  }
  const tokens = stripped.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return `${tokens[0]} judgment`;
  }
  return stripped;
}

function courtTypeForVariant(variant: QueryVariant): "supremecourt" | "highcourts" | undefined {
  if (variant.courtScope === "SC") return "supremecourt";
  if (variant.courtScope === "HC") return "highcourts";
  return undefined;
}

function querySignature(
  phase: QueryPhase,
  phrase: string,
  courtType: string | undefined,
  fromDate: string | undefined,
  toDate: string | undefined,
): string {
  return [phase, phrase.toLowerCase(), courtType ?? "", fromDate ?? "", toDate ?? ""].join("|");
}

function dedupeCases(cases: CaseCandidate[]): CaseCandidate[] {
  const seen = new Set<string>();
  const output: CaseCandidate[] = [];
  for (const item of cases) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      output.push(item);
    }
  }
  return output;
}

function buildCarryState(input: {
  startedAtMs: number;
  seenSignatures: Set<string>;
  attemptsUsed: number;
  skippedDuplicates: number;
  blockedCount: number;
  blockedReason?: string;
  blockedKind?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
  retryAfterMs?: number;
  attempts: SchedulerResult["attempts"];
  candidates: CaseCandidate[];
}): SchedulerCarryState {
  return {
    startedAtMs: input.startedAtMs,
    seenSignatures: Array.from(input.seenSignatures),
    attemptsUsed: input.attemptsUsed,
    skippedDuplicates: input.skippedDuplicates,
    blockedCount: input.blockedCount,
    blockedReason: input.blockedReason,
    blockedKind: input.blockedKind,
    retryAfterMs: input.retryAfterMs,
    attempts: input.attempts,
    candidates: dedupeCases(input.candidates),
  };
}

function buildResult(input: {
  startedAtMs: number;
  seenSignatures: Set<string>;
  attemptsUsed: number;
  skippedDuplicates: number;
  blockedCount: number;
  blockedReason?: string;
  blockedKind?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
  retryAfterMs?: number;
  attempts: SchedulerResult["attempts"];
  candidates: CaseCandidate[];
  stopReason: SchedulerResult["stopReason"];
}): SchedulerResult {
  const deduped = dedupeCases(input.candidates);
  return {
    attempts: input.attempts,
    skippedDuplicates: input.skippedDuplicates,
    stopReason: input.stopReason,
    blockedCount: input.blockedCount,
    blockedReason: input.blockedReason,
    blockedKind: input.blockedKind,
    retryAfterMs: input.retryAfterMs,
    candidates: deduped,
    carryState: buildCarryState({
      startedAtMs: input.startedAtMs,
      seenSignatures: input.seenSignatures,
      attemptsUsed: input.attemptsUsed,
      skippedDuplicates: input.skippedDuplicates,
      blockedCount: input.blockedCount,
      blockedReason: input.blockedReason,
      blockedKind: input.blockedKind,
      retryAfterMs: input.retryAfterMs,
      attempts: input.attempts,
      candidates: deduped,
    }),
  };
}

export async function runRetrievalSchedule(input: {
  variants: QueryVariant[];
  intent: IntentProfile;
  config: SchedulerConfig;
  carryState?: SchedulerCarryState;
  cooldownScope?: string;
}): Promise<SchedulerResult> {
  const { variants, intent, config, carryState, cooldownScope } = input;
  const seenSignatures = new Set<string>(carryState?.seenSignatures ?? []);
  const attempts: SchedulerResult["attempts"] = [...(carryState?.attempts ?? [])];
  const allCandidates: CaseCandidate[] = [...(carryState?.candidates ?? [])];
  let skippedDuplicates = carryState?.skippedDuplicates ?? 0;
  let blockedCount = carryState?.blockedCount ?? 0;
  let blockedReason = carryState?.blockedReason;
  let blockedKind = carryState?.blockedKind;
  let retryAfterMs = carryState?.retryAfterMs;
  let stopReason: SchedulerResult["stopReason"] = "completed";
  let attemptsUsed = carryState?.attemptsUsed ?? attempts.length;
  const startedAt = carryState?.startedAtMs ?? Date.now();

  const variantsByPhase = variants.reduce<Record<QueryPhase, QueryVariant[]>>(
    (acc, variant) => {
      acc[variant.phase].push(variant);
      return acc;
    },
    { primary: [], fallback: [], rescue: [], micro: [], revolving: [], browse: [] },
  );

  const orderedPhases: QueryPhase[] = ["primary", "fallback", "rescue", "micro", "revolving", "browse"];
  for (const phase of orderedPhases) {
    const phaseVariants = variantsByPhase[phase].slice(0, config.phaseLimits[phase] ?? PHASE_LIMITS[phase]);
    for (const variant of phaseVariants) {
      if (Date.now() - startedAt >= config.maxElapsedMs) {
        stopReason = "budget_exhausted";
        blockedReason = `time_budget_exhausted:${config.maxElapsedMs}`;
        return buildResult({
          startedAtMs: startedAt,
          attempts,
          skippedDuplicates,
          stopReason,
          blockedCount,
          blockedReason,
          blockedKind,
          retryAfterMs,
          candidates: allCandidates,
          seenSignatures,
          attemptsUsed,
        });
      }

      if (attemptsUsed >= config.globalBudget) {
        stopReason = "budget_exhausted";
        return buildResult({
          startedAtMs: startedAt,
          attempts,
          skippedDuplicates,
          stopReason,
          blockedCount,
          blockedReason,
          blockedKind,
          retryAfterMs,
          candidates: allCandidates,
          seenSignatures,
          attemptsUsed,
        });
      }

      const shouldRelax =
        phase === "rescue" || phase === "micro" || phase === "revolving" || phase === "browse";
      const courtType = shouldRelax ? undefined : courtTypeForVariant(variant);
      const fromDate = shouldRelax ? undefined : intent.dateWindow.fromDate;
      const toDate = shouldRelax ? undefined : intent.dateWindow.toDate;
      const phrase = phraseForStructuredSearch(variant.phrase);
      if (!phrase) {
        continue;
      }

      const signature = querySignature(phase, phrase, courtType, fromDate, toDate);
      if (seenSignatures.has(signature)) {
        skippedDuplicates += 1;
        continue;
      }
      seenSignatures.add(signature);
      attemptsUsed += 1;

      const elapsedBeforeAttempt = Date.now() - startedAt;
      const remainingBeforeAttempt = Math.max(0, config.maxElapsedMs - elapsedBeforeAttempt);
      if (remainingBeforeAttempt < 900) {
        stopReason = "budget_exhausted";
        blockedReason = `time_budget_exhausted:${config.maxElapsedMs}`;
        return buildResult({
          startedAtMs: startedAt,
          attempts,
          skippedDuplicates,
          stopReason,
          blockedCount,
          blockedReason,
          blockedKind,
          retryAfterMs,
          candidates: allCandidates,
          seenSignatures,
          attemptsUsed,
        });
      }

      const perAttemptTimeoutMs = Math.max(
        1_500,
        Math.min(
          config.fetchTimeoutMs ?? 8_000,
          ATTEMPT_FETCH_TIMEOUT_CAP_MS,
          remainingBeforeAttempt - 350,
        ),
      );
      const perAttemptCrawlBudgetMs = Math.max(
        1_800,
        Math.min(remainingBeforeAttempt - 150, perAttemptTimeoutMs + 800),
      );
      const dynamicMax429Retries =
        remainingBeforeAttempt < perAttemptTimeoutMs + 3_000 ? 0 : (config.max429Retries ?? 1);
      let delayMs = 80 + Math.floor(Math.random() * 80);
      try {
        const result = await searchIndianKanoon(phrase, {
          maxResultsPerPhrase: 14,
          maxPages: phase === "primary" ? PRIMARY_MAX_PAGES : 1,
          courtHint: variant.courtScope === "SC" ? "SC" : variant.courtScope === "HC" ? "HC" : "UNKNOWN",
          courtType,
          fromDate,
          toDate,
          sortByMostRecent: false,
          crawlMaxElapsedMs: perAttemptCrawlBudgetMs,
          fetchTimeoutMs: perAttemptTimeoutMs,
          max429Retries: dynamicMax429Retries,
          maxRetryAfterMs: config.maxRetryAfterMs,
          cooldownScope,
        });

        attempts.push({
          phase,
          variantId: variant.id,
          phrase: variant.phrase,
          searchQuery: result.debug.searchQuery,
          status: result.debug.status,
          ok: result.debug.ok,
          parsedCount: result.debug.parsedCount,
          parserMode: result.debug.parserMode,
          pagesScanned: result.debug.pagesScanned,
          pageCaseCounts: result.debug.pageCaseCounts,
          nextPageDetected: result.debug.nextPageDetected,
          rawParsedCount: result.debug.rawParsedCount,
          excludedStatuteCount: result.debug.excludedStatuteCount,
          excludedWeakCount: result.debug.excludedWeakCount,
          cloudflareDetected: result.debug.cloudflareDetected,
          challengeDetected: result.debug.challengeDetected,
          cooldownActive: result.debug.cooldownActive,
          retryAfterMs: result.debug.retryAfterMs,
          blockedType: result.debug.blockedType,
          timedOut: result.debug.timedOut,
          fetchTimeoutMsUsed: result.debug.fetchTimeoutMsUsed,
          htmlPreview: result.debug.htmlPreview,
          error: null,
        });

        allCandidates.push(...result.cases);
        if (result.debug.blockedType === "local_cooldown") {
          stopReason = "blocked";
          blockedKind = "local_cooldown";
          retryAfterMs = result.debug.retryAfterMs;
          blockedReason = `blocked_cooldown_active:${Math.max(
            1,
            Math.ceil((result.debug.retryAfterMs ?? 1000) / 1000),
          )}`;
          return buildResult({
            startedAtMs: startedAt,
            attempts,
            skippedDuplicates,
            stopReason,
            blockedCount: blockedCount + 1,
            blockedReason,
            blockedKind,
            retryAfterMs,
            candidates: allCandidates,
            seenSignatures,
            attemptsUsed,
          });
        }
        if (result.debug.challengeDetected || result.debug.status === 429) {
          blockedCount += 1;
          blockedKind = result.debug.blockedType ?? (result.debug.challengeDetected ? "cloudflare_challenge" : "rate_limit");
          retryAfterMs = result.debug.retryAfterMs;
          delayMs = 220 + Math.floor(Math.random() * 180);
        } else {
          blockedCount = 0;
          blockedReason = undefined;
          blockedKind = undefined;
          retryAfterMs = undefined;
        }
      } catch (error) {
        if (error instanceof IndianKanoonFetchError) {
          attempts.push({
            phase,
            variantId: variant.id,
            phrase: variant.phrase,
            searchQuery: error.debug.searchQuery,
            status: error.debug.status,
            ok: error.debug.ok,
            parsedCount: error.debug.parsedCount,
            parserMode: error.debug.parserMode,
            pagesScanned: error.debug.pagesScanned,
            pageCaseCounts: error.debug.pageCaseCounts,
            nextPageDetected: error.debug.nextPageDetected,
            rawParsedCount: error.debug.rawParsedCount,
            excludedStatuteCount: error.debug.excludedStatuteCount,
            excludedWeakCount: error.debug.excludedWeakCount,
            cloudflareDetected: error.debug.cloudflareDetected,
            challengeDetected: error.debug.challengeDetected,
            cooldownActive: error.debug.cooldownActive,
            retryAfterMs: error.debug.retryAfterMs,
            blockedType: error.debug.blockedType,
            timedOut: error.debug.timedOut,
            fetchTimeoutMsUsed: error.debug.fetchTimeoutMsUsed,
            htmlPreview: error.debug.htmlPreview,
            error: error.message,
          });
          if (error.debug.blockedType === "local_cooldown") {
            stopReason = "blocked";
            blockedKind = "local_cooldown";
            retryAfterMs = error.debug.retryAfterMs;
            blockedReason = `blocked_cooldown_active:${Math.max(
              1,
              Math.ceil((error.debug.retryAfterMs ?? 1000) / 1000),
            )}`;
            return buildResult({
              startedAtMs: startedAt,
              attempts,
              skippedDuplicates,
              stopReason,
              blockedCount: blockedCount + 1,
              blockedReason,
              blockedKind,
              retryAfterMs,
              candidates: allCandidates,
              seenSignatures,
              attemptsUsed,
            });
          }
          if (error.debug.challengeDetected || error.debug.status === 429) {
            blockedCount += 1;
            blockedKind =
              error.debug.blockedType ??
              (error.debug.challengeDetected ? "cloudflare_challenge" : "rate_limit");
            retryAfterMs = error.debug.retryAfterMs;
            delayMs = 240 + Math.floor(Math.random() * 220);
          } else if (error.debug.timedOut || error.debug.status === 408) {
            delayMs = 90;
          } else {
            blockedCount = 0;
            blockedReason = undefined;
            blockedKind = undefined;
            retryAfterMs = undefined;
          }
        } else {
          attempts.push({
            phase,
            variantId: variant.id,
            phrase: variant.phrase,
            status: 500,
            ok: false,
            parsedCount: 0,
            cloudflareDetected: false,
            challengeDetected: false,
            error: error instanceof Error ? error.message : "Unknown source error",
          });
        }
      }

      if (blockedCount >= config.blockedThreshold) {
        stopReason = "blocked";
        blockedReason = `blocked_threshold_reached:${blockedCount}`;
        return buildResult({
          startedAtMs: startedAt,
          attempts,
          skippedDuplicates,
          stopReason,
            blockedCount,
            blockedReason,
            blockedKind,
            retryAfterMs,
            candidates: allCandidates,
            seenSignatures,
            attemptsUsed,
        });
      }

      const deduped = dedupeCases(allCandidates);
      if (config.stopOnCandidateTarget !== false) {
        const likelyCaseCandidates = deduped.filter((candidate) => classifyCandidate(candidate).kind === "case");
        const likelyCases = likelyCaseCandidates.length;
        const scCount = likelyCaseCandidates.filter((candidate) => candidate.court === "SC").length;
        const courtRequirementMet = config.requireSupremeCourt ? scCount > 0 : true;
        if (likelyCases >= config.minCaseTarget && courtRequirementMet) {
          stopReason = "enough_candidates";
          return buildResult({
            startedAtMs: startedAt,
            attempts,
            skippedDuplicates,
            stopReason,
          blockedCount,
          blockedReason,
          blockedKind,
          retryAfterMs,
          candidates: deduped,
          seenSignatures,
          attemptsUsed,
          });
        }
      }

      if (Date.now() - startedAt >= config.maxElapsedMs) {
        stopReason = "budget_exhausted";
        blockedReason = `time_budget_exhausted:${config.maxElapsedMs}`;
        return buildResult({
          startedAtMs: startedAt,
          attempts,
          skippedDuplicates,
          stopReason,
          blockedCount,
          blockedReason,
          blockedKind,
          retryAfterMs,
          candidates: allCandidates,
          seenSignatures,
          attemptsUsed,
        });
      }

      const remainingAfterAttempt = config.maxElapsedMs - (Date.now() - startedAt);
      if (remainingAfterAttempt <= 250) {
        stopReason = "budget_exhausted";
        blockedReason = `time_budget_exhausted:${config.maxElapsedMs}`;
        return buildResult({
          startedAtMs: startedAt,
          attempts,
          skippedDuplicates,
          stopReason,
          blockedCount,
          blockedReason,
          blockedKind,
          retryAfterMs,
          candidates: allCandidates,
          seenSignatures,
          attemptsUsed,
        });
      }

      if (blockedCount === 0 && remainingAfterAttempt > delayMs + 200) {
        await sleep(delayMs);
      }
    }
  }

  return buildResult({
    startedAtMs: startedAt,
    attempts,
    skippedDuplicates,
    stopReason,
    blockedCount,
    blockedReason,
    blockedKind,
    retryAfterMs,
    candidates: allCandidates,
    seenSignatures,
    attemptsUsed,
  });
}
