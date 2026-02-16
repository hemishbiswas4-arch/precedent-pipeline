import { PHASE_LIMITS } from "@/lib/kb/query-templates";
import { hasRetrievalDebug } from "@/lib/retrieval/providers/types";
import type { RetrievalProvider } from "@/lib/retrieval/providers/types";
import { classifyCandidate } from "@/lib/pipeline/classifier";
import {
  CandidateProvenance,
  IntentProfile,
  QueryPhase,
  QueryVariant,
  SchedulerCarryState,
  SchedulerConfig,
  SchedulerResult,
  VariantUtilitySnapshot,
} from "@/lib/pipeline/types";
import { CaseCandidate } from "@/lib/types";

const ATTEMPT_FETCH_TIMEOUT_CAP_MS = Math.max(
  1_400,
  Number(process.env.ATTEMPT_FETCH_TIMEOUT_CAP_MS ?? "3500"),
);
const DEFAULT_PRIMARY_MAX_PAGES = Math.max(1, Math.min(Number(process.env.PRIMARY_MAX_PAGES ?? "2"), 3));
const DEFAULT_FALLBACK_MAX_PAGES = Math.max(1, Math.min(Number(process.env.FALLBACK_MAX_PAGES ?? "2"), 3));
const DEFAULT_OTHER_MAX_PAGES = Math.max(1, Math.min(Number(process.env.OTHER_MAX_PAGES ?? "1"), 2));
const ADAPTIVE_VARIANT_SCHEDULER_ENABLED = (() => {
  const raw = (process.env.ADAPTIVE_VARIANT_SCHEDULER ?? "1").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
})();
const RAW_CANDIDATE_EARLY_STOP_ENABLED = (() => {
  const raw = (process.env.SCHEDULER_STOP_ON_RAW_CANDIDATE_TARGET ?? "0").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
})();

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

