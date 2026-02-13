import { evaluateQueryCoach } from "@/lib/query-coach";
import { PropositionChecklist } from "@/lib/proposition-gate";
import { IntentProfile } from "@/lib/pipeline/types";
import { NearMissCase, PipelineStopReason, SearchResponse } from "@/lib/types";

type QueryRewriteSummary = {
  applied?: boolean;
  error?: string;
  canonicalMustIncludeTokens?: string[];
  strictVariantPhrases?: string[];
};

type SyntheticAdvisoryInput = {
  query: string;
  intent: IntentProfile;
  checklist: PropositionChecklist;
  schedulerStopReason: PipelineStopReason;
  blockedKind?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
  queryRewrite?: QueryRewriteSummary;
};

function unique(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    output.push(cleaned);
  }
  return output;
}

function courtFromIntent(courtHint: IntentProfile["courtHint"]): NearMissCase["court"] {
  if (courtHint === "SC") return "SC";
  if (courtHint === "HC") return "HC";
  return "UNKNOWN";
}

function normalizeForLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function failureReasonLabel(input: {
  stopReason: PipelineStopReason;
  blockedKind?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
}): string {
  if (input.stopReason === "blocked") {
    if (input.blockedKind === "local_cooldown") return "retrieval_blocked_local_cooldown";
    if (input.blockedKind === "cloudflare_challenge") return "retrieval_blocked_cloudflare_challenge";
    if (input.blockedKind === "rate_limit") return "retrieval_blocked_rate_limit";
    return "retrieval_blocked";
  }
  if (input.stopReason === "budget_exhausted") return "retrieval_budget_exhausted";
  return "retrieval_no_match";
}

