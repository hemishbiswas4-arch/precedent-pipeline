import {
  IntentProfile,
  PlannerOutput,
  QueryProviderHints,
  QueryRetrievalDirectives,
  RetrievalDoctypeProfile,
  QueryVariant,
} from "@/lib/pipeline/types";
import { ReasonerOutcomePolarity, ReasonerPlan } from "@/lib/reasoner-schema";
import { expandOntologySynonymsForRecall } from "@/lib/kb/legal-ontology";
import {
  expandMinimalTransitionAliases,
  isLikelyLegalDisjunction,
  parseLegalReferences,
} from "@/lib/kb/legal-reference-parser";

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
  citationHints: string[];
  judgeHints: string[];
  hookGroups: CanonicalHookGroup[];
  outcomePolarity: ReasonerOutcomePolarity;
  contradictionTerms: string[];
  doctypeProfile: RetrievalDoctypeProfile;
  courtScope: QueryVariant["courtScope"];
  dateWindow: {
    fromDate?: string;
    toDate?: string;
  };
  mustIncludeTokens: string[];
  mustExcludeTokens: string[];
  canonicalOrderTerms: string[];
  disjunctiveQuery: boolean;
  softHintTerms: string[];
  notificationTerms: string[];
  transitionAliases: string[];
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

const IK_INTENT_V2 = parseBoolean(process.env.IK_INTENT_V2, true);

function resolveDoctypeProfile(input: {
  courtScope: QueryVariant["courtScope"];
  doctypeProfile: RetrievalDoctypeProfile;
}): RetrievalDoctypeProfile {
  if (input.courtScope === "SC") return "supremecourt";
  if (input.courtScope === "HC") return "highcourts";
  if (input.doctypeProfile && input.doctypeProfile !== "any") return input.doctypeProfile;
  return "judgments_sc_hc_tribunal";
}

function hasConfidentPolarity(polarity: ReasonerOutcomePolarity): boolean {
  return polarity !== "unknown";
}

function resolveCategoryExpansions(canonicalIntent: CanonicalIntent): string[] {
  const fromHints = canonicalIntent.hookGroups
    .flatMap((group) => group.terms)
    .concat(canonicalIntent.citationHints)
    .concat(canonicalIntent.legalHooks)
    .concat(canonicalIntent.outcomes);
  const base = unique(fromHints);
  if (base.length > 0) {
    return categoryExpansionsForIntent({
      ...canonicalIntent,
      legalHooks: unique([...canonicalIntent.legalHooks, ...base]),
    });
  }
  return categoryExpansionsForIntent(canonicalIntent);
}

function resolveTitleTerms(canonicalIntent: CanonicalIntent): string[] {
  return unique([
    ...canonicalIntent.actors,
    ...canonicalIntent.proceedings,
    ...canonicalIntent.outcomes,
  ]).slice(0, 8);
}

function resolveCitationTerms(canonicalIntent: CanonicalIntent): string[] {
  const hookCitations = canonicalIntent.legalHooks.filter((value) =>
    /\bair\b|\bscc\b|\bscr\b|\b\d{4}\b|\bsection\b|\bact\b/i.test(value),
  );
  return unique([...canonicalIntent.citationHints, ...hookCitations]).slice(0, 8);
}

function resolveJudgeTerms(canonicalIntent: CanonicalIntent): string[] {
  return unique(canonicalIntent.judgeHints).slice(0, 6);
}

function resolveAuthorTerms(canonicalIntent: CanonicalIntent): string[] {
  return resolveJudgeTerms(canonicalIntent);
}

function resolveBenchTerms(canonicalIntent: CanonicalIntent): string[] {
  return resolveJudgeTerms(canonicalIntent);
}

function resolveContradictionExclusionPolicy(input: {
  queryMode: QueryRetrievalDirectives["queryMode"];
  canonicalIntent: CanonicalIntent;
}): boolean {
  if (input.queryMode === "expansion") return false;
  if (input.queryMode === "context") return false;
  if (!hasConfidentPolarity(input.canonicalIntent.outcomePolarity)) return false;
  const polarity = input.canonicalIntent.outcomePolarity;
  if (polarity === "required" || polarity === "not_required") return true;

  const bag = normalizeText(
    [
      ...input.canonicalIntent.outcomes,
      ...input.canonicalIntent.proceedings,
      ...input.canonicalIntent.legalHooks,
    ].join(" "),
  );
  const delayCondonationContext = /\b(?:condonation|delay|limitation|time[-\s]*barred|barred\s+by\s+limitation)\b/.test(
    bag,
  );
  if (polarity === "dismissed") return delayCondonationContext;
  if (polarity === "refused") return delayCondonationContext;
  if (polarity === "quashed") return true;
  return false;
}

