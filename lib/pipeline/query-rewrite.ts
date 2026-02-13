import { IntentProfile, PlannerOutput, QueryProviderHints, QueryVariant } from "@/lib/pipeline/types";
import { ReasonerOutcomePolarity, ReasonerPlan } from "@/lib/reasoner-schema";

export type CanonicalHookGroup = {
  groupId: string;
  terms: string[];
  representative: string;
  required: boolean;
  minMatch: number;
};

export type CanonicalIntent = {
  actors: string[];
  proceedings: string[];
  outcomes: string[];
  legalHooks: string[];
  hookGroups: CanonicalHookGroup[];
  outcomePolarity: ReasonerOutcomePolarity;
  contradictionTerms: string[];
  courtScope: QueryVariant["courtScope"];
  dateWindow: {
    fromDate?: string;
    toDate?: string;
  };
  mustIncludeTokens: string[];
  mustExcludeTokens: string[];
  canonicalOrderTerms: string[];
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:doctypes|sortby|fromdate|todate):\S+/g, " ")
    .replace(/[^a-z0-9\s()/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function unique(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  }
  return hash;
}

function inferOutcomePolarity(intent: IntentProfile, reasonerPlan?: ReasonerPlan): ReasonerOutcomePolarity {
  const planned = reasonerPlan?.proposition.outcome_constraint.polarity;
  if (planned && planned !== "unknown") return planned;

  const q = normalizeText(`${intent.cleanedQuery} ${intent.issues.join(" ")}`);
  if (/\bnot required|without sanction|no sanction\b/.test(q)) return "not_required";
  if (/\brequired|mandatory|necessary|must\b/.test(q) && /\bsanction\b/.test(q)) return "required";
  if (/\brefused|rejected|denied|declined|not condoned\b/.test(q)) return "refused";
  if (/\bdismissed|time barred|barred by limitation\b/.test(q)) return "dismissed";
  if (/\bquashed\b/.test(q)) return "quashed";
  if (/\ballowed|granted|condoned\b/.test(q)) return "allowed";
  return "unknown";
}

function defaultContradictionTerms(polarity: ReasonerOutcomePolarity): string[] {
  if (polarity === "refused") return ["allowed", "granted", "condoned", "restored"];
  if (polarity === "dismissed") return ["allowed", "restored", "admitted"];
  if (polarity === "required") return ["not required", "without sanction", "no sanction"];
  if (polarity === "not_required") return ["sanction required", "mandatory sanction", "previous sanction"];
  if (polarity === "quashed") return ["dismissed", "convicted", "upheld prosecution"];
  return [];
}

function extractHookGroups(intent: IntentProfile, reasonerPlan?: ReasonerPlan): CanonicalHookGroup[] {
  const output: CanonicalHookGroup[] = [];
  const seen = new Set<string>();

  for (const group of reasonerPlan?.proposition.hook_groups ?? []) {
    const terms = unique(group.terms).slice(0, 8);
    if (terms.length === 0) continue;
    const groupId = normalizeText(group.group_id) || `hook_group_${output.length + 1}`;
    if (seen.has(groupId)) continue;
    seen.add(groupId);
    output.push({
      groupId,
      terms,
      representative: terms[0],
      required: group.required,
      minMatch: Math.max(1, Math.min(group.min_match, terms.length)),
    });
  }

  for (const hook of [...(reasonerPlan?.proposition.legal_hooks ?? []), ...intent.statutes]) {
    const normalized = normalizeText(hook);
    if (!normalized) continue;
    const groupId = `hook_${tokenize(normalized).slice(0, 3).join("_") || "generic"}`;
    const existing = output.find((group) => group.groupId === groupId);
    if (!existing) {
      output.push({
        groupId,
        terms: [normalized],
        representative: normalized,
        required: true,
        minMatch: 1,
      });
      continue;
    }
    existing.terms = unique([...existing.terms, normalized]).slice(0, 8);
    if (!existing.representative) existing.representative = existing.terms[0];
    existing.required = existing.required || true;
  }

  return output.slice(0, 8);
}

function buildMustIncludeTokens(input: {
  actors: string[];
  proceedings: string[];
  outcomes: string[];
  hookGroups: CanonicalHookGroup[];
}): string[] {
  const requiredHookRepresentatives = input.hookGroups.filter((group) => group.required).map((group) => group.representative);
  const tokens = [
    ...input.actors.slice(0, 3),
    ...input.proceedings.slice(0, 3),
    ...input.outcomes.slice(0, 3),
    ...requiredHookRepresentatives.slice(0, 4),
  ]
    .flatMap((value) => tokenize(value))
    .filter((token) => token.length > 1);
  return unique(tokens).slice(0, 20);
}

function phraseIncludesAllRequiredGroups(phrase: string, requiredGroups: CanonicalHookGroup[]): boolean {
  if (requiredGroups.length === 0) return true;
  const normalized = normalizeText(phrase);
  return requiredGroups.every((group) => group.terms.some((term) => normalized.includes(term)));
}

function normalizePhrase(value: string, maxTokens = 13): string {
  const tokens = tokenize(value).slice(0, maxTokens);
  return tokens.join(" ").trim();
}

function buildVariant(
  input: {
    phase: QueryVariant["phase"];
    strictness: QueryVariant["strictness"];
    purpose: string;
    phrase: string;
    idx: number;
    courtScope: QueryVariant["courtScope"];
    canonicalKeyPrefix: string;
    priority: number;
    mustIncludeTokens: string[];
    mustExcludeTokens: string[];
    providerHints: QueryProviderHints;
  },
): QueryVariant | null {
  const phrase = normalizePhrase(input.phrase, input.phase === "primary" ? 13 : 12);
  if (!phrase || phrase.split(/\s+/).length < (input.strictness === "strict" ? 4 : 3)) {
    return null;
  }
  const canonicalKey = `${input.canonicalKeyPrefix}:${normalizeText(phrase)}`;
  return {
    id: `${input.phase}_${input.idx}_${Math.abs(hashString(`${canonicalKey}|${input.purpose}`)).toString(36)}`,
    phrase,
    phase: input.phase,
    purpose: input.purpose,
    courtScope: input.courtScope,
    strictness: input.strictness,
    tokens: tokenize(phrase),
    canonicalKey,
    priority: input.priority,
    mustIncludeTokens: input.mustIncludeTokens.slice(0, 24),
    mustExcludeTokens: input.mustExcludeTokens.slice(0, 16),
    providerHints: input.providerHints,
  };
}

export function buildCanonicalIntent(intent: IntentProfile, reasonerPlan?: ReasonerPlan): CanonicalIntent {
  const actors = unique([...(reasonerPlan?.proposition.actors ?? []), ...intent.actors]).slice(0, 6);
  const proceedings = unique([...(reasonerPlan?.proposition.proceeding ?? []), ...intent.procedures]).slice(0, 6);
  const outcomes = unique([...(reasonerPlan?.proposition.outcome_required ?? []), ...intent.issues]).slice(0, 8);
  const legalHooks = unique([...(reasonerPlan?.proposition.legal_hooks ?? []), ...intent.statutes]).slice(0, 10);
  const hookGroups = extractHookGroups(intent, reasonerPlan);
  const polarity = inferOutcomePolarity(intent, reasonerPlan);
  const contradictionTerms = unique([
    ...(reasonerPlan?.proposition.outcome_constraint.contradiction_terms ?? []),
    ...(reasonerPlan?.must_not_have_terms ?? []),
    ...defaultContradictionTerms(polarity),
  ]).slice(0, 14);
  const mustIncludeTokens = buildMustIncludeTokens({
    actors,
    proceedings,
    outcomes,
    hookGroups,
  });
  const mustExcludeTokens = unique(contradictionTerms.flatMap((term) => tokenize(term))).slice(0, 14);
  const canonicalOrderTerms = unique([
    ...actors,
    ...proceedings,
    ...hookGroups.filter((group) => group.required).map((group) => group.representative),
    ...outcomes,
  ]).slice(0, 14);

  return {
    actors,
    proceedings,
    outcomes,
    legalHooks,
    hookGroups,
    outcomePolarity: polarity,
    contradictionTerms,
    courtScope: reasonerPlan?.proposition.jurisdiction_hint ?? intent.courtHint,
    dateWindow: intent.dateWindow,
    mustIncludeTokens,
    mustExcludeTokens,
    canonicalOrderTerms,
  };
}

export function synthesizeRetrievalQueries(input: {
  canonicalIntent: CanonicalIntent;
  deterministicPlanner: PlannerOutput;
  reasonerVariants: QueryVariant[];
}): QueryVariant[] {
  const { canonicalIntent, deterministicPlanner, reasonerVariants } = input;
  const requiredHookGroups = canonicalIntent.hookGroups.filter((group) => group.required);
  const multiHookRequired = requiredHookGroups.length >= 2;
  const strictSeeds: string[] = [];
  const broadSeeds: string[] = [];

  for (const variant of reasonerVariants) {
    if (variant.strictness === "strict") strictSeeds.push(variant.phrase);
    else broadSeeds.push(variant.phrase);
  }
  for (const variant of deterministicPlanner.variants) {
    if (variant.strictness === "strict") strictSeeds.push(variant.phrase);
    else broadSeeds.push(variant.phrase);
  }

  const actorPool = canonicalIntent.actors.length > 0 ? canonicalIntent.actors : [""];
  const proceedingPool = canonicalIntent.proceedings.length > 0 ? canonicalIntent.proceedings : [""];
  const outcomePool = canonicalIntent.outcomes.length > 0 ? canonicalIntent.outcomes : [""];
  const requiredHookPhrase = requiredHookGroups.map((group) => group.representative).join(" ").trim();

  for (const actor of actorPool.slice(0, 3)) {
    for (const proceeding of proceedingPool.slice(0, 3)) {
      for (const outcome of outcomePool.slice(0, 3)) {
        const strictPhrase = normalizePhrase(`${actor} ${proceeding} ${requiredHookPhrase} ${outcome}`.trim(), 13);
        if (strictPhrase.length >= 10) {
          strictSeeds.push(strictPhrase);
        }
      }
    }
  }

  for (const proceeding of proceedingPool.slice(0, 3)) {
    for (const outcome of outcomePool.slice(0, 3)) {
      broadSeeds.push(normalizePhrase(`${proceeding} ${requiredHookPhrase} ${outcome}`.trim(), 12));
      broadSeeds.push(normalizePhrase(`${proceeding} ${outcome}`.trim(), 10));
    }
  }
  for (const phrase of deterministicPlanner.keywordPack.searchPhrases.slice(0, 10)) {
    broadSeeds.push(phrase);
  }
  for (const phrase of deterministicPlanner.keywordPack.primary.slice(0, 10)) {
    broadSeeds.push(phrase);
  }

  let strictPhrases = unique(strictSeeds.map((value) => normalizePhrase(value, 13)).filter((value) => value.length >= 8));
  if (multiHookRequired) {
    strictPhrases = strictPhrases.filter((phrase) => phraseIncludesAllRequiredGroups(phrase, requiredHookGroups));
  }
  if (strictPhrases.length === 0 && actorPool[0] && proceedingPool[0] && outcomePool[0]) {
    const fallbackStrict = normalizePhrase(
      `${actorPool[0]} ${proceedingPool[0]} ${requiredHookPhrase} ${outcomePool[0]}`.trim(),
      13,
    );
    if (fallbackStrict) strictPhrases = [fallbackStrict];
  }

  const broadPhrases = unique(broadSeeds.map((value) => normalizePhrase(value, 12)).filter((value) => value.length >= 6)).slice(
    0,
    24,
  );

  const output: QueryVariant[] = [];
  const seen = new Set<string>();
  let idx = 0;

  const providerHintsBase: QueryProviderHints = {
    serperQuotedTerms: unique([
      ...requiredHookGroups.map((group) => group.representative),
      ...canonicalIntent.outcomes.slice(0, 2),
    ]).slice(0, 4),
    serperCoreTerms: unique([
      ...canonicalIntent.proceedings.slice(0, 2),
      ...canonicalIntent.actors.slice(0, 2),
    ]).slice(0, 5),
    canonicalOrderTerms: canonicalIntent.canonicalOrderTerms.slice(0, 14),
    excludeTerms: canonicalIntent.mustExcludeTokens.slice(0, 10),
  };

  const strictLimitsByPhase: Array<{ phase: QueryVariant["phase"]; count: number; priority: number }> = [
    { phase: "primary", count: 3, priority: 110 },
    { phase: "fallback", count: 5, priority: 96 },
  ];
  let strictCursor = 0;
  for (const entry of strictLimitsByPhase) {
    const strictChunk = strictPhrases.slice(strictCursor, strictCursor + entry.count);
    strictCursor += entry.count;
    for (const phrase of strictChunk) {
      const key = `${entry.phase}|${phrase}`;
      if (seen.has(key)) continue;
      const variant = buildVariant({
        phase: entry.phase,
        strictness: "strict",
        purpose: "canonical-rewrite-strict",
        phrase,
        idx,
        courtScope: canonicalIntent.courtScope,
        canonicalKeyPrefix: "rewrite:strict",
        priority: entry.priority - Math.min(idx, 6),
        mustIncludeTokens: canonicalIntent.mustIncludeTokens,
        mustExcludeTokens: canonicalIntent.mustExcludeTokens,
        providerHints: providerHintsBase,
      });
      if (!variant) continue;
      seen.add(key);
      output.push(variant);
      idx += 1;
    }
  }

  const broadPhaseOrder: QueryVariant["phase"][] = ["fallback", "rescue", "micro", "revolving", "browse"];
  for (let i = 0; i < broadPhrases.length; i += 1) {
    const phrase = broadPhrases[i];
    const phase = broadPhaseOrder[Math.min(Math.floor(i / 4), broadPhaseOrder.length - 1)];
    const key = `${phase}|${phrase}`;
    if (seen.has(key)) continue;
    const variant = buildVariant({
      phase,
      strictness: i < 6 ? "strict" : "relaxed",
      purpose: "canonical-rewrite-broad",
      phrase,
      idx,
      courtScope: canonicalIntent.courtScope,
      canonicalKeyPrefix: "rewrite:broad",
      priority: 82 - Math.min(i, 28),
      mustIncludeTokens: canonicalIntent.mustIncludeTokens,
      mustExcludeTokens: canonicalIntent.mustExcludeTokens,
      providerHints: providerHintsBase,
    });
    if (!variant) continue;
    if (multiHookRequired && variant.strictness === "strict" && !phraseIncludesAllRequiredGroups(variant.phrase, requiredHookGroups)) {
      continue;
    }
    seen.add(key);
    output.push(variant);
    idx += 1;
  }

  return output.slice(0, 40);
}