function tokenize(value: string): string[] {
  return normalizeForLabel(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function missingCriticalElements(input: {
  query: string;
  intent: IntentProfile;
  checklist: PropositionChecklist;
  coachChecklist: ReturnType<typeof evaluateQueryCoach>["checklist"];
}): string[] {
  const normalizedQuery = normalizeForLabel(input.query);
  const missingCoach = input.coachChecklist
    .filter((item) => item.priority === "critical" && !item.satisfied)
    .map((item) => item.label);
  const missingRequired = input.checklist.requiredElements.filter((element) => {
    const terms = tokenize(element).slice(0, 5);
    return terms.length > 0 && !terms.every((term) => normalizedQuery.includes(term));
  });
  const missingCriticalHooks = input.checklist.hookGroups
    .filter((group) => group.required)
    .filter((group) => {
      const groupHasMatch = group.terms.some((term) => {
        const tokens = tokenize(term).slice(0, 5);
        return tokens.length > 0 && tokens.every((token) => normalizedQuery.includes(token));
      });
      return !groupHasMatch;
    })
    .map((group) => `required legal hook group: ${group.label}`);
  const outcomeMissing =
    input.checklist.outcomeConstraint.required &&
    input.checklist.outcomeConstraint.terms.length > 0 &&
    !input.checklist.outcomeConstraint.terms.some((term) => {
      const tokens = tokenize(term).slice(0, 5);
      return tokens.length > 0 && tokens.every((token) => normalizedQuery.includes(token));
    })
      ? ["explicit outcome polarity phrase"]
      : [];
  const actorMissing =
    input.intent.actors.length > 0 &&
    !input.intent.actors.some((actor) => {
      const tokens = tokenize(actor).slice(0, 4);
      return tokens.length > 0 && tokens.every((token) => normalizedQuery.includes(token));
    })
      ? ["named actor/party role"]
      : [];
  const proceedingMissing =
    input.intent.procedures.length > 0 &&
    !input.intent.procedures.some((procedure) => {
      const tokens = tokenize(procedure).slice(0, 4);
      return tokens.length > 0 && tokens.every((token) => normalizedQuery.includes(token));
    })
      ? ["proceeding/posture term"]
      : [];

  return unique([
    ...missingCoach,
    ...missingRequired,
    ...missingCriticalHooks,
    ...outcomeMissing,
    ...actorMissing,
    ...proceedingMissing,
  ]).slice(0, 8);
}

function nextActions(input: {
  coachActions: string[];
  missingElements: string[];
  queryRewrite?: QueryRewriteSummary;
}): string[] {
  const rewriteHints =
    input.queryRewrite?.canonicalMustIncludeTokens
      ?.slice(0, 4)
      .map((token) => `Include term: ${token}`) ?? [];
  const fallbackActions =
    input.missingElements.length > 0
      ? input.missingElements.slice(0, 3).map((item) => `Add missing element: ${item}`)
      : ["Add one statute/section and one explicit outcome phrase."];
  return unique([...input.coachActions, ...fallbackActions, ...rewriteHints]).slice(0, 5);
}

function fallbackSearchUrl(input: {
  query: string;
  coach: ReturnType<typeof evaluateQueryCoach>;
  queryRewrite?: QueryRewriteSummary;
}): string {
  const rewriteSeed =
    input.queryRewrite?.strictVariantPhrases?.[0] ??
    input.coach.stricterRewrite ??
    input.coach.recommendedPattern ??
    input.query;
  const encoded = encodeURIComponent(rewriteSeed);
  return `https://indiankanoon.org/search/?formInput=${encoded}`;
}

export function shouldInjectSyntheticFallback(input: {
  alwaysReturnEnabled: boolean;
  syntheticFallbackEnabled: boolean;
  casesExactCount: number;
  casesExploratoryCount: number;
}): boolean {
  if (!input.alwaysReturnEnabled || !input.syntheticFallbackEnabled) return false;
  return input.casesExactCount === 0 && input.casesExploratoryCount === 0;
}

export function syntheticFallbackStatus(
  schedulerStopReason: PipelineStopReason,
): SearchResponse["status"] {
  return schedulerStopReason === "blocked" ? "blocked" : "no_match";
}

export function buildSyntheticAdvisoryNearMiss(input: SyntheticAdvisoryInput): {
  item: NearMissCase;
  reason: string;
} {
  const coach = evaluateQueryCoach(input.query);
  const reason = failureReasonLabel({
    stopReason: input.schedulerStopReason,
    blockedKind: input.blockedKind,
  });
  const missingElements = missingCriticalElements({
    query: input.query,
    intent: input.intent,
    checklist: input.checklist,
    coachChecklist: coach.checklist,
  });
  const gapSummary = nextActions({
    coachActions: coach.nextActions,
    missingElements,
    queryRewrite: input.queryRewrite,
  });

  const rewriteTerms = input.queryRewrite?.canonicalMustIncludeTokens?.slice(0, 4) ?? [];
  const rewritePhrase = rewriteTerms.length > 0 ? `Key terms: ${rewriteTerms.join(", ")}.` : "";
  const snippet = [
    "No verifiable citation could be returned in this run.",
    coach.readinessMessage,
    rewritePhrase,
    gapSummary.length > 0 ? `Next actions: ${gapSummary.join(" | ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const score = 0.22;
  const confidenceScore = 0.22;
  const rankingScore = 0.22;
  const url = fallbackSearchUrl({
    query: input.query,
    coach,
    queryRewrite: input.queryRewrite,
  });
  const rewriteApplied = input.queryRewrite?.applied === true;
  const rewriteErrored = Boolean(input.queryRewrite?.error);
  const selectionSummary = [
    "Best-available advisory fallback (not a citation).",
    `Reason: ${normalizeForLabel(reason)}.`,
    rewriteApplied
      ? "Canonical rewrite was applied; refine facts and retry."
      : rewriteErrored
        ? "Rewrite degraded; retry with clearer actor/proceeding/outcome."
        : "Add actor/proceeding/outcome and known legal hooks.",
  ].join(" ");

  const item: NearMissCase = {
    source: "indiankanoon",
    title: "Advisory fallback (non-citation): refine query and retry",
    url,
    snippet,
    court: courtFromIntent(input.intent.courtHint),
    score,
    rankingScore,
    confidenceScore,
    confidenceBand: "LOW",
    retrievalTier: "exploratory",
    fallbackReason: "synthetic_advisory",
    gapSummary,
    reasons: [
      `Fallback generated because ${normalizeForLabel(reason)}`,
      "Synthetic advisory item (non-citation)",
    ],
    selectionSummary,
    missingElements,
    verification: {
      anchorsMatched: 0,
      issuesMatched: 0,
      proceduresMatched: 0,
      detailChecked: false,
    },
  };

  return {
    item,
    reason,
  };
}
