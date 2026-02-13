import { ContextProfile, KeywordPack } from "@/lib/types";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "or",
  "the",
  "to",
  "of",
  "in",
  "for",
  "with",
  "on",
  "at",
  "by",
  "from",
  "under",
  "into",
  "after",
  "before",
  "where",
  "when",
  "whether",
  "please",
  "find",
  "show",
  "give",
  "cases",
  "case",
  "precedent",
  "precedents",
  "judgment",
  "judgments",
]);

const CONNECTOR_NOISE = new Set([
  "there",
  "their",
  "about",
  "between",
  "through",
  "based",
  "also",
  "anything",
  "found",
]);

const HIGH_IMPACT_SYNONYM_RULES: Array<{ match: RegExp; expansions: string[] }> = [
  {
    match: /\b(?:delay\s+not\s+condon(?:ed|able)|condonation(?:\s+of\s+delay)?\s+(?:refused|rejected|denied|declined)|refused)\b/i,
    expansions: [
      "condonation of delay refused",
      "application for condonation rejected",
      "delay condonation denied",
    ],
  },
  {
    match: /\b(?:time[-\s]*barred|barred by limitation|dismissed as time barred|limitation)\b/i,
    expansions: [
      "appeal dismissed as time barred",
      "barred by limitation",
      "dismissed on limitation",
    ],
  },
  {
    match: /\b(?:sanction\s+required|prior sanction|mandatory sanction|required)\b/i,
    expansions: [
      "sanction required for prosecution",
      "prior sanction mandatory",
      "previous sanction required",
    ],
  },
  {
    match: /\b(?:sanction\s+not\s+required|without\s+sanction|no\s+sanction\s+required|not required)\b/i,
    expansions: [
      "sanction not required",
      "without prior sanction",
      "no sanction required",
    ],
  },
];

function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function tokenize(input: string): string[] {
  return normalize(input)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token) && !CONNECTOR_NOISE.has(token));
}