function categoryExpansionsForIntent(canonicalIntent: CanonicalIntent): string[] {
  const bag = unique([
    ...canonicalIntent.legalHooks,
    ...canonicalIntent.outcomes,
    ...canonicalIntent.proceedings,
  ]);
  const categories: string[] = [];
  for (const term of bag) {
    if (/sanction|section 197|pc act|prevention of corruption/.test(term)) categories.push("corruption");
    if (/appeal|limitation|time barred|delay/.test(term)) categories.push("appellate");
    if (/quash|section 482/.test(term)) categories.push("quashing");
    if (/tribunal/.test(term)) categories.push("tribunal");
  }
  return unique(categories).slice(0, 5);
}

function heuristicLegalPhrases(canonicalIntent: CanonicalIntent): string[] {
  const bag = normalizeText(
    [
      ...canonicalIntent.legalHooks,
      ...canonicalIntent.proceedings,
      ...canonicalIntent.outcomes,
      ...canonicalIntent.hookGroups.flatMap((group) => group.terms),
    ].join(" "),
  );
  const phrases: string[] = [];

  if (/\bsection\s*482\b|\b482\s*crpc\b/.test(bag)) {
    phrases.push(
      "section 482 crpc quash fir abuse of process",
      "inherent powers under section 482 crpc",
      "quashing criminal proceedings civil dispute",
    );
  }

  if (/\blimitation act\b/.test(bag) && /\bsection\s*5\b/.test(bag)) {
    phrases.push(
      "section 5 limitation act condonation of delay",
      "appeal against acquittal delay condonation section 5",
      "state appeal condonation of delay limitation act",
    );
  }

  if (/\bsection\s*304\b|\b304\s*ipc\b/.test(bag)) {
    phrases.push(
      "framing of charge section 304 ipc road accident",
      "section 304 part ii versus 304a road accident",
      "discharge under section 304 ipc rash and negligent driving",
    );
  }

  return unique(phrases).slice(0, 12);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:doctypes|sortby|fromdate|todate):\S+/g, " ")
    .replace(/[^a-z0-9\s()/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMeaningfulToken(token: string): boolean {
  if (!token) return false;
  if (/^\d+$/.test(token)) return true;
  return token.length > 1;
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => isMeaningfulToken(token));
}

const CONTRADICTION_SINGLE_TOKEN_ALLOWLIST = new Set([
  "allowed",
  "granted",
  "condoned",
  "restored",
  "dismissed",
  "refused",
  "rejected",
  "declined",
  "denied",
  "quashed",
  "required",
  "mandatory",
  "necessary",
]);

const CONTRADICTION_SINGLE_TOKEN_BLOCKLIST = new Set([
  "delay",
  "appeal",
  "petition",
  "application",
  "revision",
  "challenge",
  "prosecution",
  "order",
  "case",
  "matter",
  "court",
  "state",
  "proceeding",
  "proceedings",
  "without",
  "not",
  "no",
  "prior",
  "previous",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildContradictionExclusionTerms(contradictionTerms: string[]): string[] {
  const output: string[] = [];
  for (const term of contradictionTerms) {
    const normalized = normalizeText(term);
    if (!normalized) continue;
    const tokens = tokenize(normalized);
    if (tokens.length <= 1) {
      const token = tokens[0] ?? normalized;
      if (
        CONTRADICTION_SINGLE_TOKEN_BLOCKLIST.has(token) &&
        !CONTRADICTION_SINGLE_TOKEN_ALLOWLIST.has(token)
      ) {
        continue;
      }
      output.push(token);
      continue;
    }

    // Keep phrase exclusions precise; only add single-token exclusions for strong outcome polarity terms.
    output.push(normalized);
    for (const token of tokens) {
      const negatedToken = new RegExp(`\\b(?:not|without|no)\\s+${escapeRegExp(token)}\\b`).test(normalized);
      if (CONTRADICTION_SINGLE_TOKEN_ALLOWLIST.has(token) && !negatedToken) {
        output.push(token);
      }
    }
  }
  return unique(output).slice(0, 14);
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

function isStatutoryHookTerm(term: string): boolean {
  const normalized = normalizeText(term);
  if (!normalized) return false;
  return (
    /\bsection\s*\d+[a-z]?(?:\([0-9a-z]+\))*(?:\([a-z]\))?/i.test(normalized) ||
    /\barticle\s*\d+[a-z]?\b/i.test(normalized) ||
    /\b(?:ipc|crpc|bnss|cpc|pc act|limitation act|prevention of corruption act)\b/i.test(normalized) ||
    /\b[a-z][a-z\s]{2,}\s+act\b/i.test(normalized)
  );
}

function isWeakHookTerm(term: string): boolean {
  const normalized = normalizeText(term);
  if (!normalized) return true;
  if (normalized.length <= 1) return true;
  if (/^\d{1,4}$/.test(normalized)) return true;
  if (/^(?:[ivxlcdm]+)$/.test(normalized)) return true;
  return false;
}

function hasDisjunctiveSignals(cleanedQuery: string): boolean {
  const refs = parseLegalReferences(cleanedQuery);
  return isLikelyLegalDisjunction(cleanedQuery, refs);
}

function detectHookFamily(term: string): string | null {
  const normalized = normalizeText(term);
  if (/prevention of corruption|pc act/.test(normalized)) return "pc_act";
  if (/\bcrpc\b|criminal procedure|\bbnss\b|bharatiya nagarik suraksha sanhita/.test(normalized)) return "crpc";
  if (/\bipc\b|indian penal code/.test(normalized)) return "ipc";
  if (/\bcpc\b|civil procedure/.test(normalized)) return "cpc";
  if (/limitation act/.test(normalized)) return "limitation_act";
  return null;
}

function hasSectionToken(term: string): boolean {
  return /\bsection\s*\d+[a-z]?(?:\([0-9a-z]+\))*(?:\([a-z]\))?/i.test(normalizeText(term));
}

function parseSectionToken(term: string): string | null {
  return normalizeText(term).match(/\bsection\s*([0-9]+(?:\([0-9a-z]+\))*(?:\([a-z]\))?)/i)?.[1] ?? null;
}

function hasOpenEndedQuestionSignals(text: string): boolean {
  return /\b(?:whether|when|can|could|would|if)\b/.test(text);
}

function hasOutcomeVerbSignals(text: string): boolean {
  return /\b(?:condon(?:e|ed|ation)|quash(?:ed|ing)?|dismiss(?:ed)?|allow(?:ed)?|grant(?:ed)?|refus(?:e|ed)|reject(?:ed)?|discharge|framing\s+of\s+charge)\b/.test(
    text,
  );
}

function hasExplicitDispositionSignals(text: string): boolean {
  return /\b(?:dismissed|refused|rejected|denied|declined|quashed|allowed|granted|restored|not condoned|time barred|barred by limitation)\b/.test(
    text,
  );
}

function rebalanceHookGroupsForDisjunction(input: {
  groups: CanonicalHookGroup[];
  disjunctiveQuery: boolean;
}): CanonicalHookGroup[] {
  const usableRaw = input.groups
    .map((group) => {
      const terms = unique(group.terms).filter((term) => !isWeakHookTerm(term)).slice(0, 8);
      if (terms.length === 0) return null;
      const statutory = terms.some((term) => isStatutoryHookTerm(term));
      return {
        ...group,
        terms,
        representative: terms[0],
        required: input.disjunctiveQuery ? statutory : group.required,
      };
    })
    .filter((group): group is CanonicalHookGroup => Boolean(group));

  const deduped = new Map<string, CanonicalHookGroup>();
  for (const group of usableRaw) {
    const representative = normalizeText(group.representative || group.terms[0] || group.groupId);
    const key = representative || normalizeText(group.groupId);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, {
        ...group,
        terms: unique(group.terms).slice(0, 8),
      });
      continue;
    }
    existing.terms = unique([...existing.terms, ...group.terms]).slice(0, 8);
    existing.required = existing.required || group.required;
    existing.minMatch = Math.max(existing.minMatch, Math.min(group.minMatch, existing.terms.length));
  }
  const usable = Array.from(deduped.values());
  const semanticDeduped = new Map<string, CanonicalHookGroup>();
  for (const group of usable) {
    const section =
      group.terms
        .map((term) => parseSectionToken(term))
        .find((value): value is string => Boolean(value))
        ?.replace(/\s+/g, "")
        .toLowerCase() ?? null;
    const familyFromTerms = group.terms
      .map((term) => detectHookFamily(term))
      .find((value): value is string => Boolean(value));
    const familyFromId =
      group.groupId.match(/^hook_(pc_act|crpc|ipc|cpc|limitation_act)/)?.[1] ??
      group.groupId.match(/^(pc_act|crpc|ipc|cpc|limitation_act)$/)?.[1] ??
      null;
    const family = familyFromTerms ?? familyFromId;
    const key = family && section
      ? `family:${family}:section:${section}`
      : family
        ? `family:${family}`
        : section
          ? `section:${section}`
          : `${group.groupId}:${semanticDeduped.size}`;
    const existing = semanticDeduped.get(key);
    if (!existing) {
      semanticDeduped.set(key, {
        ...group,
        terms: unique(group.terms).slice(0, 8),
      });
      continue;
    }
    existing.terms = unique([...existing.terms, ...group.terms]).slice(0, 8);
    existing.required = existing.required || group.required;
    existing.minMatch = Math.max(existing.minMatch, Math.min(group.minMatch, existing.terms.length));
  }
  const semanticGroups = Array.from(semanticDeduped.values());

  if (semanticGroups.length === 0) return [];

  const requiredCount = semanticGroups.filter((group) => group.required).length;
  if (requiredCount === 0) {
    const primary =
      semanticGroups.find((group) => group.terms.some((term) => isStatutoryHookTerm(term))) ?? semanticGroups[0];
    primary.required = true;
  }

  if (input.disjunctiveQuery) {
    const required = semanticGroups.filter((group) => group.required);
    if (required.length > 2) {
      for (const group of required.slice(2)) {
        group.required = false;
      }
    }
  }

  const sorted = semanticGroups
    .sort((left, right) => {
      const leftStatutory = left.terms.some((term) => isStatutoryHookTerm(term)) ? 1 : 0;
      const rightStatutory = right.terms.some((term) => isStatutoryHookTerm(term)) ? 1 : 0;
      if (left.required !== right.required) return left.required ? -1 : 1;
      if (leftStatutory !== rightStatutory) return rightStatutory - leftStatutory;
      return right.terms.length - left.terms.length;
    });

  const familiesWithSection = new Set<string>();
  for (const group of sorted) {
    const sectionBound = group.terms.some((term) => hasSectionToken(term));
    if (!sectionBound) continue;
    for (const term of group.terms) {
      const family = detectHookFamily(term);
      if (family) familiesWithSection.add(family);
    }
  }

  return sorted
    .filter((group) => {
      const hasSection = group.terms.some((term) => hasSectionToken(term));
      if (hasSection) return true;
      const families = new Set(group.terms.map((term) => detectHookFamily(term)).filter((v): v is string => Boolean(v)));
      if (families.size === 0) return true;
      return !Array.from(families).some((family) => familiesWithSection.has(family));
    })
    .slice(0, 8);
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  }
  return hash;
}

function inferOutcomePolarity(intent: IntentProfile, reasonerPlan?: ReasonerPlan): ReasonerOutcomePolarity {
  const q = normalizeText(`${intent.cleanedQuery} ${intent.issues.join(" ")}`);
  const openEndedQuestion = hasOpenEndedQuestionSignals(q) && hasOutcomeVerbSignals(q);
  const explicitDisposition = hasExplicitDispositionSignals(q);

  const planned = reasonerPlan?.proposition.outcome_constraint.polarity;
  if (planned && planned !== "unknown") {
    if (openEndedQuestion && !explicitDisposition && planned !== "required" && planned !== "not_required") {
      return "unknown";
    }
    return planned;
  }

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
  if (sanctionNotRequired) return "not_required";
  if (/\b(?:sanction\s+required|prior\s+sanction|previous\s+sanction|mandatory\s+sanction)\b/.test(q)) {
    return "required";
  }
  if (!openEndedQuestion || explicitDisposition) {
    if (/\bdismissed|time barred|barred by limitation\b/.test(q)) return "dismissed";
    if (/\brefused|rejected|denied|declined|not condoned\b/.test(q)) return "refused";
    if (/\bquashed\b/.test(q)) return "quashed";
    if (/\ballowed|granted|condoned\b/.test(q)) return "allowed";
  }
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

function hasDelayCondonationContextFromIntent(intent: IntentProfile): boolean {
  const bag = normalizeText(
    [
      intent.cleanedQuery,
      ...intent.issues,
      ...intent.procedures,
      ...intent.statutes,
      ...intent.entities.section,
      ...intent.entities.statute,
    ].join(" "),
  );
  return /\b(?:condonation|delay|limitation|time[-\s]*barred|barred\s+by\s+limitation|not\s+condoned|section\s*5)\b/.test(
    bag,
  );
}

function filterReasonerOutcomeTerms(intent: IntentProfile, terms: string[]): string[] {
  const delayCondonationContext = hasDelayCondonationContextFromIntent(intent);
  return terms.filter((term) => {
    const normalized = normalizeText(term);
    if (!normalized) return false;
    if (
      !delayCondonationContext &&
      /\b(?:condonation|delay|time[-\s]*barred|barred\s+by\s+limitation|not\s+condoned)\b/.test(normalized)
    ) {
      return false;
    }
    return true;
  });
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

  return rebalanceHookGroupsForDisjunction({
    groups: output,
    disjunctiveQuery: hasDisjunctiveSignals(intent.cleanedQuery),
  });
}

function buildMustIncludeTokens(input: {
  hardIncludeTerms: string[];
}): string[] {
  return unique(input.hardIncludeTerms).slice(0, 20);
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
    retrievalDirectives: QueryRetrievalDirectives;
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
    retrievalDirectives: input.retrievalDirectives,
  };
}

export function buildCanonicalIntent(intent: IntentProfile, reasonerPlan?: ReasonerPlan): CanonicalIntent {
  const legalRefs = parseLegalReferences(intent.cleanedQuery);
  const filteredReasonerOutcomes = filterReasonerOutcomeTerms(intent, reasonerPlan?.proposition.outcome_required ?? []);
  const filteredReasonerContradictions = filterReasonerOutcomeTerms(
    intent,
    [
      ...(reasonerPlan?.proposition.outcome_constraint.contradiction_terms ?? []),
      ...(reasonerPlan?.must_not_have_terms ?? []),
    ],
  );
  const actors = unique([
    ...(reasonerPlan?.proposition.actors ?? []),
    ...intent.actors,
    ...intent.entities.person,
    ...intent.entities.org,
  ]).slice(0, 8);
  const proceedings = unique([...(reasonerPlan?.proposition.proceeding ?? []), ...intent.procedures]).slice(0, 6);
  const outcomes = unique([...filteredReasonerOutcomes, ...intent.issues]).slice(0, 8);
  const transitionAliases = expandMinimalTransitionAliases([
    ...legalRefs.statutes,
    ...intent.statutes,
    ...intent.entities.statute,
    ...intent.entities.section,
    ...(reasonerPlan?.proposition.legal_hooks ?? []),
  ]);
  const legalHooks = unique([
    ...(reasonerPlan?.proposition.legal_hooks ?? []),
    ...intent.statutes,
    ...intent.entities.statute,
    ...intent.entities.section,
    ...legalRefs.statutes,
    ...legalRefs.sections,
    ...transitionAliases,
  ]).slice(0, 18);
  const citationHints = unique([
    ...intent.retrievalIntent.citationHints,
    ...intent.entities.case_citation,
  ]).slice(0, 10);
  const judgeHints = unique(intent.retrievalIntent.judgeHints).slice(0, 8);
  const hookGroups = extractHookGroups(intent, reasonerPlan);
  const polarity = inferOutcomePolarity(intent, reasonerPlan);
  const contradictionTerms = unique([
    ...filteredReasonerContradictions,
    ...defaultContradictionTerms(polarity),
  ]).slice(0, 14);
  const disjunctiveQuery = hasDisjunctiveSignals(intent.cleanedQuery);
  const mustIncludeTokens = buildMustIncludeTokens({
    hardIncludeTerms: legalRefs.hardIncludeTokens,
  });
  const softHintTerms = unique([
    ...legalRefs.softHintTerms,
    ...transitionAliases,
    ...legalHooks,
  ]).slice(0, 24);
  const notificationTerms = unique([
    ...legalRefs.notificationIds,
    ...legalRefs.notificationDates,
  ]).slice(0, 12);
  const mustExcludeTokens = buildContradictionExclusionTerms(contradictionTerms);
  const canonicalOrderTerms = unique([
    ...actors,
    ...proceedings,
    ...hookGroups.filter((group) => group.required).map((group) => group.representative),
    ...transitionAliases,
    ...outcomes,
  ]).slice(0, 14);

  return {
    actors,
    proceedings,
    outcomes,
    legalHooks,
    citationHints,
    judgeHints,
    hookGroups,
    outcomePolarity: polarity,
    contradictionTerms,
    doctypeProfile: intent.retrievalIntent.doctypeProfile,
    courtScope: reasonerPlan?.proposition.jurisdiction_hint ?? intent.courtHint,
    dateWindow: intent.dateWindow,
    mustIncludeTokens,
    mustExcludeTokens,
    canonicalOrderTerms,
    disjunctiveQuery,
    softHintTerms,
    notificationTerms,
    transitionAliases,
  };
}

export function synthesizeRetrievalQueries(input: {
  canonicalIntent: CanonicalIntent;
  deterministicPlanner: PlannerOutput;
  reasonerVariants: QueryVariant[];
}): QueryVariant[] {
  const { canonicalIntent, deterministicPlanner, reasonerVariants } = input;
  const requiredHookGroups = canonicalIntent.hookGroups.filter((group) => group.required);
  const multiHookRequired = requiredHookGroups.length >= 2 && !canonicalIntent.disjunctiveQuery;
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
  const requiredHookPhrases = canonicalIntent.disjunctiveQuery
    ? requiredHookGroups.map((group) => group.representative).slice(0, 3)
    : [requiredHookGroups.map((group) => group.representative).join(" ").trim()];

  for (const actor of actorPool.slice(0, 3)) {
    for (const proceeding of proceedingPool.slice(0, 3)) {
      for (const outcome of outcomePool.slice(0, 3)) {
        for (const requiredHookPhrase of requiredHookPhrases) {
          const strictPhrase = normalizePhrase(`${actor} ${proceeding} ${requiredHookPhrase} ${outcome}`.trim(), 13);
          if (strictPhrase.length >= 10) {
            strictSeeds.push(strictPhrase);
          }
        }
      }
    }
  }

  for (const proceeding of proceedingPool.slice(0, 3)) {
    for (const outcome of outcomePool.slice(0, 3)) {
      for (const requiredHookPhrase of requiredHookPhrases) {
        broadSeeds.push(normalizePhrase(`${proceeding} ${requiredHookPhrase} ${outcome}`.trim(), 12));
      }
      broadSeeds.push(normalizePhrase(`${proceeding} ${outcome}`.trim(), 10));
    }
  }
  for (const phrase of deterministicPlanner.keywordPack.searchPhrases.slice(0, 10)) {
    broadSeeds.push(phrase);
  }
  for (const phrase of deterministicPlanner.keywordPack.primary.slice(0, 10)) {
    broadSeeds.push(phrase);
  }
  for (const phrase of canonicalIntent.transitionAliases.slice(0, 8)) {
    broadSeeds.push(phrase);
    strictSeeds.push(phrase);
  }
  if (canonicalIntent.transitionAliases.length >= 2) {
    strictSeeds.push(canonicalIntent.transitionAliases.slice(0, 2).join(" "));
  }
  for (const phrase of expandOntologySynonymsForRecall({
    terms: [
      ...canonicalIntent.legalHooks,
      ...canonicalIntent.outcomes,
      ...canonicalIntent.proceedings,
    ],
    context: {
      domains: [],
      issues: canonicalIntent.outcomes,
      statutesOrSections: canonicalIntent.legalHooks,
      procedures: canonicalIntent.proceedings,
      actors: canonicalIntent.actors,
      anchors: canonicalIntent.canonicalOrderTerms,
    },
    maxExpansions: 18,
  })) {
    broadSeeds.push(phrase);
  }
  for (const phrase of heuristicLegalPhrases(canonicalIntent)) {
    broadSeeds.push(phrase);
    strictSeeds.push(phrase);
  }

  let strictPhrases = unique(strictSeeds.map((value) => normalizePhrase(value, 13)).filter((value) => value.length >= 8));
  if (multiHookRequired) {
    strictPhrases = strictPhrases.filter((phrase) => phraseIncludesAllRequiredGroups(phrase, requiredHookGroups));
  }
  if (strictPhrases.length === 0 && actorPool[0] && proceedingPool[0] && outcomePool[0]) {
    const fallbackStrict = normalizePhrase(
      `${actorPool[0]} ${proceedingPool[0]} ${requiredHookPhrases[0] ?? ""} ${outcomePool[0]}`.trim(),
      13,
    );
    if (fallbackStrict) strictPhrases = [fallbackStrict];
  }
  if (strictPhrases.length === 0) {
    const strictBackfill = unique(
      [
        ...deterministicPlanner.keywordPack.searchPhrases.slice(0, 6),
        ...deterministicPlanner.keywordPack.primary.slice(0, 6),
        `${canonicalIntent.proceedings[0] ?? ""} ${canonicalIntent.legalHooks[0] ?? ""}`.trim(),
        canonicalIntent.canonicalOrderTerms.slice(0, 6).join(" "),
      ]
        .map((value) => normalizePhrase(value, 13))
        .filter((value) => value.length >= 6),
    );
    strictPhrases = strictBackfill.slice(0, 6);
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
    softTerms: canonicalIntent.softHintTerms.slice(0, 10),
    notificationTerms: canonicalIntent.notificationTerms.slice(0, 8),
  };
  const includeTokensForMode = (queryMode: QueryRetrievalDirectives["queryMode"]): string[] =>
    queryMode === "precision" ? canonicalIntent.mustIncludeTokens : [];
  const makeDirectives = (queryMode: QueryRetrievalDirectives["queryMode"]): QueryRetrievalDirectives => {
    return {
      queryMode,
      doctypeProfile: resolveDoctypeProfile({
        courtScope: canonicalIntent.courtScope,
        doctypeProfile: canonicalIntent.doctypeProfile,
      }),
      titleTerms: resolveTitleTerms(canonicalIntent),
      citeTerms: resolveCitationTerms(canonicalIntent),
      authorTerms: resolveAuthorTerms(canonicalIntent),
      benchTerms: resolveBenchTerms(canonicalIntent),
      categoryExpansions: resolveCategoryExpansions(canonicalIntent),
      applyContradictionExclusions: resolveContradictionExclusionPolicy({
        queryMode,
        canonicalIntent,
      }),
    };
  };

  const strictLimitsByPhase: Array<{ phase: QueryVariant["phase"]; count: number; priority: number }> = [
    { phase: "primary", count: 2, priority: 110 },
    { phase: "fallback", count: 2, priority: 96 },
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
        mustIncludeTokens: includeTokensForMode("precision"),
        mustExcludeTokens: canonicalIntent.mustExcludeTokens,
        providerHints: providerHintsBase,
        retrievalDirectives: makeDirectives("precision"),
      });
      if (!variant) continue;
      seen.add(key);
      output.push(variant);
      idx += 1;
    }
  }

  const broadPhaseOrder: QueryVariant["phase"][] = ["primary", "fallback", "rescue", "micro", "revolving", "browse"];
  for (let i = 0; i < broadPhrases.length; i += 1) {
    const phrase = broadPhrases[i];
    const phase = broadPhaseOrder[Math.min(Math.floor(i / 4), broadPhaseOrder.length - 1)];
    const queryMode: QueryRetrievalDirectives["queryMode"] =
      IK_INTENT_V2 && i >= 10 ? "expansion" : "context";
    const key = `${phase}|${phrase}`;
    if (seen.has(key)) continue;
    const variant = buildVariant({
      phase,
      strictness: queryMode === "context" && i < 4 ? "strict" : "relaxed",
      purpose: queryMode === "expansion" ? "canonical-rewrite-expansion" : "canonical-rewrite-context",
      phrase,
      idx,
      courtScope: canonicalIntent.courtScope,
      canonicalKeyPrefix: queryMode === "expansion" ? "rewrite:expansion" : "rewrite:context",
      priority: 82 - Math.min(i, 28),
      mustIncludeTokens: includeTokensForMode(queryMode),
      mustExcludeTokens: canonicalIntent.mustExcludeTokens,
      providerHints: providerHintsBase,
      retrievalDirectives: makeDirectives(queryMode),
    });
    if (!variant) continue;
    if (
      multiHookRequired &&
      variant.retrievalDirectives?.queryMode === "precision" &&
      variant.strictness === "strict" &&
      !phraseIncludesAllRequiredGroups(variant.phrase, requiredHookGroups)
    ) {
      continue;
    }
    seen.add(key);
    output.push(variant);
    idx += 1;
  }

  return output.slice(0, 40);
}
