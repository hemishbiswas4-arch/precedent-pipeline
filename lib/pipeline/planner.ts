import { buildKeywordPackWithAI } from "@/lib/ai-keyword-planner";
import { expandOntologySynonymsForRecall } from "@/lib/kb/legal-ontology";
import { buildKeywordPack } from "@/lib/keywords";
import { sanitizeNlqForSearch } from "@/lib/nlq";
import {
  IntentProfile,
  PlannerOutput,
  QueryRetrievalDirectives,
  QueryVariant,
  RetrievalDoctypeProfile,
} from "@/lib/pipeline/types";
import { ReasonerOutcomePolarity, ReasonerPlan } from "@/lib/reasoner-schema";
import { CaseCandidate, KeywordPack, ScoredCase } from "@/lib/types";

type HookGroupPlan = {
  groupId: string;
  terms: string[];
  representative: string;
  required: boolean;
};

const HIGH_IMPACT_OUTCOME_SYNONYMS: Array<{ match: RegExp; expansions: string[] }> = [
  {
    match: /\b(?:delay\s+not\s+condoned|condonation(?:\s+of\s+delay)?\s+(?:refused|rejected|denied|declined))\b/i,
    expansions: [
      "condonation of delay refused",
      "application for condonation rejected",
      "delay condonation denied",
    ],
  },
  {
    match: /\b(?:time\s*barred|barred by limitation|appeal dismissed as time barred|dismissed on limitation)\b/i,
    expansions: [
      "appeal dismissed as time barred",
      "barred by limitation",
      "dismissed on limitation",
    ],
  },
  {
    match: /\b(?:sanction\s+required|mandatory sanction|required)\b/i,
    expansions: [
      "prior sanction mandatory",
      "previous sanction required",
      "sanction required for prosecution",
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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

const IK_INTENT_V2_ENABLED = parseBoolean(process.env.IK_INTENT_V2, true);

function defaultDoctypeProfile(scope: QueryVariant["courtScope"]): RetrievalDoctypeProfile {
  if (scope === "SC") return "supremecourt";
  if (scope === "HC") return "highcourts";
  return "judgments_sc_hc_tribunal";
}

function defaultQueryMode(
  phase: QueryVariant["phase"],
  strictness: QueryVariant["strictness"],
): QueryRetrievalDirectives["queryMode"] {
  if (strictness === "strict") return "precision";
  if (phase === "rescue" || phase === "micro") return "context";
  return "expansion";
}

function buildDefaultRetrievalDirectives(input: {
  phase: QueryVariant["phase"];
  strictness: QueryVariant["strictness"];
  courtScope: QueryVariant["courtScope"];
}): QueryRetrievalDirectives {
  const queryMode = defaultQueryMode(input.phase, input.strictness);
  return {
    queryMode,
    doctypeProfile: defaultDoctypeProfile(input.courtScope),
    applyContradictionExclusions: queryMode === "precision" && !IK_INTENT_V2_ENABLED,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  }
  return hash;
}

function normalizePhrase(value: string): string {
  return sanitizeNlqForSearch(value)
    .replace(/\b(?:doctypes|sortby|fromdate|todate):\S+/gi, " ")
    .replace(/\b(?:cases?\s+where|precedents?\s+where|judgments?\s+where)\b/gi, " ")
    .replace(/\b(?:find|show|list)\s+(?:me\s+)?(?:cases?|precedents?|judgments?)\b/gi, " ")
    .replace(/[^a-z0-9\s()/.:-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isMeaningfulToken(token: string): boolean {
  if (!token) return false;
  if (/^\d+$/.test(token)) return true;
  return token.length > 1;
}

function tokenizePhrase(value: string): string[] {
  return normalizePhrase(value).split(/\s+/).filter((token) => isMeaningfulToken(token));
}

function sanitizeTokens(tokens: string[], maxWords: number): string {
  const filtered = tokens.filter((token) => isMeaningfulToken(token));
  const deduped: string[] = [];
  for (const token of filtered) {
    if (deduped[deduped.length - 1] === token) continue;
    deduped.push(token);
  }
  return deduped.slice(0, maxWords).join(" ").trim();
}

function withCourtSuffix(phrase: string, court: "supreme court" | "high court"): string {
  const normalized = normalizePhrase(phrase);
  if (!normalized) return "";
  if (normalized.includes(court)) return normalized;
  return normalizePhrase(`${normalized} ${court}`);
}

function defaultVariantPriority(
  phase: QueryVariant["phase"],
  strictness: QueryVariant["strictness"],
): number {
  const phaseBase: Record<QueryVariant["phase"], number> = {
    primary: 92,
    fallback: 78,
    rescue: 62,
    micro: 56,
    revolving: 48,
    browse: 42,
  };
  const strictBonus = strictness === "strict" ? 12 : 0;
  return phaseBase[phase] + strictBonus;
}

function inferExplicitCourtScope(value: string): QueryVariant["courtScope"] {
  const normalized = normalizePhrase(value);
  const hasSc = /\bsupreme court\b|\bsc\b/.test(normalized);
  const hasHc = /\bhigh court\b|\bhc\b/.test(normalized);
  if (hasSc && !hasHc) return "SC";
  if (hasHc && !hasSc) return "HC";
  return "ANY";
}

function resolveCourtScope(
  intentCourtHint: QueryVariant["courtScope"],
  reasonerHint: ReasonerPlan["proposition"]["jurisdiction_hint"] | undefined,
): QueryVariant["courtScope"] {
  if (reasonerHint === "SC") return "SC";
  if (reasonerHint === "HC") return "HC";
  return intentCourtHint;
}

function buildVariant(
  phase: QueryVariant["phase"],
  purpose: string,
  phrase: string,
  idx: number,
  courtScope: QueryVariant["courtScope"],
  strictness: QueryVariant["strictness"],
  metadata?: {
    canonicalKey?: string;
    priority?: number;
    mustIncludeTokens?: string[];
    mustExcludeTokens?: string[];
    providerHints?: QueryVariant["providerHints"];
    retrievalDirectives?: QueryRetrievalDirectives;
  },
): QueryVariant {
  const cleaned = normalizePhrase(phrase);
  const tokens = tokenizePhrase(cleaned).slice(0, phase === "primary" ? 12 : 10);
  const normalizedPhrase = tokens.join(" ");
  const canonicalKey =
    metadata?.canonicalKey?.trim().toLowerCase() ||
    `${phase}:${strictness}:${normalizePhrase(`${purpose} ${normalizedPhrase}`)}`;
  return {
    id: `${phase}_${idx}_${Math.abs(hashString(cleaned)).toString(36)}`,
    phrase: normalizedPhrase,
    phase,
    purpose,
    courtScope,
    strictness,
    tokens,
    canonicalKey,
    priority: metadata?.priority ?? defaultVariantPriority(phase, strictness),
    mustIncludeTokens: metadata?.mustIncludeTokens,
    mustExcludeTokens: metadata?.mustExcludeTokens,
    providerHints: metadata?.providerHints,
    retrievalDirectives:
      metadata?.retrievalDirectives ??
      (IK_INTENT_V2_ENABLED
        ? buildDefaultRetrievalDirectives({
            phase,
            strictness,
            courtScope,
          })
        : undefined),
  };
}

function inferHookGroupId(term: string): string {
  const normalized = normalizePhrase(term);
  if (/prevention of corruption|pc act/.test(normalized)) return "pc_act";
  if (/\bcrpc\b|criminal procedure/.test(normalized)) return "crpc";
  if (/\bipc\b|indian penal code/.test(normalized)) return "ipc";
  if (/\bcpc\b|civil procedure/.test(normalized)) return "cpc";
  if (/limitation act/.test(normalized)) return "limitation_act";
  const section = normalized.match(/\bsection\s*([0-9]+(?:\([0-9a-z]+\))*(?:\([a-z]\))?)/i);
  if (section) {
    return `sec_${section[1].replace(/[^0-9a-z]+/gi, "_").toLowerCase()}`;
  }
  const tokens = tokenizePhrase(normalized).slice(0, 3);
  return tokens.length > 0 ? `hook_${tokens.join("_")}` : "hook_generic";
}

function expandHookTerms(term: string): string[] {
  const normalized = normalizePhrase(term);
  if (!normalized) return [];
  const expanded = [normalized];
  const sectionMatch = normalized.match(/\bsection\s*([0-9]+(?:\([0-9a-z]+\))*(?:\([a-z]\))?)/i);
  if (sectionMatch) {
    const section = sectionMatch[1];
    expanded.push(`section ${section}`, section, section.replace(/[()]/g, " "));
  }
  if (/prevention of corruption|pc act/.test(normalized)) {
    expanded.push("prevention of corruption act", "pc act");
  }
  if (/\bcrpc\b|criminal procedure/.test(normalized)) {
    expanded.push("crpc", "code of criminal procedure", "section 197 crpc");
  }
  return unique(expanded.map((value) => normalizePhrase(value)).filter(Boolean)).slice(0, 8);
}

function hasDelayCondonationContext(cleanedQuery: string, outcomeTerms: string[]): boolean {
  const q = normalizePhrase(`${cleanedQuery} ${outcomeTerms.join(" ")}`);
  return /\b(?:condonation(?:\s+of\s+delay)?|delay\s+condonation|section\s*5\s+limitation|limitation\s+act|time[-\s]*barred|barred\s+by\s+limitation|not\s+condon(?:ed|able)|condon(?:ed|ation|able))\b/.test(
    q,
  );
}

function hasLimitationContextInQuery(cleanedQuery: string): boolean {
  const q = normalizePhrase(cleanedQuery);
  return /\b(?:condonation|delay|limitation|time[-\s]*barred|barred\s+by\s+limitation|section\s*5)\b/.test(q);
}

function filterReasonerOutcomeTermsByContext(cleanedQuery: string, terms: string[]): string[] {
  const limitationContext = hasLimitationContextInQuery(cleanedQuery);
  if (limitationContext) return terms;
  return terms.filter((term) => {
    const normalized = normalizePhrase(term);
    if (!normalized) return false;
    if (
      /\b(?:condonation|delay|time[-\s]*barred|barred\s+by\s+limitation|dismissed on limitation|dismissed as time[-\s]*barred)\b/.test(
        normalized,
      )
    ) {
      return false;
    }
    return true;
  });
}

function inferRoleCueTokens(cleanedQuery: string): string[] {
  const q = normalizePhrase(cleanedQuery);
  const cues: string[] = [];
  if (/\brespondent\b/.test(q)) cues.push("respondent");
  if (/\bappellant\b/.test(q)) cues.push("appellant");
  if (/\bpetitioner\b/.test(q)) cues.push("petitioner");
  if (/\brevisionist\b/.test(q)) cues.push("revisionist");
  if (/\bcomplainant\b/.test(q)) cues.push("complainant");
  return unique(cues);
}

function inferOutcomePolarityCue(cleanedQuery: string, outcomeTerms: string[]): string[] {
  const q = normalizePhrase(`${cleanedQuery} ${outcomeTerms.join(" ")}`);
  const cues: string[] = [];
  const delayContext = hasDelayCondonationContext(cleanedQuery, outcomeTerms);
  if (/\bsanction\b/.test(q)) {
    const sanctionNotRequired = /\b(?:sanction\s+not\s+required|not\s+required|no\s+sanction\s+required|sanction\s+unnecessary|without\s+(?:prior|previous\s+)?sanction)\b/.test(
      q,
    );
    if (
      /\b(?:cannot|can not|not)\s+(?:continue|proceed|launch|take cognizance)[a-z\s]{0,40}\bwithout\s+sanction\b/.test(
        q,
      ) ||
      /\bunless\s+(?:prior|previous)?\s*sanction\b/.test(q)
    ) {
      cues.push("sanction required");
    }
    if (sanctionNotRequired) {
      cues.push("sanction not required");
    }
    if (
      !sanctionNotRequired &&
      /\b(?:sanction\s+required|prior\s+sanction|previous\s+sanction|mandatory\s+sanction)\b/.test(q)
    ) {
      cues.push("sanction required");
    }
  }
  if (
    /\bdelay\s+(?:has|was|is|had)?\s*not\s+(?:been\s+)?condon(?:ed|able)\b/.test(q) ||
    /\bnot\s+(?:been\s+|is\s+|was\s+)?condon(?:ed|able)\b/.test(q) ||
    /\bcondonation(?:\s+of\s+delay)?\s+(?:was\s+|is\s+|has\s+been\s+)?(?:refused|rejected|denied|dismissed|declined)\b/.test(
      q,
    ) ||
    /\bcondonation(?:\s+of\s+delay)?\s+not\s+granted\b/.test(q) ||
    (delayContext && /\b(?:not condoned|refused|rejected|declined|denied)\b/.test(q))
  ) {
    cues.push("delay not condoned");
  }
  if (
    /\b(?:time barred|barred by limitation|dismissed\s+as\s+time[-\s]*barred|dismissed on limitation)\b/.test(q) ||
    (hasLimitationContextInQuery(cleanedQuery) && /\bdismissed\b/.test(q))
  ) {
    cues.push("appeal dismissed as time barred");
  }
  if (/\bquashed\b/.test(q)) {
    cues.push("proceedings quashed");
  }
  return unique(cues);
}

function inferExpectedPolarity(
  cleanedQuery: string,
  outcomeTerms: string[],
  reasonerPlan?: ReasonerPlan,
): ReasonerOutcomePolarity {
  const planPolarity = reasonerPlan?.proposition.outcome_constraint.polarity;
  if (planPolarity && planPolarity !== "unknown") {
    return planPolarity;
  }
  const q = normalizePhrase(`${cleanedQuery} ${outcomeTerms.join(" ")}`);
  if (
    /\b(?:cannot|can not|not)\s+(?:continue|proceed|launch|take cognizance)[a-z\s]{0,40}\bwithout\s+sanction\b/.test(
      q,
    ) ||
    /\bunless\s+(?:prior|previous)?\s*sanction\b/.test(q)
  ) {
    return "required";
  }
  const sanctionNotRequired = /\b(?:sanction\s+not\s+required|not\s+required|no\s+sanction\s+required|sanction\s+unnecessary|without\s+(?:prior|previous\s+)?sanction)\b/.test(
    q,
  );
  if (sanctionNotRequired) {
    return "not_required";
  }
  if (/\b(?:appeal\s+dismissed|dismissed\s+as\s+time[-\s]*barred|barred\s+by\s+limitation|time[-\s]*barred)\b/.test(q)) {
    return "dismissed";
  }
  if (
    /\b(?:delay\s+not\s+condon(?:ed|able)|condonation(?:\s+of\s+delay)?\s+(?:refused|rejected|denied|dismissed|declined)|not\s+condon(?:ed|able))\b/.test(
      q,
    )
  ) {
    return "refused";
  }
  if (/\bquashed\b/.test(q)) {
    return "quashed";
  }
  if (/\b(?:sanction\s+required|prior\s+sanction|previous\s+sanction|mandatory\s+sanction)\b/.test(q)) {
    return "required";
  }
  return "unknown";
}

function filterPolarityCues(
  cues: string[],
  expectedPolarity: ReasonerOutcomePolarity,
): string[] {
  if (cues.length === 0) return cues;
  if (expectedPolarity === "required") {
    return cues.filter((cue) => cue !== "sanction not required");
  }
  if (expectedPolarity === "not_required") {
    return cues.filter((cue) => cue !== "sanction required");
  }
  if (expectedPolarity === "dismissed") {
    return cues.filter((cue) => cue !== "delay not condoned");
  }
  if (expectedPolarity === "refused") {
    return cues.filter((cue) => cue !== "appeal dismissed as time barred");
  }
  return cues;
}

function expandOutcomeSynonyms(values: string[]): string[] {
  const normalized = unique(values.map((value) => normalizePhrase(value)).filter(Boolean));
  const bag = normalizePhrase(normalized.join(" "));
  const expanded = [...normalized];
  for (const entry of HIGH_IMPACT_OUTCOME_SYNONYMS) {
    if (!entry.match.test(bag)) continue;
    expanded.push(...entry.expansions);
  }
  return unique(expanded.map((value) => normalizePhrase(value)).filter(Boolean)).slice(0, 16);
}

function requiredPolarityTokens(intent: IntentProfile, reasonerPlan?: ReasonerPlan): string[] {
  const reasonerOutcomeTerms = filterReasonerOutcomeTermsByContext(
    intent.cleanedQuery,
    reasonerPlan?.proposition.outcome_required ?? [],
  );
  const outcomeTerms = reasonerOutcomeTerms.length > 0 ? reasonerOutcomeTerms : intent.issues;
  const rawCues = inferOutcomePolarityCue(
    intent.cleanedQuery,
    outcomeTerms,
  );
  const expectedPolarity = inferExpectedPolarity(
    intent.cleanedQuery,
    outcomeTerms,
    reasonerPlan,
  );
  const cues = expandOutcomeSynonyms(filterPolarityCues(rawCues, expectedPolarity));
  return unique(cues.flatMap((cue) => tokenizePhrase(cue))).slice(0, 4);
}

function buildRequiredHookGroups(intent: IntentProfile, reasonerPlan?: ReasonerPlan): HookGroupPlan[] {
  const groups = new Map<string, HookGroupPlan>();

  for (const group of reasonerPlan?.proposition.hook_groups ?? []) {
    if (!group.required || group.terms.length === 0) continue;
    const normalizedTerms = unique(group.terms.map((term) => normalizePhrase(term)).filter(Boolean));
    if (normalizedTerms.length === 0) continue;
    const groupId = inferHookGroupId(group.group_id || normalizedTerms[0]);
    groups.set(groupId, {
      groupId,
      terms: normalizedTerms.slice(0, 10),
      representative: normalizedTerms[0],
      required: true,
    });
  }

  for (const hook of [
    ...intent.statutes,
    ...intent.entities.section,
    ...intent.entities.statute,
    ...(reasonerPlan?.proposition.legal_hooks ?? []),
  ]) {
    const normalized = normalizePhrase(hook);
    if (!normalized) continue;
    const groupId = inferHookGroupId(normalized);
    const existing = groups.get(groupId);
    const terms = expandHookTerms(normalized);
    if (!existing) {
      groups.set(groupId, {
        groupId,
        terms,
        representative: terms[0] ?? normalized,
        required: true,
      });
      continue;
    }
    existing.terms = unique([...existing.terms, ...terms]).slice(0, 10);
  }

  return Array.from(groups.values()).slice(0, 6);
}

function phraseMatchesAllRequiredGroups(phrase: string, requiredHookGroups: HookGroupPlan[]): boolean {
  if (requiredHookGroups.length === 0) return true;
  const normalized = normalizePhrase(phrase);
  return requiredHookGroups.every((group) => group.terms.some((term) => normalized.includes(term)));
}

function representativeHooks(requiredHookGroups: HookGroupPlan[]): string[] {
  return requiredHookGroups
    .map((group) => group.representative)
    .filter(Boolean)
    .map((value) => sanitizeTokens(tokenizePhrase(value), 5))
    .filter((value) => value.length > 2);
}

function doctrinalHookTokenSet(requiredHookGroups: HookGroupPlan[]): Set<string> {
  const tokens = requiredHookGroups
    .flatMap((group) => group.terms)
    .flatMap((value) => tokenizePhrase(value))
    .filter((value) => value.length > 1);
  return new Set(unique(tokens).slice(0, 24));
}

function hasMinimumLegalSignal(tokens: string[], legalSignalTokens: Set<string>): boolean {
  return tokens.some((token) => legalSignalTokens.has(token)) || tokens.length >= 4;
}

function buildLegalSignalTokenSet(intent: IntentProfile, reasonerPlan?: ReasonerPlan): Set<string> {
  const bag = [
    ...intent.domains,
    ...intent.actors,
    ...intent.entities.person,
    ...intent.entities.org,
    ...intent.procedures,
    ...intent.issues,
    ...intent.statutes,
    ...intent.entities.statute,
    ...intent.entities.section,
    ...intent.entities.case_citation,
    ...(reasonerPlan?.proposition.actors ?? []),
    ...(reasonerPlan?.proposition.proceeding ?? []),
    ...(reasonerPlan?.proposition.legal_hooks ?? []),
    ...(reasonerPlan?.proposition.hook_groups ?? []).flatMap((group) => group.terms),
    ...(reasonerPlan?.proposition.outcome_required ?? []),
    ...(reasonerPlan?.must_have_terms ?? []),
  ]
    .flatMap((value) => tokenizePhrase(value))
    .filter((token) => isMeaningfulToken(token));
  return new Set(unique(bag));
}

function axisValuesFromReasonerOrIntent(
  reasonerValues: string[] | undefined,
  intentValues: string[],
  fallback: string[],
): string[] {
  const values = unique([...(reasonerValues ?? []), ...intentValues, ...fallback].map((value) => normalizePhrase(value)))
    .filter((value) => value.length > 1)
    .slice(0, 8);
  return values;
}

type StrictAxisRequirement = {
  enabled: boolean;
  actorTokens: Set<string>;
  proceedingTokens: Set<string>;
  outcomeTokens: Set<string>;
  roleTokens: Set<string>;
  chainTokens: Set<string>;
};

function buildPropositionStrategy(input: {
  intent: IntentProfile;
  reasonerPlan?: ReasonerPlan;
  keywordPack: KeywordPack;
}): {
  strict: string[];
  broad: string[];
  strictGroupCount: number;
  strictVariantsPreservedAllGroups: boolean;
  strictAxisRequirement: StrictAxisRequirement;
} {
  const { intent, reasonerPlan, keywordPack } = input;
  const actors = axisValuesFromReasonerOrIntent(
    reasonerPlan?.proposition.actors,
    [...intent.actors, ...intent.entities.person, ...intent.entities.org],
    intent.cleanedQuery.includes("state") ? ["state"] : [],
  );
  const reasonerOutcomeTerms = filterReasonerOutcomeTermsByContext(
    intent.cleanedQuery,
    reasonerPlan?.proposition.outcome_required ?? [],
  );
  const proceedings = axisValuesFromReasonerOrIntent(
    reasonerPlan?.proposition.proceeding,
    intent.procedures,
    [],
  );
  const requiredHookGroups = buildRequiredHookGroups(intent, reasonerPlan);
  const hooks = representativeHooks(requiredHookGroups);
  const outcomes = axisValuesFromReasonerOrIntent(
    reasonerOutcomeTerms,
    [...intent.issues, ...intent.entities.case_citation],
    [],
  );
  const expectedPolarity = inferExpectedPolarity(intent.cleanedQuery, outcomes, reasonerPlan);
  const polarityCues = expandOutcomeSynonyms(
    filterPolarityCues(inferOutcomePolarityCue(intent.cleanedQuery, outcomes), expectedPolarity),
  );
  const polarityCueTokens = polarityCues.flatMap((cue) => tokenizePhrase(cue));

  const strict: string[] = [];
  const broad: string[] = [];
  const noHookStrictMode = requiredHookGroups.length === 0;
  const noHookActorRequired = noHookStrictMode && actors.length > 0;
  const noHookProceedingRequired = noHookStrictMode && proceedings.length > 0;
  const noHookOutcomeRequired = noHookStrictMode && (polarityCues.length > 0 || outcomes.length > 0);

  const actorPool = actors.length > 0 ? actors : [""];
  const proceedingPool = proceedings.length > 0 ? proceedings : [""];
  const hookPhrase = hooks.join(" ");
  const outcomePool = polarityCues.length > 0 ? polarityCues : outcomes.length > 0 ? outcomes : [""];

  for (const actor of actorPool.slice(0, 3)) {
    for (const proceeding of proceedingPool.slice(0, 3)) {
      for (const outcome of outcomePool.slice(0, 3)) {
        if (
          noHookStrictMode &&
          ((noHookActorRequired && !actor) ||
            (noHookProceedingRequired && !proceeding) ||
            (noHookOutcomeRequired && !outcome))
        ) {
          continue;
        }
        const phrase = sanitizeTokens(
          tokenizePhrase(`${actor} ${proceeding} ${hookPhrase} ${outcome}`),
          noHookStrictMode ? 12 : 13,
        );
        if (phrase.length >= (noHookStrictMode ? 10 : 8) && phraseMatchesAllRequiredGroups(phrase, requiredHookGroups)) {
          strict.push(phrase);
        }
      }
    }
  }

  for (const proceeding of proceedingPool.slice(0, 4)) {
    for (const outcome of outcomePool.slice(0, 4)) {
      const phrase = sanitizeTokens(tokenizePhrase(`${proceeding} ${hookPhrase} ${outcome}`), 12);
      if (phrase.length >= 6 && phraseMatchesAllRequiredGroups(phrase, requiredHookGroups)) broad.push(phrase);
    }
    if (hookPhrase) {
      const phrase = sanitizeTokens(tokenizePhrase(`${proceeding} ${hookPhrase}`), 11);
      if (phrase.length >= 6 && phraseMatchesAllRequiredGroups(phrase, requiredHookGroups)) broad.push(phrase);
    }
  }

  for (const phrase of [...keywordPack.searchPhrases, ...keywordPack.primary].slice(0, 14)) {
    if (phraseMatchesAllRequiredGroups(phrase, requiredHookGroups)) broad.push(phrase);
  }
  for (const anchor of reasonerPlan?.case_anchors ?? []) {
    if (phraseMatchesAllRequiredGroups(anchor, requiredHookGroups)) broad.push(anchor);
  }

  const strictNormalized = unique(strict)
    .filter((phrase) => {
      if (polarityCueTokens.length === 0) return true;
      const phraseTokens = tokenizePhrase(phrase);
      const matched = polarityCueTokens.filter((token) => phraseTokens.includes(token)).length;
      const minMatched = Math.min(2, Math.max(1, Math.ceil(polarityCueTokens.length * 0.35)));
      return matched >= minMatched;
    })
    .slice(0, 24);
  const broadNormalized = unique(broad).slice(0, 32);
  const strictVariantsPreservedAllGroups =
    strictNormalized.length > 0
      ? strictNormalized.every((phrase) => phraseMatchesAllRequiredGroups(phrase, requiredHookGroups))
      : requiredHookGroups.length === 0;

  const strictAxisRequirement: StrictAxisRequirement = {
    enabled: noHookStrictMode,
    actorTokens: new Set(actors.flatMap((value) => tokenizePhrase(value))),
    proceedingTokens: new Set(proceedings.flatMap((value) => tokenizePhrase(value))),
    outcomeTokens: new Set((polarityCues.length > 0 ? polarityCues : outcomes).flatMap((value) => tokenizePhrase(value))),
    roleTokens: new Set(inferRoleCueTokens(intent.cleanedQuery).flatMap((value) => tokenizePhrase(value))),
    chainTokens: new Set(
      tokenizePhrase(
        [
          hasDelayCondonationContext(intent.cleanedQuery, outcomes)
            ? "condonation delay"
            : "",
          hasDelayCondonationContext(intent.cleanedQuery, outcomes) &&
          polarityCues.some((value) => /not condoned|refused|dismissed|time barred/i.test(value))
            ? "not condoned dismissed"
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      ),
    ),
  };

  return {
    strict: strictNormalized,
    broad: broadNormalized,
    strictGroupCount: requiredHookGroups.length,
    strictVariantsPreservedAllGroups,
    strictAxisRequirement,
  };
}

function appendPhaseVariants(input: {
  output: QueryVariant[];
  seen: Set<string>;
  phase: QueryVariant["phase"];
  purpose: string;
  phrases: string[];
  courtScope: QueryVariant["courtScope"];
  strictness: QueryVariant["strictness"];
  courted: boolean;
  legalSignalTokens: Set<string>;
  requiredHookGroups?: HookGroupPlan[];
  enforceAllGroups?: boolean;
  polarityTokens?: string[];
  doctrinalHookTokens?: Set<string>;
  strictAxisRequirement?: StrictAxisRequirement;
}): void {
  const {
    output,
    seen,
    phase,
    purpose,
    phrases,
    courtScope,
    strictness,
    courted,
    legalSignalTokens,
    requiredHookGroups = [],
    enforceAllGroups = false,
    polarityTokens = [],
    doctrinalHookTokens = new Set<string>(),
    strictAxisRequirement,
  } = input;

  let idx = output.length;
  for (const rawPhrase of phrases) {
    const normalized = normalizePhrase(rawPhrase);
    if (!normalized || normalized.length < 4) continue;

    const base = normalized
      .replace(/\b(?:supreme court|high court)\b/g, " ")
      .replace(/\b(?:supreme|high)\b(?=\s*(?:$|and|or))/g, " ")
      .replace(/\b(?:and|or)\b(?=\s*(?:$|and|or))/g, " ")
      .replace(/[().,:;/-]+$/g, " ")
      .replace(/\b(?:and|or|the)\b(?:\s+\b(?:and|or|the)\b)*\s*$/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const phraseCandidates =
      courted && courtScope !== "ANY"
        ? [withCourtSuffix(base, courtScope === "SC" ? "supreme court" : "high court")]
        : courted
          ? [withCourtSuffix(base, "supreme court"), withCourtSuffix(base, "high court"), base]
          : [base];

    for (const candidate of phraseCandidates) {
      const tokens = tokenizePhrase(candidate).slice(0, phase === "primary" ? 12 : 10);
      if (tokens.length < 2) continue;
      const strictHookGuard = !IK_INTENT_V2_ENABLED || (phase === "primary" && strictness === "strict");
      if (enforceAllGroups && strictHookGuard && !phraseMatchesAllRequiredGroups(candidate, requiredHookGroups)) {
        continue;
      }
      if ((phase === "primary" || phase === "fallback") && !hasMinimumLegalSignal(tokens, legalSignalTokens)) {
        continue;
      }
      if (polarityTokens.length > 0 && strictness === "strict") {
        const strictPolarityGuard = !IK_INTENT_V2_ENABLED || phase === "primary";
        if (!strictPolarityGuard) {
          // In intent-first mode, keep polarity as a scoring/gating signal, not a hard retrieval filter.
          const explicitScope = inferExplicitCourtScope(candidate);
          const phrase = tokens.join(" ");
          if (phrase.length < 6 || tokens.length < 3) continue;
          const signature = `${phase}|${phrase}`;
          if (seen.has(signature)) continue;
          seen.add(signature);
          output.push(
            buildVariant(
              phase,
              purpose,
              phrase,
              idx,
              explicitScope === "ANY" ? courtScope : explicitScope,
              strictness,
              {
                canonicalKey: `${purpose}:${phase}:${phrase}`,
              },
            ),
          );
          idx += 1;
          continue;
        }
        const tokenSet = new Set(tokens);
        const enforcePolarityAndHook = enforceAllGroups && doctrinalHookTokens.size > 0;
        if (enforcePolarityAndHook) {
          const hasPolarityCue = polarityTokens.some((token) => tokenSet.has(token));
          const hasDoctrinalHook = Array.from(doctrinalHookTokens).some((token) => tokenSet.has(token));
          if (!hasPolarityCue || !hasDoctrinalHook) continue;
        } else {
          const hasAllRequired = polarityTokens.every((token) => tokenSet.has(token));
          if (!hasAllRequired) continue;
        }
      }
      if (strictness === "strict" && strictAxisRequirement?.enabled) {
        if (IK_INTENT_V2_ENABLED && phase !== "primary") {
          // Keep strict axis checks only on precision lane in intent-first mode.
        } else {
        const tokenSet = new Set(tokens);
        const hasActor =
          strictAxisRequirement.actorTokens.size === 0
            ? true
            : Array.from(strictAxisRequirement.actorTokens).some((token) => tokenSet.has(token));
        const hasProceeding =
          strictAxisRequirement.proceedingTokens.size === 0
            ? true
            : Array.from(strictAxisRequirement.proceedingTokens).some((token) => tokenSet.has(token));
        const hasOutcome =
          strictAxisRequirement.outcomeTokens.size === 0
            ? true
            : Array.from(strictAxisRequirement.outcomeTokens).some((token) => tokenSet.has(token));
        const hasRole =
          strictAxisRequirement.roleTokens.size === 0
            ? true
            : Array.from(strictAxisRequirement.roleTokens).some((token) => tokenSet.has(token));
        const hasChain =
          strictAxisRequirement.chainTokens.size === 0
            ? true
            : Array.from(strictAxisRequirement.chainTokens).some((token) => tokenSet.has(token));
        if (!hasActor || !hasProceeding || !hasOutcome || !hasRole || !hasChain) continue;
        }
      }

      const phrase = tokens.join(" ");
      if (phrase.length < 6 || tokens.length < 3) continue;
      if (strictness === "strict" && tokens.length < 4) continue;
      const signature = `${phase}|${phrase}`;
      if (seen.has(signature)) continue;
      seen.add(signature);

      const explicitScope = inferExplicitCourtScope(candidate);
      output.push(
        buildVariant(
          phase,
          purpose,
          phrase,
          idx,
          explicitScope === "ANY" ? courtScope : explicitScope,
          strictness,
          {
            canonicalKey: `${purpose}:${phase}:${phrase}`,
          },
        ),
      );
      idx += 1;
    }
  }
}

function buildVariantsFromKeywordPack(input: {
  intent: IntentProfile;
  keywordPack: KeywordPack;
  plannerSource: PlannerOutput["plannerSource"];
  plannerModelId?: string;
  plannerError?: string;
  reasonerPlan?: ReasonerPlan;
}): PlannerOutput {
  const { intent, keywordPack, plannerSource, plannerModelId, plannerError, reasonerPlan } = input;
  const reasonerOutcomeTerms = filterReasonerOutcomeTermsByContext(
    intent.cleanedQuery,
    reasonerPlan?.proposition.outcome_required ?? [],
  );
  const propositionStrategy = buildPropositionStrategy({ intent, reasonerPlan, keywordPack });
  const legalSignalTokens = buildLegalSignalTokenSet(intent, reasonerPlan);
  const requiredHookGroups = buildRequiredHookGroups(intent, reasonerPlan);
  const doctrinalHookTokens = doctrinalHookTokenSet(requiredHookGroups);
  const polarityTokens = requiredPolarityTokens(intent, reasonerPlan);
  const expectedPolarity = inferExpectedPolarity(
    intent.cleanedQuery,
    reasonerOutcomeTerms.length > 0 ? reasonerOutcomeTerms : intent.issues,
    reasonerPlan,
  );
  const outcomePhrases = unique([
    ...expandOutcomeSynonyms(
      filterPolarityCues(
        inferOutcomePolarityCue(
          intent.cleanedQuery,
          reasonerOutcomeTerms.length > 0 ? reasonerOutcomeTerms : intent.issues,
        ),
        expectedPolarity,
      ),
    ),
    ...reasonerOutcomeTerms,
    ...intent.issues,
  ])
    .map((value) => sanitizeTokens(tokenizePhrase(value), 8))
    .filter((value) => value.length >= 6)
    .slice(0, 8);
  const strictAxisRequirement = propositionStrategy.strictAxisRequirement;
  const recallSynonyms = expandOntologySynonymsForRecall({
    terms: [
      ...intent.issues,
      ...intent.procedures,
      ...intent.statutes,
      ...intent.entities.statute,
      ...intent.entities.section,
    ],
    context: intent.context,
    maxExpansions: 26,
  });
  const variants: QueryVariant[] = [];
  const seen = new Set<string>();
  const courtScope = resolveCourtScope(intent.courtHint, reasonerPlan?.proposition.jurisdiction_hint);

  appendPhaseVariants({
    output: variants,
    seen,
    phase: "primary",
    purpose: "proposition-strict",
    phrases: propositionStrategy.strict,
    courtScope,
    strictness: "strict",
    courted: true,
    legalSignalTokens,
    requiredHookGroups,
    enforceAllGroups: true,
    polarityTokens,
    doctrinalHookTokens,
    strictAxisRequirement,
  });

  appendPhaseVariants({
    output: variants,
    seen,
    phase: "fallback",
    purpose: "proposition-broad",
    phrases: propositionStrategy.broad,
    courtScope,
    strictness: "strict",
    courted: true,
    legalSignalTokens,
    requiredHookGroups,
    enforceAllGroups: true,
    polarityTokens,
    doctrinalHookTokens,
    strictAxisRequirement,
  });

  if (!variants.some((variant) => variant.strictness === "strict")) {
    const actorPool = (reasonerPlan?.proposition.actors?.length ? reasonerPlan.proposition.actors : intent.actors).slice(0, 3);
    const procedurePool = (
      reasonerPlan?.proposition.proceeding?.length ? reasonerPlan.proposition.proceeding : intent.procedures
    ).slice(0, 3);
    const outcomePool = (
      reasonerPlan?.proposition.outcome_required?.length ? reasonerPlan.proposition.outcome_required : outcomePhrases
    ).slice(0, 3);
    const fallbackStrict: string[] = [];
    for (const actor of actorPool.length > 0 ? actorPool : ["state"]) {
      for (const procedure of procedurePool.length > 0 ? procedurePool : ["appeal"]) {
        for (const outcome of outcomePool.length > 0 ? outcomePool : ["delay not condoned"]) {
          const phrase = sanitizeTokens(tokenizePhrase(`${actor} ${procedure} ${outcome}`), 12);
          if (phrase.length >= 10) fallbackStrict.push(phrase);
        }
      }
    }
    appendPhaseVariants({
      output: variants,
      seen,
      phase: "primary",
      purpose: "strict-backstop",
      phrases: unique(fallbackStrict),
      courtScope,
      strictness: "strict",
      courted: true,
      legalSignalTokens,
      requiredHookGroups,
      enforceAllGroups: true,
      polarityTokens: [],
      doctrinalHookTokens,
      strictAxisRequirement,
    });
  }

  appendPhaseVariants({
    output: variants,
    seen,
    phase: "rescue",
    purpose: "keyword-rescue",
    phrases: [
      ...propositionStrategy.strict,
      ...outcomePhrases,
      ...keywordPack.searchPhrases,
      ...recallSynonyms,
      ...intent.entities.case_citation,
    ],
    courtScope,
    strictness: "relaxed",
    courted: false,
    legalSignalTokens,
  });

  appendPhaseVariants({
    output: variants,
    seen,
    phase: "micro",
    purpose: "micro-signals",
    phrases: [
      ...outcomePhrases,
      ...keywordPack.legalSignals,
      ...intent.statutes,
      ...intent.procedures,
      ...intent.issues,
      ...intent.entities.section,
      ...intent.entities.statute,
      ...recallSynonyms,
    ],
    courtScope,
    strictness: "relaxed",
    courted: false,
    legalSignalTokens,
  });

  appendPhaseVariants({
    output: variants,
    seen,
    phase: "revolving",
    purpose: "revolving-broad",
    phrases: [
      ...outcomePhrases,
      ...keywordPack.primary,
      ...keywordPack.searchPhrases,
      ...intent.issues,
      ...intent.entities.section,
      ...recallSynonyms,
    ],
    courtScope,
    strictness: "relaxed",
    courted: false,
    legalSignalTokens,
  });

  return {
    keywordPack,
    plannerSource,
    plannerModelId,
    plannerError,
    strictGroupCount: propositionStrategy.strictGroupCount,
    strictVariantsPreservedAllGroups: propositionStrategy.strictVariantsPreservedAllGroups,
    variants,
  };
}

export function buildReasonerQueryVariants(input: {
  intent: IntentProfile;
  plan: ReasonerPlan;
}): QueryVariant[] {
  const { intent, plan } = input;
  const reasonerOutcomeTerms = filterReasonerOutcomeTermsByContext(
    intent.cleanedQuery,
    plan.proposition.outcome_required,
  );
  const effectiveOutcomeTerms = reasonerOutcomeTerms.length > 0 ? reasonerOutcomeTerms : intent.issues;
  const legalSignalTokens = buildLegalSignalTokenSet(intent, plan);
  const requiredHookGroups = buildRequiredHookGroups(intent, plan);
  const doctrinalHookTokens = doctrinalHookTokenSet(requiredHookGroups);
  const polarityTokens = requiredPolarityTokens(intent, plan);
  const expectedPolarity = inferExpectedPolarity(
    intent.cleanedQuery,
    effectiveOutcomeTerms,
    plan,
  );
  const filteredPlanCues = expandOutcomeSynonyms(
    filterPolarityCues(
      inferOutcomePolarityCue(intent.cleanedQuery, effectiveOutcomeTerms),
      expectedPolarity,
    ),
  );
  const strictAxisRequirement: StrictAxisRequirement = {
    enabled: requiredHookGroups.length === 0,
    actorTokens: new Set((plan.proposition.actors.length > 0 ? plan.proposition.actors : intent.actors).flatMap((value) =>
      tokenizePhrase(value),
    )),
    proceedingTokens: new Set(
      (plan.proposition.proceeding.length > 0 ? plan.proposition.proceeding : intent.procedures).flatMap((value) =>
        tokenizePhrase(value),
      ),
    ),
    outcomeTokens: new Set(
      (filteredPlanCues.length > 0
        ? filteredPlanCues
        : reasonerOutcomeTerms.length > 0
          ? reasonerOutcomeTerms
          : intent.issues
      ).flatMap((value) => tokenizePhrase(value)),
    ),
    roleTokens: new Set(inferRoleCueTokens(intent.cleanedQuery).flatMap((value) => tokenizePhrase(value))),
    chainTokens: new Set(
      tokenizePhrase(
        [
          hasDelayCondonationContext(
            intent.cleanedQuery,
            effectiveOutcomeTerms,
          )
            ? "condonation delay"
            : "",
          hasDelayCondonationContext(
            intent.cleanedQuery,
            effectiveOutcomeTerms,
          ) && /\bnot condoned|refused|dismissed|time barred\b/i.test(intent.cleanedQuery)
            ? "not condoned dismissed"
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      ),
    ),
  };
  const courtScope = resolveCourtScope(intent.courtHint, plan.proposition.jurisdiction_hint);
  const variants: QueryVariant[] = [];
  const seen = new Set<string>();

  appendPhaseVariants({
    output: variants,
    seen,
    phase: "primary",
    purpose: "reasoner-strict",
    phrases: plan.query_variants_strict,
    courtScope,
    strictness: "strict",
    courted: true,
    legalSignalTokens,
    requiredHookGroups,
    enforceAllGroups: true,
    polarityTokens,
    doctrinalHookTokens,
    strictAxisRequirement,
  });
  appendPhaseVariants({
    output: variants,
    seen,
    phase: "fallback",
    purpose: "reasoner-broad",
    phrases: plan.query_variants_broad,
    courtScope,
    strictness: "strict",
    courted: true,
    legalSignalTokens,
    requiredHookGroups,
    enforceAllGroups: true,
    polarityTokens,
    doctrinalHookTokens,
    strictAxisRequirement,
  });
  appendPhaseVariants({
    output: variants,
    seen,
    phase: "browse",
    purpose: "reasoner-anchor-trace",
    phrases: plan.case_anchors,
    courtScope,
    strictness: "relaxed",
    courted: false,
    legalSignalTokens,
  });
  return variants;
}

export async function planDeterministicQueryVariants(
  intent: IntentProfile,
  reasonerPlan?: ReasonerPlan,
): Promise<PlannerOutput> {
  const deterministicKeywordPack = buildKeywordPack(intent.cleanedQuery, intent.context);
  return buildVariantsFromKeywordPack({
    intent,
    keywordPack: deterministicKeywordPack,
    plannerSource: "fallback",
    reasonerPlan,
  });
}

export async function planAIFailoverQueryVariants(
  intent: IntentProfile,
  deterministicKeywordPack?: KeywordPack,
  reasonerPlan?: ReasonerPlan,
): Promise<PlannerOutput> {
  const fallbackPack = deterministicKeywordPack ?? buildKeywordPack(intent.cleanedQuery, intent.context);
  const keywordPlanner = await buildKeywordPackWithAI(intent.cleanedQuery, intent.context, fallbackPack);
  return buildVariantsFromKeywordPack({
    intent,
    keywordPack: keywordPlanner.keywordPack,
    plannerSource: keywordPlanner.source,
    plannerModelId: keywordPlanner.modelId,
    plannerError: keywordPlanner.error,
    reasonerPlan,
  });
}

export function buildGuaranteeBackfillVariants(input: {
  intent: IntentProfile;
  phrases: string[];
  reasonerPlan?: ReasonerPlan;
  maxVariants?: number;
}): QueryVariant[] {
  const { intent, phrases, reasonerPlan } = input;
  const maxVariants = Math.max(1, Math.min(input.maxVariants ?? 6, 12));
  const legalSignalTokens = buildLegalSignalTokenSet(intent, reasonerPlan);
  const variants: QueryVariant[] = [];
  const seen = new Set<string>();
  const courtScope = resolveCourtScope(intent.courtHint, reasonerPlan?.proposition.jurisdiction_hint);

  appendPhaseVariants({
    output: variants,
    seen,
    phase: "browse",
    purpose: "guarantee-backfill",
    phrases: unique(phrases).slice(0, maxVariants * 2),
    courtScope,
    strictness: "relaxed",
    courted: false,
    legalSignalTokens,
  });

  return variants.slice(0, maxVariants);
}

function titleTraceSeed(title: string): string {
  const cleaned = normalizePhrase(title).replace(/\bon\s+\d{1,2}\s+[a-z]+\s+\d{4}\b/g, " ");
  const tokens = tokenizePhrase(cleaned).filter((token) => token.length > 2).slice(0, 6);
  return unique(tokens).join(" ");
}

export function buildTraceQueryVariants(input: {
  intent: IntentProfile;
  seedCases: Array<Pick<CaseCandidate | ScoredCase, "title" | "snippet" | "court">>;
  maxVariants?: number;
}): QueryVariant[] {
  const { intent, seedCases } = input;
  const maxVariants = Math.max(2, input.maxVariants ?? 8);
  const seeds = unique(seedCases.map((item) => titleTraceSeed(item.title)).filter((seed) => seed.length >= 6)).slice(
    0,
    6,
  );
  if (seeds.length === 0) return [];

  const pivots = unique([...intent.issues, ...intent.procedures, ...intent.statutes, ...intent.anchors]).slice(0, 8);
  if (pivots.length === 0) return [];

  const legalSignalTokens = buildLegalSignalTokenSet(intent);
  const output: QueryVariant[] = [];
  const seen = new Set<string>();
  let idx = 0;
  const courtScope = intent.courtHint;

  for (const seed of seeds) {
    for (const pivot of pivots) {
      const phrase = sanitizeTokens(tokenizePhrase(`${seed} ${pivot}`), 12);
      if (!phrase || seen.has(phrase)) continue;
      seen.add(phrase);
      if (!hasMinimumLegalSignal(tokenizePhrase(phrase), legalSignalTokens)) continue;
      output.push(
        buildVariant("browse", "precedent-trace", phrase, idx, courtScope, "relaxed", {
          canonicalKey: `precedent-trace:${phrase}`,
          priority: 44,
        }),
      );
      idx += 1;
      if (output.length >= maxVariants) return output;
    }
  }
  return output;
}

export function mergeCanonicalRewriteVariants(input: {
  plannerVariants: QueryVariant[];
  rewriteVariants: QueryVariant[];
}): QueryVariant[] {
  const merged = new Map<string, QueryVariant>();

  const upsert = (candidate: QueryVariant) => {
    const key = `${candidate.phase}|${candidate.phrase.toLowerCase()}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      return;
    }
    const existingPriority = existing.priority ?? 0;
    const candidatePriority = candidate.priority ?? 0;
    if (candidatePriority > existingPriority) {
      merged.set(key, {
        ...candidate,
        retrievalDirectives: candidate.retrievalDirectives ?? existing.retrievalDirectives,
        mustIncludeTokens:
          candidate.mustIncludeTokens && existing.mustIncludeTokens
            ? unique([...candidate.mustIncludeTokens, ...existing.mustIncludeTokens]).slice(0, 24)
            : candidate.mustIncludeTokens ?? existing.mustIncludeTokens,
        mustExcludeTokens:
          candidate.mustExcludeTokens && existing.mustExcludeTokens
            ? unique([...candidate.mustExcludeTokens, ...existing.mustExcludeTokens]).slice(0, 16)
            : candidate.mustExcludeTokens ?? existing.mustExcludeTokens,
      });
      return;
    }
    merged.set(key, {
      ...existing,
      retrievalDirectives: existing.retrievalDirectives ?? candidate.retrievalDirectives,
      mustIncludeTokens:
        candidate.mustIncludeTokens && existing.mustIncludeTokens
          ? unique([...existing.mustIncludeTokens, ...candidate.mustIncludeTokens]).slice(0, 24)
          : existing.mustIncludeTokens ?? candidate.mustIncludeTokens,
      mustExcludeTokens:
        candidate.mustExcludeTokens && existing.mustExcludeTokens
          ? unique([...existing.mustExcludeTokens, ...candidate.mustExcludeTokens]).slice(0, 16)
          : existing.mustExcludeTokens ?? candidate.mustExcludeTokens,
    });
  };

  for (const variant of input.rewriteVariants) upsert(variant);
  for (const variant of input.plannerVariants) upsert(variant);
  return Array.from(merged.values());
}

export async function planQueryVariants(
  intent: IntentProfile,
  options?: { mode?: "deterministic" | "ai"; reasonerPlan?: ReasonerPlan },
): Promise<PlannerOutput> {
  const mode = options?.mode ?? "ai";
  if (mode === "deterministic") {
    return planDeterministicQueryVariants(intent, options?.reasonerPlan);
  }
  return planAIFailoverQueryVariants(intent, undefined, options?.reasonerPlan);
}