function canonicalVariantKey(variant: QueryVariant): string {
  const explicit = variant.canonicalKey?.trim().toLowerCase();
  if (explicit) return explicit;
  return `${variant.phase}:${variant.strictness}:${variant.phrase.toLowerCase()}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function computeAttemptUtility(input: {
  cases: CaseCandidate[];
  parsedCount: number;
  challengeDetected: boolean;
  timedOut: boolean;
  status: number;
}): {
  score: number;
  caseLikeRatio: number;
  statuteLikeRatio: number;
} {
  if (input.parsedCount <= 0 || input.cases.length === 0) {
    const hardPenalty = input.challengeDetected || input.status === 429 ? 0.02 : input.timedOut ? 0.08 : 0.14;
    return {
      score: hardPenalty,
      caseLikeRatio: 0,
      statuteLikeRatio: 0,
    };
  }
  let caseLike = 0;
  let statuteLike = 0;
  for (const candidate of input.cases) {
    const kind = classifyCandidate(candidate).kind;
    if (kind === "case" || kind === "unknown") caseLike += 1;
    if (kind === "statute") statuteLike += 1;
  }
  const total = Math.max(1, input.cases.length);
  const caseLikeRatio = caseLike / total;
  const statuteLikeRatio = statuteLike / total;
  const parsedSignal = Math.min(input.parsedCount, 16) / 16;
  const challengePenalty = input.challengeDetected || input.status === 429 ? 0.22 : 0;
  const timeoutPenalty = input.timedOut ? 0.1 : 0;
  const rawScore = parsedSignal * 0.4 + caseLikeRatio * 0.45 - statuteLikeRatio * 0.18 - challengePenalty - timeoutPenalty;
  return {
    score: clamp01(rawScore),
    caseLikeRatio,
    statuteLikeRatio,
  };
}

function toSortedPhaseVariants(
  variants: QueryVariant[],
  utilityByKey: Record<string, VariantUtilitySnapshot>,
): QueryVariant[] {
  return [...variants].sort((left, right) => {
    const leftKey = canonicalVariantKey(left);
    const rightKey = canonicalVariantKey(right);
    const leftUtility = utilityByKey[leftKey];
    const rightUtility = utilityByKey[rightKey];
    const leftScore =
      (left.priority ?? 0) +
      (leftUtility?.meanUtility ?? 0) * 40 +
      (leftUtility?.caseLikeRate ?? 0) * 18 -
      (leftUtility?.challengeRate ?? 0) * 14 -
      (leftUtility?.timeoutRate ?? 0) * 8;
    const rightScore =
      (right.priority ?? 0) +
      (rightUtility?.meanUtility ?? 0) * 40 +
      (rightUtility?.caseLikeRate ?? 0) * 18 -
      (rightUtility?.challengeRate ?? 0) * 14 -
      (rightUtility?.timeoutRate ?? 0) * 8;
    if (rightScore !== leftScore) return rightScore - leftScore;
    return (right.priority ?? 0) - (left.priority ?? 0);
  });
}

function updateVariantUtility(
  map: Record<string, VariantUtilitySnapshot>,
  input: {
    key: string;
    score: number;
    caseLikeRatio: number;
    statuteLikeRatio: number;
    challengeDetected: boolean;
    timedOut: boolean;
    status: number;
  },
): VariantUtilitySnapshot {
  const existing = map[input.key];
  const nextAttempts = (existing?.attempts ?? 0) + 1;
  const meanUtility =
    ((existing?.meanUtility ?? 0) * (nextAttempts - 1) + input.score) / nextAttempts;
  const caseLikeRate =
    ((existing?.caseLikeRate ?? 0) * (nextAttempts - 1) + input.caseLikeRatio) / nextAttempts;
  const statuteLikeRate =
    ((existing?.statuteLikeRate ?? 0) * (nextAttempts - 1) + input.statuteLikeRatio) /
    nextAttempts;
  const challengeRate =
    ((existing?.challengeRate ?? 0) * (nextAttempts - 1) + (input.challengeDetected ? 1 : 0)) /
    nextAttempts;
  const timeoutRate =
    ((existing?.timeoutRate ?? 0) * (nextAttempts - 1) + (input.timedOut ? 1 : 0)) / nextAttempts;

  const snapshot: VariantUtilitySnapshot = {
    attempts: nextAttempts,
    meanUtility: Number(meanUtility.toFixed(4)),
    caseLikeRate: Number(caseLikeRate.toFixed(4)),
    statuteLikeRate: Number(statuteLikeRate.toFixed(4)),
    challengeRate: Number(challengeRate.toFixed(4)),
    timeoutRate: Number(timeoutRate.toFixed(4)),
    lastStatus: input.status,
    updatedAtMs: Date.now(),
  };
  map[input.key] = snapshot;
  return snapshot;
}

function updateCandidateProvenance(
  map: Record<string, CandidateProvenance>,
  input: {
    candidates: CaseCandidate[];
    variant: QueryVariant;
    utilityScore: number;
  },
): void {
  const canonicalKey = canonicalVariantKey(input.variant);
  for (const candidate of input.candidates) {
    const existing = map[candidate.url];
    if (!existing) {
      map[candidate.url] = {
        variantIds: [input.variant.id],
        canonicalKeys: [canonicalKey],
        phases: [input.variant.phase],
        bestUtility: input.utilityScore,
        strictHits: input.variant.strictness === "strict" ? 1 : 0,
        relaxedHits: input.variant.strictness === "relaxed" ? 1 : 0,
        highPriorityHits: (input.variant.priority ?? 0) >= 80 ? 1 : 0,
      };
      continue;
    }
    if (!existing.variantIds.includes(input.variant.id)) existing.variantIds.push(input.variant.id);
    if (!existing.canonicalKeys.includes(canonicalKey)) existing.canonicalKeys.push(canonicalKey);
    if (!existing.phases.includes(input.variant.phase)) existing.phases.push(input.variant.phase);
    existing.bestUtility = Math.max(existing.bestUtility, input.utilityScore);
    if (input.variant.strictness === "strict") existing.strictHits += 1;
    if (input.variant.strictness === "relaxed") existing.relaxedHits += 1;
    if ((input.variant.priority ?? 0) >= 80) existing.highPriorityHits += 1;
  }
}

function candidateQualityScore(candidate: CaseCandidate): number {
  let score = 0;
  if (candidate.court !== "UNKNOWN") score += 10;
  if (candidate.detailText) score += 12;
  if ((candidate.detailArtifact?.evidenceWindows?.length ?? 0) > 0) score += 8;
  if (candidate.courtText) score += 4;
  if (candidate.fullDocumentUrl && candidate.fullDocumentUrl !== candidate.url) score += 2;
  if (typeof candidate.citesCount === "number") score += 1;
  if (typeof candidate.citedByCount === "number") score += 1;
  score += Math.min(candidate.snippet.length, 600) / 120;
  return score;
}

function mergeDuplicateCandidate(existing: CaseCandidate, incoming: CaseCandidate): CaseCandidate {
  const existingScore = candidateQualityScore(existing);
  const incomingScore = candidateQualityScore(incoming);
  const base = incomingScore > existingScore ? incoming : existing;
  const fallback = base === existing ? incoming : existing;

  const mergedSnippet =
    (base.snippet?.length ?? 0) >= (fallback.snippet?.length ?? 0)
      ? base.snippet
      : fallback.snippet;
  const mergedCourt = base.court !== "UNKNOWN" ? base.court : fallback.court;
  const mergedDetailArtifact = base.detailArtifact ?? fallback.detailArtifact;
  const mergedDetailText =
    base.detailText ??
    fallback.detailText ??
    (mergedDetailArtifact ? `${mergedDetailArtifact.evidenceWindows.join("\n")}` : undefined);

  return {
    ...base,
    title: base.title && !/^untitled case/i.test(base.title) ? base.title : fallback.title || base.title,
    snippet: mergedSnippet,
    court: mergedCourt,
    courtText: base.courtText ?? fallback.courtText,
    citesCount: typeof base.citesCount === "number" ? base.citesCount : fallback.citesCount,
    citedByCount: typeof base.citedByCount === "number" ? base.citedByCount : fallback.citedByCount,
    author: base.author ?? fallback.author,
    fullDocumentUrl: base.fullDocumentUrl ?? fallback.fullDocumentUrl ?? base.url,
    detailText: mergedDetailText,
    detailArtifact: mergedDetailArtifact,
    detailHydration: base.detailHydration ?? fallback.detailHydration,
    evidenceQuality: base.evidenceQuality ?? fallback.evidenceQuality,
  };
}

function dedupeCases(cases: CaseCandidate[]): CaseCandidate[] {
  const outputByUrl = new Map<string, CaseCandidate>();
  for (const item of cases) {
    const existing = outputByUrl.get(item.url);
    if (!existing) {
      outputByUrl.set(item.url, item);
      continue;
    }
    outputByUrl.set(item.url, mergeDuplicateCandidate(existing, item));
  }
  return Array.from(outputByUrl.values());
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
  variantUtility?: Record<string, VariantUtilitySnapshot>;
  candidateProvenance?: Record<string, CandidateProvenance>;
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
    variantUtility: input.variantUtility,
    candidateProvenance: input.candidateProvenance,
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
  variantUtility?: Record<string, VariantUtilitySnapshot>;
  candidateProvenance?: Record<string, CandidateProvenance>;
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
    variantUtility: input.variantUtility,
    candidateProvenance: input.candidateProvenance,
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
      variantUtility: input.variantUtility,
      candidateProvenance: input.candidateProvenance,
      attempts: input.attempts,
      candidates: deduped,
    }),
  };
}

export async function runRetrievalSchedule(input: {
  variants: QueryVariant[];
  intent: IntentProfile;
  config: SchedulerConfig;
  provider: RetrievalProvider;
  carryState?: SchedulerCarryState;
  cooldownScope?: string;
}): Promise<SchedulerResult> {
  const { variants, intent, config, provider, carryState, cooldownScope } = input;
  const seenSignatures = new Set<string>(carryState?.seenSignatures ?? []);
  const attempts: SchedulerResult["attempts"] = [...(carryState?.attempts ?? [])];
  const allCandidates: CaseCandidate[] = [...(carryState?.candidates ?? [])];
  const variantUtility: Record<string, VariantUtilitySnapshot> = {
    ...(carryState?.variantUtility ?? {}),
  };
  const candidateProvenance: Record<string, CandidateProvenance> = Object.fromEntries(
    Object.entries(carryState?.candidateProvenance ?? {}).map(([url, provenance]) => [
      url,
      {
        ...provenance,
        variantIds: [...provenance.variantIds],
        canonicalKeys: [...provenance.canonicalKeys],
        phases: [...provenance.phases],
      },
    ]),
  );
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
    const phaseBudget = config.phaseLimits[phase] ?? PHASE_LIMITS[phase];
    const phaseVariants = variantsByPhase[phase].slice(0, phaseBudget);
    let remainingVariants = ADAPTIVE_VARIANT_SCHEDULER_ENABLED
      ? toSortedPhaseVariants(phaseVariants, variantUtility)
      : [...phaseVariants];

    while (remainingVariants.length > 0) {
      if (ADAPTIVE_VARIANT_SCHEDULER_ENABLED && remainingVariants.length > 1) {
        remainingVariants = toSortedPhaseVariants(remainingVariants, variantUtility);
      }
      const variant = remainingVariants.shift();
      if (!variant) continue;

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
          variantUtility,
          candidateProvenance,
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
          variantUtility,
          candidateProvenance,
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
      if (remainingBeforeAttempt < 1_000) {
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
          variantUtility,
          candidateProvenance,
          candidates: allCandidates,
          seenSignatures,
          attemptsUsed,
        });
      }

      const perAttemptTimeoutMs = Math.max(
        700,
        Math.min(
          config.fetchTimeoutMs ?? 8_000,
          ATTEMPT_FETCH_TIMEOUT_CAP_MS,
          remainingBeforeAttempt - 250,
        ),
      );
      const perAttemptCrawlBudgetMs = Math.max(
        perAttemptTimeoutMs,
        Math.min(remainingBeforeAttempt - 100, perAttemptTimeoutMs + 400),
      );
      const dynamicMax429Retries =
        remainingBeforeAttempt < perAttemptTimeoutMs + 3_000 ? 0 : (config.max429Retries ?? 1);
      const maxPagesPolicy = config.maxPagesByPhase;
      const maxPages =
        phase === "primary"
          ? maxPagesPolicy?.primary ?? DEFAULT_PRIMARY_MAX_PAGES
          : phase === "fallback"
            ? maxPagesPolicy?.fallback ?? DEFAULT_FALLBACK_MAX_PAGES
            : maxPagesPolicy?.other ?? DEFAULT_OTHER_MAX_PAGES;
      const contradictionExclusionsEnabled =
        variant.retrievalDirectives?.applyContradictionExclusions !== false;
      const providerHints = contradictionExclusionsEnabled
        ? variant.providerHints
        : {
            ...variant.providerHints,
            excludeTerms: undefined,
          };
      const queryMode = variant.retrievalDirectives?.queryMode;
      const maxResultsPerPhrase =
        provider.id === "serper"
          ? queryMode === "expansion"
            ? 20
            : queryMode === "context"
              ? 18
              : 16
          : 14;
      let delayMs = 80 + Math.floor(Math.random() * 80);
      const canonicalKey = canonicalVariantKey(variant);
      try {
        const result = await provider.search({
          phrase,
          courtScope: variant.courtScope,
          maxResultsPerPhrase,
          maxPages,
          courtType,
          fromDate,
          toDate,
          sortByMostRecent: false,
          crawlMaxElapsedMs: perAttemptCrawlBudgetMs,
          fetchTimeoutMs: perAttemptTimeoutMs,
          max429Retries: dynamicMax429Retries,
          maxRetryAfterMs: config.maxRetryAfterMs,
          cooldownScope,
          compiledQuery: variant.providerHints?.compiledQuery,
          includeTokens: variant.mustIncludeTokens,
          excludeTokens: contradictionExclusionsEnabled ? variant.mustExcludeTokens : undefined,
          providerHints,
          queryMode,
          doctypeProfile: variant.retrievalDirectives?.doctypeProfile,
          titleTerms: variant.retrievalDirectives?.titleTerms,
          citeTerms: variant.retrievalDirectives?.citeTerms,
          authorTerms: variant.retrievalDirectives?.authorTerms,
          benchTerms: variant.retrievalDirectives?.benchTerms,
          categoryExpansions: variant.retrievalDirectives?.categoryExpansions,
          variantPriority: variant.priority,
        });
        const utilityStats = computeAttemptUtility({
          cases: result.cases,
          parsedCount: result.debug.parsedCount,
          challengeDetected: result.debug.challengeDetected,
          timedOut: Boolean(result.debug.timedOut),
          status: result.debug.status,
        });
        const utilitySnapshot = updateVariantUtility(variantUtility, {
          key: canonicalKey,
          score: utilityStats.score,
          caseLikeRatio: utilityStats.caseLikeRatio,
          statuteLikeRatio: utilityStats.statuteLikeRatio,
          challengeDetected: result.debug.challengeDetected || result.debug.status === 429,
          timedOut: Boolean(result.debug.timedOut),
          status: result.debug.status,
        });

        attempts.push({
          providerId: provider.id,
          sourceLabel: result.debug.sourceTag,
          queryMode: variant.retrievalDirectives?.queryMode ?? result.debug.queryMode,
          phase,
          courtScope: variant.courtScope,
          variantId: variant.id,
          canonicalKey,
          variantPriority: variant.priority,
          phrase: variant.phrase,
          searchQuery: result.debug.searchQuery,
          status: result.debug.status,
          ok: result.debug.ok,
          parsedCount: result.debug.parsedCount,
          utilityScore: utilitySnapshot.meanUtility,
          caseLikeRatio: utilityStats.caseLikeRatio,
          statuteLikeRatio: utilityStats.statuteLikeRatio,
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
          lexicalCandidateCount: result.debug.lexicalCandidateCount,
          semanticCandidateCount: result.debug.semanticCandidateCount,
          fusedCandidateCount: result.debug.fusedCandidateCount,
          rerankApplied: result.debug.rerankApplied,
          fusionLatencyMs: result.debug.fusionLatencyMs,
          docFragmentHydrationMs: result.debug.docFragmentHydrationMs,
          docFragmentCalls: result.debug.docFragmentCalls,
          categoryExpansionCount: result.debug.categoryExpansionCount,
          docmetaHydrationMs: result.debug.docmetaHydrationMs,
          docmetaCalls: result.debug.docmetaCalls,
          docmetaHydrated: result.debug.docmetaHydrated,
          error: null,
        });

        allCandidates.push(...result.cases);
        updateCandidateProvenance(candidateProvenance, {
          candidates: result.cases,
          variant,
          utilityScore: utilitySnapshot.meanUtility,
        });
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
            variantUtility,
            candidateProvenance,
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
        if (hasRetrievalDebug(error)) {
          const debug = error.debug;
          const errorMessage =
            error instanceof Error ? error.message : "retrieval_provider_error";
          const utilityStats = computeAttemptUtility({
            cases: [],
            parsedCount: debug.parsedCount,
            challengeDetected: debug.challengeDetected || debug.status === 429,
            timedOut: Boolean(debug.timedOut),
            status: debug.status,
          });
          const utilitySnapshot = updateVariantUtility(variantUtility, {
            key: canonicalKey,
            score: utilityStats.score,
            caseLikeRatio: utilityStats.caseLikeRatio,
            statuteLikeRatio: utilityStats.statuteLikeRatio,
            challengeDetected: debug.challengeDetected || debug.status === 429,
            timedOut: Boolean(debug.timedOut),
            status: debug.status,
          });
          attempts.push({
            providerId: provider.id,
            sourceLabel: debug.sourceTag,
            queryMode: variant.retrievalDirectives?.queryMode ?? debug.queryMode,
            phase,
            courtScope: variant.courtScope,
            variantId: variant.id,
            canonicalKey,
            variantPriority: variant.priority,
            phrase: variant.phrase,
            searchQuery: debug.searchQuery,
            status: debug.status,
            ok: debug.ok,
            parsedCount: debug.parsedCount,
            utilityScore: utilitySnapshot.meanUtility,
            caseLikeRatio: utilityStats.caseLikeRatio,
            statuteLikeRatio: utilityStats.statuteLikeRatio,
            parserMode: debug.parserMode,
            pagesScanned: debug.pagesScanned,
            pageCaseCounts: debug.pageCaseCounts,
            nextPageDetected: debug.nextPageDetected,
            rawParsedCount: debug.rawParsedCount,
            excludedStatuteCount: debug.excludedStatuteCount,
            excludedWeakCount: debug.excludedWeakCount,
            cloudflareDetected: debug.cloudflareDetected,
            challengeDetected: debug.challengeDetected,
            cooldownActive: debug.cooldownActive,
            retryAfterMs: debug.retryAfterMs,
            blockedType: debug.blockedType,
            timedOut: debug.timedOut,
            fetchTimeoutMsUsed: debug.fetchTimeoutMsUsed,
            htmlPreview: debug.htmlPreview,
            lexicalCandidateCount: debug.lexicalCandidateCount,
            semanticCandidateCount: debug.semanticCandidateCount,
            fusedCandidateCount: debug.fusedCandidateCount,
            rerankApplied: debug.rerankApplied,
            fusionLatencyMs: debug.fusionLatencyMs,
            categoryExpansionCount: debug.categoryExpansionCount,
            docmetaHydrationMs: debug.docmetaHydrationMs,
            docmetaCalls: debug.docmetaCalls,
            docmetaHydrated: debug.docmetaHydrated,
            error: errorMessage,
          });
          if (debug.blockedType === "local_cooldown") {
            stopReason = "blocked";
            blockedKind = "local_cooldown";
            retryAfterMs = debug.retryAfterMs;
            blockedReason = `blocked_cooldown_active:${Math.max(
              1,
              Math.ceil((debug.retryAfterMs ?? 1000) / 1000),
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
              variantUtility,
              candidateProvenance,
              candidates: allCandidates,
              seenSignatures,
              attemptsUsed,
            });
          }
          if (debug.challengeDetected || debug.status === 429) {
            blockedCount += 1;
            blockedKind =
              debug.blockedType ??
              (debug.challengeDetected ? "cloudflare_challenge" : "rate_limit");
            retryAfterMs = debug.retryAfterMs;
            delayMs = 240 + Math.floor(Math.random() * 220);
          } else if (debug.timedOut || debug.status === 408) {
            delayMs = 90;
          } else {
            blockedCount = 0;
            blockedReason = undefined;
            blockedKind = undefined;
            retryAfterMs = undefined;
          }
        } else {
          const utilityStats = computeAttemptUtility({
            cases: [],
            parsedCount: 0,
            challengeDetected: false,
            timedOut: false,
            status: 500,
          });
          const utilitySnapshot = updateVariantUtility(variantUtility, {
            key: canonicalKey,
            score: utilityStats.score,
            caseLikeRatio: utilityStats.caseLikeRatio,
            statuteLikeRatio: utilityStats.statuteLikeRatio,
            challengeDetected: false,
            timedOut: false,
            status: 500,
          });
          attempts.push({
            providerId: provider.id,
            sourceLabel:
              provider.id === "indiankanoon_api"
                ? "lexical_api"
                : provider.id === "indiankanoon_html"
                  ? "lexical_html"
                  : "web_search",
            queryMode: variant.retrievalDirectives?.queryMode,
            phase,
            courtScope: variant.courtScope,
            variantId: variant.id,
            canonicalKey,
            variantPriority: variant.priority,
            phrase: variant.phrase,
            status: 500,
            ok: false,
            parsedCount: 0,
            utilityScore: utilitySnapshot.meanUtility,
            caseLikeRatio: utilityStats.caseLikeRatio,
            statuteLikeRatio: utilityStats.statuteLikeRatio,
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
            variantUtility,
            candidateProvenance,
            candidates: allCandidates,
            seenSignatures,
            attemptsUsed,
        });
      }

      const deduped = dedupeCases(allCandidates);
      if (config.stopOnCandidateTarget !== false && RAW_CANDIDATE_EARLY_STOP_ENABLED) {
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
          variantUtility,
          candidateProvenance,
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
          variantUtility,
          candidateProvenance,
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
          variantUtility,
          candidateProvenance,
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
    variantUtility,
    candidateProvenance,
    candidates: allCandidates,
    seenSignatures,
    attemptsUsed,
  });
}

export const schedulerTestUtils = {
  computeAttemptUtility,
  toSortedPhaseVariants,
  canonicalVariantKey,
};