function sanitizePhrase(input: string, maxWords = 12): string {
  const normalized = normalize(input)
    .replace(/\b(?:doctypes|sortby|fromdate|todate):\S+/gi, " ")
    .replace(/\b(?:cases?\s+where|precedents?\s+where|judgments?\s+where)\b/gi, " ")
    .replace(/\b(?:find|show|list)\s+(?:me\s+)?(?:cases?|precedents?|judgments?)\b/gi, " ")
    .replace(/[^a-z0-9\s()/.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.split(/\s+/).slice(0, maxWords).join(" ");
}

function expandHighImpactSynonyms(values: string[]): string[] {
  const normalized = unique(values.map((value) => sanitizePhrase(value, 12)).filter(Boolean));
  const bag = normalize(normalized.join(" "));
  const expanded = [...normalized];
  for (const rule of HIGH_IMPACT_SYNONYM_RULES) {
    if (!rule.match.test(bag)) continue;
    expanded.push(...rule.expansions.map((value) => sanitizePhrase(value, 12)));
  }
  return unique(expanded.filter((value) => value.length >= 6)).slice(0, 16);
}

function buildNgramWindows(query: string): string[] {
  const terms = tokenize(query);
  const windows: string[] = [];
  for (const size of [3, 4, 5]) {
    if (terms.length < size) continue;
    for (let i = 0; i <= terms.length - size; i += 1) {
      windows.push(terms.slice(i, i + size).join(" "));
    }
  }
  return unique(windows).slice(0, 20);
}

function addCourtVariants(phrase: string): string[] {
  const base = sanitizePhrase(phrase, 10);
  if (!base) return [];
  return [`${base} supreme court`, `${base} high court`].map((value) => sanitizePhrase(value, 12));
}

function countHookHits(phrase: string, hooks: string[]): number {
  const normalized = normalize(phrase);
  let hits = 0;
  for (const hook of hooks) {
    const base = normalize(hook).replace(/^section\s+/, "").trim();
    if (!base) continue;
    if (normalized.includes(base) || normalized.includes(`section ${base}`)) {
      hits += 1;
    }
  }
  return hits;
}

function hasNoHookAxisStructure(
  phrase: string,
  actorTokens: Set<string>,
  procedureTokens: Set<string>,
  outcomeTokens: Set<string>,
): boolean {
  const tokens = tokenize(phrase);
  if (tokens.length < 4) return false;
  const hasActor = actorTokens.size > 0 && tokens.some((token) => actorTokens.has(token));
  const hasProcedure = procedureTokens.size > 0 && tokens.some((token) => procedureTokens.has(token));
  const hasOutcome = outcomeTokens.size > 0 && tokens.some((token) => outcomeTokens.has(token));
  return hasActor && hasProcedure && hasOutcome;
}

function propositionConcepts(context: ContextProfile): string[] {
  const concepts: string[] = [];
  concepts.push(...context.actors);
  concepts.push(...context.procedures);
  concepts.push(...context.statutesOrSections);
  concepts.push(...context.issues);
  concepts.push(...context.domains);
  return unique(concepts.map((value) => sanitizePhrase(value, 10)).filter((value) => value.length >= 4));
}

function buildHookIntersectionPhrases(context: ContextProfile): string[] {
  const hooks = context.statutesOrSections.map((hook) => sanitizePhrase(hook, 8)).filter((hook) => hook.length > 3);
  if (hooks.length < 2) return [];

  const outcomes = context.issues.slice(0, 3).map((issue) => sanitizePhrase(issue, 6));
  const procedures = context.procedures.slice(0, 3).map((procedure) => sanitizePhrase(procedure, 6));
  const intersections: string[] = [];

  for (let i = 0; i < Math.min(hooks.length, 3); i += 1) {
    for (let j = i + 1; j < Math.min(hooks.length, 4); j += 1) {
      intersections.push(sanitizePhrase(`${hooks[i]} ${hooks[j]}`, 11));
      for (const outcome of outcomes) {
        intersections.push(sanitizePhrase(`${hooks[i]} ${hooks[j]} ${outcome}`, 12));
      }
      for (const procedure of procedures) {
        intersections.push(sanitizePhrase(`${hooks[i]} ${hooks[j]} ${procedure}`, 12));
      }
    }
  }
  return unique(intersections.filter((value) => value.length >= 10)).slice(0, 12);
}

function combineAxes(context: ContextProfile): string[] {
  const actors = context.actors.slice(0, 3);
  const procedures = context.procedures.slice(0, 3);
  const hooks = context.statutesOrSections.slice(0, 4);
  const outcomes = context.issues.slice(0, 4);
  const phrases: string[] = [];

  for (const procedure of procedures) {
    for (const actor of actors.length > 0 ? actors : [""]) {
      for (const hook of hooks.length > 0 ? hooks : [""]) {
        const phrase = sanitizePhrase(`${actor} ${procedure} ${hook}`.trim(), 12);
        if (phrase.length >= 8) phrases.push(phrase);
      }
    }
  }

  for (const outcome of outcomes) {
    for (const procedure of procedures.length > 0 ? procedures : [""]) {
      const phrase = sanitizePhrase(`${outcome} ${procedure}`.trim(), 12);
      if (phrase.length >= 8) phrases.push(phrase);
    }
  }

  for (const hook of hooks) {
    for (const outcome of outcomes.length > 0 ? outcomes : [""]) {
      const phrase = sanitizePhrase(`${hook} ${outcome}`.trim(), 12);
      if (phrase.length >= 8) phrases.push(phrase);
    }
  }

  return unique(phrases);
}

export function buildKeywordPack(query: string, context: ContextProfile): KeywordPack {
  const queryTokens = tokenize(query);
  const windows = buildNgramWindows(query);
  const concepts = propositionConcepts(context);
  const highImpactSynonyms = expandHighImpactSynonyms([
    query,
    ...context.issues,
    ...context.procedures,
    ...context.statutesOrSections,
  ]);
  const coreHooks = context.statutesOrSections
    .map((hook) => sanitizePhrase(hook, 8))
    .filter((hook) => hook.length > 2)
    .slice(0, 6);
  const multiHookMode = coreHooks.length >= 2;
  const noHookMode = coreHooks.length === 0;
  const hookIntersections = buildHookIntersectionPhrases(context);
  const axisPhrases = combineAxes(context);
  const actorTokens = new Set(context.actors.flatMap((value) => tokenize(value)));
  const procedureTokens = new Set(context.procedures.flatMap((value) => tokenize(value)));
  const outcomeTokens = new Set(context.issues.flatMap((value) => tokenize(value)));

  const legalSignals = unique([...context.statutesOrSections, ...context.procedures, ...context.issues])
    .map((value) => sanitizePhrase(value, 10))
    .filter((value) => value.length >= 4)
    .slice(0, 16);

  const rawSearchPhrases = unique([
    ...hookIntersections,
    ...highImpactSynonyms,
    ...axisPhrases.slice(0, 10),
    ...concepts.slice(0, 8),
    ...axisPhrases.slice(0, 4).flatMap((phrase) => addCourtVariants(phrase)),
    ...hookIntersections.slice(0, 3).flatMap((phrase) => addCourtVariants(phrase)),
    ...windows.slice(0, 4),
  ])
    .map((value) => sanitizePhrase(value, 12))
    .filter((value) => value.length >= 8);

  const searchPhrases = rawSearchPhrases
    .filter((value) => {
      if (!multiHookMode) return true;
      return countHookHits(value, coreHooks) >= 1;
    })
    .filter((value) => {
      if (!noHookMode) return true;
      return hasNoHookAxisStructure(value, actorTokens, procedureTokens, outcomeTokens);
    })
    .slice(0, 24);

  const rawPrimary = unique([
    ...concepts,
    ...highImpactSynonyms,
    ...queryTokens,
    ...legalSignals,
    ...windows,
    ...axisPhrases,
  ]);
  const primary = rawPrimary
    .filter((value) => {
      if (!multiHookMode) return true;
      if (hookIntersections.includes(value)) return true;
      return countHookHits(value, coreHooks) >= 1;
    })
    .filter((value) => {
      if (!noHookMode) return true;
      if (value.split(/\s+/).length < 2) return false;
      return hasNoHookAxisStructure(value, actorTokens, procedureTokens, outcomeTokens);
    })
    .slice(0, 36);

  return {
    primary,
    legalSignals,
    searchPhrases,
  };
}
