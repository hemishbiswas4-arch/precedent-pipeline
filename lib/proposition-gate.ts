import { ContextProfile, NearMissCase, ScoredCase } from "@/lib/types";
import {
  ReasonerOutcomeConstraint,
  ReasonerOutcomePolarity,
  ReasonerPlan,
  ReasonerRelationType,
} from "@/lib/reasoner-schema";
import { compilePropositionGraph } from "@/lib/proposition-graph";
import { evaluatePropositionGraph, PropositionGraph } from "@/lib/proposition-chain";

export type PropositionElementKey = "actor" | "proceeding" | "legal_hook" | "outcome";

export type PropositionAxis = {
  key: PropositionElementKey;
  label: string;
  required: boolean;
  terms: string[];
};

export type HookGroupConstraint = {
  groupId: string;
  label: string;
  terms: string[];
  minMatch: number;
  required: boolean;
};

export type PropositionRelationConstraint = {
  relationId: string;
  type: ReasonerRelationType;
  leftGroupId: string;
  rightGroupId: string;
  required: boolean;
};

export type OutcomeConstraint = {
  polarity: ReasonerOutcomePolarity;
  required: boolean;
  terms: string[];
  contradictionTerms: string[];
};

export type PropositionSignalInput = {
  text: string;
  // Evidence windows (ratio-ish sentences) used to scope polarity/contradiction checks to case-specific context.
  evidenceText?: string;
};

export type PropositionChecklist = {
  axes: PropositionAxis[];
  requiredElements: string[];
  optionalElements: string[];
  contradictionTerms: string[];
  courtHint: "SC" | "HC" | "ANY";
  hookGroups: HookGroupConstraint[];
  relations: PropositionRelationConstraint[];
  interactionRequired: boolean;
  outcomeConstraint: OutcomeConstraint;
  graph?: PropositionGraph;
};

export type PropositionSignalSummary = {
  requiredCoverage: number;
  coreCoverage: number;
  peripheralCoverage: number;
  requiredComponentCount: number;
  coreComponentCount: number;
  peripheralComponentCount: number;
  hookGroupCoverage: number;
  matchedElements: string[];
  missingElements: string[];
  matchedCoreElements: string[];
  missingCoreElements: string[];
  matchedPeripheralElements: string[];
  missingPeripheralElements: string[];
  matchedHookGroups: string[];
  missingHookGroups: string[];
  relationSatisfied: boolean;
  outcomePolaritySatisfied: boolean;
  polarityMismatch: boolean;
  mandatoryStepCoverage: number;
  chainCoverage: number;
  actorRoleSatisfied: boolean;
  proceedingRoleSatisfied: boolean;
  chainSatisfied: boolean;
  missingMandatorySteps: string[];
  matchedMandatorySteps: string[];
  contradiction: boolean;
  contradictionTerms: string[];
  evidence: string[];
};

export type PropositionGateResult = {
  match: "exact_strict" | "exact_provisional" | "near_miss" | "reject";
  missingElements: string[];
  matchedElements: string[];
  missingCoreElements: string[];
  matchedCoreElements: string[];
  matchEvidence: string[];
  contradiction: boolean;
  requiredCoverage: number;
  coreCoverage: number;
  peripheralCoverage: number;
  hookGroupCoverage: number;
  relationSatisfied: boolean;
  outcomePolaritySatisfied: boolean;
  polarityMismatch: boolean;
  mandatoryStepCoverage: number;
  chainCoverage: number;
  actorRoleSatisfied: boolean;
  proceedingRoleSatisfied: boolean;
  chainSatisfied: boolean;
  missingMandatorySteps: string[];
  matchedMandatorySteps: string[];
};

export type PropositionGateSummary = {
  exactStrict: ScoredCase[];
  exactProvisional: ScoredCase[];
  exact: ScoredCase[];
  nearMiss: NearMissCase[];
  exactMatchCount: number;
  strictExactCount: number;
  provisionalExactCount: number;
  nearMissCount: number;
  missingElementBreakdown: Record<string, number>;
  coreFailureBreakdown: Record<string, number>;
  requiredElementCoverageAvg: number;
  contradictionRejectCount: number;
  hookGroupCoverageAvg: number;
  chainCoverageAvg: number;
  roleConstraintFailureCount: number;
  chainMandatoryFailureBreakdown: Record<string, number>;
  relationFailureCount: number;
  polarityMismatchCount: number;
  highConfidenceEligibleCount: number;
  scoreCalibration: {
    maxConfidence: number;
    saturationPreventedCount: number;
  };
};

const ACTOR_HINTS = [
  "state",
  "government",
  "union of india",
  "prosecution",
  "department",
  "director",
  "accused",
  "complainant",
  "public servant",
];

const PROCEEDING_HINTS = [
  "criminal appeal",
  "appeal",
  "revision",
  "writ petition",
  "trial",
  "investigation",
  "section 482 crpc",
  "special leave petition",
];

const OUTCOME_HINTS = [
  "dismissed",
  "rejected",
  "refused",
  "denied",
  "allowed",
  "quashed",
  "acquitted",
  "convicted",
  "time barred",
  "barred by limitation",
  "delay not condoned",
  "sanction required",
  "sanction not required",
];

const INTERACTION_CUES = [
  "read with",
  "vis-a-vis",
  "vis a vis",
  "interplay",
  "interaction",
  "requires under",
  "for prosecution under",
  "under section",
];

const STRUCTURAL_INTERACTION_PATTERNS: RegExp[] = [
  /\b(?:offence|prosecution|charge)\s+under\s+section\s*[0-9]+(?:\([0-9a-z]+\))*(?:\([a-z]\))?/i,
  /\brequires?\s+(?:sanction|approval|permission)\s+under\s+section\s*[0-9]+(?:\([0-9a-z]+\))*(?:\([a-z]\))?/i,
  /\bfor\s+section\s*[0-9]+(?:\([0-9a-z]+\))*(?:\([a-z]\))?\s+under\s+section\s*[0-9]+(?:\([0-9a-z]+\))*(?:\([a-z]\))?/i,
  /\bsection\s*[0-9]+(?:\([0-9a-z]+\))*(?:\([a-z]\))?\s+.*\b(?:with|read with|along with|vis[-\s]?a[-\s]?vis)\b/i,
];

const INTERACTION_NEGATION_TERMS = [
  "interaction not required",
  "no statutory interaction",
  "independent provisions",
  "no overlap between provisions",
];

const OUTCOME_TERMS_BY_POLARITY: Record<
  ReasonerOutcomePolarity,
  { positive: string[]; contradiction: string[] }
> = {
  required: {
    positive: [
      "required",
      "must be required",
      "mandatory",
      "necessary",
      "sanction required",
      "prior sanction",
      "previous sanction",
    ],
    contradiction: [
      "not required",
      "no sanction required",
      "sanction unnecessary",
      "without sanction",
      "sanction dispensed",
    ],
  },
  not_required: {
    positive: [
      "not required",
      "no sanction required",
      "sanction unnecessary",
      "without sanction",
      "sanction not required",
    ],
    contradiction: ["sanction required", "prior sanction", "mandatory sanction", "previous sanction"],
  },
  allowed: {
    positive: ["allowed", "granted", "condoned", "restored", "set aside rejection"],
    contradiction: ["dismissed", "refused", "rejected", "declined", "not condoned", "time barred"],
  },
  refused: {
    positive: ["refused", "rejected", "declined", "not condoned", "denied"],
    contradiction: ["allowed", "granted", "condoned", "restored", "set aside refusal"],
  },
  dismissed: {
    positive: ["dismissed", "time barred", "barred by limitation", "dismissed as barred", "delay not condoned"],
    contradiction: ["allowed", "restored", "set aside dismissal", "delay condoned"],
  },
  quashed: {
    positive: ["quashed", "set aside", "proceedings quashed"],
    contradiction: ["upheld", "confirmed", "sustained", "prosecution continued"],
  },
  unknown: {
    positive: [],
    contradiction: [],
  },
};

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return fallback;
}

const STRICT_INTERSECTION_REQUIRED_WHEN_MULTIHOOK = parseBooleanEnv(
  process.env.STRICT_INTERSECTION_REQUIRED_WHEN_MULTIHOOK,
  true,
);
const STRICT_HIGH_CONFIDENCE_ONLY = parseBooleanEnv(process.env.STRICT_HIGH_CONFIDENCE_ONLY, true);
const PROVISIONAL_CONFIDENCE_CAP = Math.min(
  0.8,
  Math.max(Number(process.env.PROVISIONAL_CONFIDENCE_CAP ?? "0.70"), 0.45),
);
const EXPLORATORY_CONFIDENCE_CAP = Math.min(
  0.55,
  Math.max(
    Number(process.env.EXPLORATORY_CONFIDENCE_CAP ?? process.env.NEARMISS_CONFIDENCE_CAP ?? "0.45"),
    0.3,
  ),
);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[`"'[\]{}]/g, " ")
    .replace(/[^a-z0-9\s()./:-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTerm(input: string): string | null {
  const normalized = normalizeText(input);
  if (!normalized || normalized.length < 2) return null;
  return normalized;
}

function normalizeTerms(values: string[], maxItems: number): string[] {
  return unique(values.map(normalizeTerm).filter((value): value is string => Boolean(value))).slice(0, maxItems);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function containsTerm(text: string, term: string): boolean {
  if (!term) return false;
  if (term.includes(" ")) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function containsOutcomeContradictionTerm(text: string, term: string): boolean {
  if (!term) return false;
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  if (!containsTerm(text, normalizedTerm)) return false;

  // Guard against false contradictions like matching "condoned" inside "not condoned".
  if (normalizedTerm === "condoned" || normalizedTerm === "allowed" || normalizedTerm === "granted") {
    const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const negated = new RegExp(`\\b(?:not|no|without)\\s+(?:been\\s+)?${escaped}\\b`, "i");
    if (negated.test(text)) {
      return false;
    }
  }

  if (normalizedTerm === "restored") {
    if (/\bnot\s+restored\b/i.test(text)) {
      return false;
    }
  }

  return true;
}

function findTermPositions(text: string, term: string): number[] {
  if (!term) return [];
  const positions: number[] = [];
  if (term.includes(" ")) {
    let index = text.indexOf(term);
    while (index >= 0) {
      positions.push(index);
      index = text.indexOf(term, index + term.length);
    }
    return positions;
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b${escaped}\\b`, "gi");
  let match = regex.exec(text);
  while (match) {
    positions.push(match.index);
    match = regex.exec(text);
  }
  return positions;
}

function detectHookFamily(normalized: string): string | null {
  if (/prevention of corruption|pc act/.test(normalized)) return "pc_act";
  if (/\bcrpc\b|criminal procedure/.test(normalized)) return "crpc";
  if (/\bipc\b|indian penal code/.test(normalized)) return "ipc";
  if (/\bcpc\b|civil procedure/.test(normalized)) return "cpc";
  if (/limitation act/.test(normalized)) return "limitation_act";
  return null;
}

function parseSectionToken(normalized: string): string | null {
  const sectionMatch = normalized.match(/\b(?:section\s*)?([0-9]+(?:\([0-9a-z]+\))*(?:\([a-z]\))?)/i);
  return sectionMatch?.[1] ?? null;
}

function inferSectionFamilyFromContext(input: {
  sectionToken: string;
  normalizedTerm: string;
  allTerms: string[];
}): string | null {
  const direct = detectHookFamily(input.normalizedTerm);
  if (direct) return direct;

  const knownFamilies = new Set(
    input.allTerms
      .map((term) => detectHookFamily(normalizeText(term)))
      .filter((value): value is string => Boolean(value)),
  );

  const cleanSection = input.sectionToken.replace(/\s+/g, "").toLowerCase();
  if (/^13(?:\([0-9a-z]+\))*(?:\([a-z]\))?$/.test(cleanSection) && knownFamilies.has("pc_act")) return "pc_act";
  if (/^19(?:\([0-9a-z]+\))*(?:\([a-z]\))?$/.test(cleanSection) && knownFamilies.has("pc_act")) return "pc_act";
  if (/^(197|482|378)(?:\([0-9a-z]+\))*(?:\([a-z]\))?$/.test(cleanSection) && knownFamilies.has("crpc")) return "crpc";
  if (/^(406|420|409|120b|302|304|307)(?:\([0-9a-z]+\))*(?:\([a-z]\))?$/.test(cleanSection) && knownFamilies.has("ipc"))
    return "ipc";

  if (knownFamilies.size === 1) {
    return Array.from(knownFamilies)[0];
  }
  return null;
}

function inferHookFamily(term: string, allTerms: string[] = []): string {
  const normalized = normalizeText(term);
  const sectionToken = parseSectionToken(normalized);
  const family = detectHookFamily(normalized);

  if (sectionToken) {
    const sectionKey = slug(sectionToken.replace(/[()]/g, "_"));
    const boundFamily =
      family ??
      inferSectionFamilyFromContext({
        sectionToken,
        normalizedTerm: normalized,
        allTerms,
      });
    if (boundFamily) return `sec_${boundFamily}_${sectionKey}`;
    return `sec_${sectionKey}`;
  }

  if (family) return family;
  return `hook_${slug(normalized)}`;
}

function expandHookTerm(term: string, boundFamily?: string | null): string[] {
  const normalized = normalizeText(term);
  const expanded: string[] = [normalized];

  const sectionMatch = normalized.match(/\bsection\s*([0-9]+(?:\([0-9a-z]+\))*(?:\([a-z]\))?)/i);
  if (sectionMatch) {
    const sectionToken = sectionMatch[1];
    expanded.push(`section ${sectionToken}`);
    expanded.push(`section ${sectionToken.replace(/[()]/g, " ")}`);
    expanded.push(sectionToken);
    expanded.push(sectionToken.replace(/[()]/g, " "));
  }

  if (/prevention of corruption/.test(normalized) || /\bpc act\b/.test(normalized)) {
    expanded.push("prevention of corruption act", "pc act");
  }
  if (/\bcrpc\b/.test(normalized) || /criminal procedure/.test(normalized)) {
    expanded.push("crpc", "cr.p.c", "code of criminal procedure");
  }
  if (/\bipc\b/.test(normalized) || /indian penal code/.test(normalized)) {
    expanded.push("ipc", "indian penal code");
  }
  if (/limitation act/.test(normalized)) {
    expanded.push("limitation act", "section 5 limitation act");
  }
  if (boundFamily === "pc_act") {
    expanded.push("prevention of corruption act", "pc act");
  } else if (boundFamily === "crpc") {
    expanded.push("crpc", "code of criminal procedure");
  } else if (boundFamily === "ipc") {
    expanded.push("ipc", "indian penal code");
  } else if (boundFamily === "cpc") {
    expanded.push("cpc", "code of civil procedure");
  }
  return normalizeTerms(expanded, 12);
}

function parseOutcomePhrasesFromQuery(query: string): string[] {
  const q = normalizeText(query);
  const phrases: string[] = [];
  const known = [
    "delay not condoned",
    "condonation refused",
    "condonation rejected",
    "appeal dismissed as time barred",
    "barred by limitation",
    "sanction required",
    "sanction not required",
    "proceedings quashed",
    "appeal allowed",
    "appeal dismissed",
  ];
  for (const phrase of known) {
    if (q.includes(phrase)) phrases.push(phrase);
  }
  return phrases;
}

function inferOutcomePolarity(query: string, terms: string[]): ReasonerOutcomePolarity {
  const q = normalizeText(query);
  const bag = normalizeText(`${q} ${terms.join(" ")}`);

  const hasNegativeCondonation =
    /\bdelay\s+(?:has|was|is|had)?\s*not\s+(?:been\s+)?condon(?:ed|able)\b/.test(bag) ||
    /\bnot\s+(?:been\s+|is\s+|was\s+)?condon(?:ed|able)\b/.test(bag) ||
    /\bcondonation(?:\s+of\s+delay)?\s+(?:was\s+|is\s+|has\s+been\s+)?(?:refused|rejected|denied|dismissed|declined)\b/.test(
      bag,
    ) ||
    /\bcondonation(?:\s+of\s+delay)?\s+not\s+granted\b/.test(bag);
  const hasPositiveCondonation =
    /\bdelay\s+(?:has|was|is|had)?\s*(?:been\s+)?condoned\b/.test(bag) ||
    /\bcondonation(?:\s+of\s+delay)?\s+(?:was\s+|is\s+|has\s+been\s+)?granted\b/.test(bag) ||
    /\bappeal\s+(?:was\s+|is\s+|has\s+been\s+)?restored\b/.test(bag);

  if (/\bsanction\b/.test(bag)) {
    if (/\b(?:not required|no sanction required|without sanction)\b/.test(bag)) return "not_required";
    if (/\b(?:must|required|mandatory|necessary|prior|previous)\b/.test(bag)) return "required";
  }
  if (hasNegativeCondonation || /\b(?:not condoned|refused|rejected|declined)\b/.test(bag)) return "refused";
  if (/\b(?:dismissed|time barred|barred by limitation)\b/.test(bag)) return "dismissed";
  if (/\bquashed\b/.test(bag)) return "quashed";
  if (hasPositiveCondonation || /\b(?:allowed|granted|condoned|restored)\b/.test(bag)) return "allowed";
  return "unknown";
}

function normalizeOutcomeConstraint(input: {
  reasonerOutcome?: ReasonerOutcomeConstraint;
  outcomeTerms: string[];
  contradictionTerms: string[];
  query: string;
}): OutcomeConstraint {
  const reasonerPolarity = input.reasonerOutcome?.polarity ?? "unknown";
  const inferredPolarity =
    reasonerPolarity !== "unknown" ? reasonerPolarity : inferOutcomePolarity(input.query, input.outcomeTerms);
  const defaults = OUTCOME_TERMS_BY_POLARITY[inferredPolarity];
  const terms = normalizeTerms(
    [...(input.reasonerOutcome?.terms ?? []), ...input.outcomeTerms, ...defaults.positive],
    14,
  );
  const contradictionTerms = normalizeTerms(
    [...(input.reasonerOutcome?.contradiction_terms ?? []), ...input.contradictionTerms, ...defaults.contradiction],
    16,
  );
  return {
    polarity: inferredPolarity,
    required: terms.length > 0 || inferredPolarity !== "unknown",
    terms,
    contradictionTerms,
  };
}

function buildAxis(input: {
  key: PropositionElementKey;
  label: string;
  required: boolean;
  terms: string[];
}): PropositionAxis {
  return {
    key: input.key,
    label: input.label,
    required: input.required,
    terms: normalizeTerms(input.terms, input.key === "legal_hook" ? 24 : 16),
  };
}

function axisValuesFromReasonerOrContext(
  reasonerValues: string[] | undefined,
  contextValues: string[],
  query: string,
  fallbackHints: string[],
): string[] {
  const q = normalizeText(query);
  return normalizeTerms(
    [
      ...(reasonerValues ?? []),
      ...contextValues,
      ...fallbackHints.filter((hint) => q.includes(hint)),
    ],
    16,
  );
}

function toGroupLabel(groupId: string): string {
  return groupId.replace(/^hook_/, "").replace(/_/g, " ").trim();
}

function buildHookGroupsFromTerms(input: {
  legalHookTerms: string[];
  reasonerPlan?: ReasonerPlan;
}): HookGroupConstraint[] {
  const groups = new Map<string, HookGroupConstraint>();
  const allLegalTerms = [
    ...input.legalHookTerms,
    ...(input.reasonerPlan?.proposition.legal_hooks ?? []),
    ...(input.reasonerPlan?.proposition.hook_groups ?? []).flatMap((group) => group.terms),
  ];

  for (const group of input.reasonerPlan?.proposition.hook_groups ?? []) {
    const groupId = slug(group.group_id);
    if (!groupId) continue;
    groups.set(groupId, {
      groupId,
      label: toGroupLabel(groupId),
      terms: normalizeTerms(group.terms, 12),
      minMatch: Math.max(1, Math.min(group.min_match, 4)),
      required: group.required,
    });
  }

  for (const term of input.legalHookTerms) {
    const normalized = normalizeTerm(term);
    if (!normalized) continue;
    const family = inferHookFamily(normalized, allLegalTerms);
    const groupId = slug(family);
    const familyToken = family.startsWith("sec_")
      ? family.match(/^sec_(pc_act|crpc|ipc|cpc|limitation_act)_/)?.[1] ?? null
      : detectHookFamily(normalized);
    const existing = groups.get(groupId);
    if (!existing) {
      groups.set(groupId, {
        groupId,
        label: toGroupLabel(groupId),
        terms: expandHookTerm(normalized, familyToken),
        minMatch: 1,
        required: true,
      });
      continue;
    }
    existing.terms = normalizeTerms([...existing.terms, ...expandHookTerm(normalized, familyToken)], 16);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      terms: group.terms.slice(0, 16),
      required: group.required,
    }))
    .filter((group) => group.terms.length > 0)
    .slice(0, 8);
}

function buildRelations(input: {
  groups: HookGroupConstraint[];
  cleanedQuery: string;
  reasonerPlan?: ReasonerPlan;
}): { relations: PropositionRelationConstraint[]; interactionRequired: boolean } {
  const reasonerExplicitlyNegatesInteraction = (() => {
    const bag = normalizeText(
      [
        ...(input.reasonerPlan?.must_not_have_terms ?? []),
        ...(input.reasonerPlan?.proposition.outcome_negative ?? []),
      ].join(" "),
    );
    return INTERACTION_NEGATION_TERMS.some((term) => bag.includes(term));
  })();

  const groupIds = new Set(input.groups.map((group) => group.groupId));
  const reasonerRelations = (input.reasonerPlan?.proposition.relations ?? [])
    .filter((relation) => groupIds.has(slug(relation.left_group_id)) && groupIds.has(slug(relation.right_group_id)))
    .map((relation, index) => ({
      relationId: `r_${index}_${slug(`${relation.left_group_id}_${relation.right_group_id}`)}`,
      type: relation.type,
      leftGroupId: slug(relation.left_group_id),
      rightGroupId: slug(relation.right_group_id),
      required: relation.required,
    }));

  const q = normalizeText(input.cleanedQuery);
  const requiredGroupsCount = input.groups.filter((group) => group.required).length;
  const interactionCueDetected = INTERACTION_CUES.some((cue) => q.includes(cue));
  const structuralInteractionDetected = STRUCTURAL_INTERACTION_PATTERNS.some((pattern) => pattern.test(q));
  const inferredInteractionRequired =
    requiredGroupsCount > 1 && (interactionCueDetected || structuralInteractionDetected);
  const strictMultiHookDefault =
    STRICT_INTERSECTION_REQUIRED_WHEN_MULTIHOOK && requiredGroupsCount > 1 && !reasonerExplicitlyNegatesInteraction;
  const interactionRequired =
    Boolean(input.reasonerPlan?.proposition.interaction_required) ||
    inferredInteractionRequired ||
    strictMultiHookDefault;

  if (reasonerRelations.length > 0) {
    return { relations: reasonerRelations, interactionRequired };
  }
  if (!interactionRequired) {
    return { relations: [], interactionRequired };
  }

  const requiredGroups = input.groups.filter((group) => group.required).slice(0, 4);
  const generated: PropositionRelationConstraint[] = [];
  for (let i = 0; i < requiredGroups.length; i += 1) {
    for (let j = i + 1; j < requiredGroups.length; j += 1) {
      const left = requiredGroups[i];
      const right = requiredGroups[j];
      generated.push({
        relationId: `rel_${left.groupId}_${right.groupId}`,
        type: "interacts_with",
        leftGroupId: left.groupId,
        rightGroupId: right.groupId,
        required: true,
      });
    }
  }
  return { relations: generated.slice(0, 8), interactionRequired };
}

function relationSatisfiedByProximity(input: {
  text: string;
  leftTerms: string[];
  rightTerms: string[];
  windowChars: number;
}): boolean {
  const leftPositions = input.leftTerms.flatMap((term) => findTermPositions(input.text, term)).slice(0, 30);
  const rightPositions = input.rightTerms.flatMap((term) => findTermPositions(input.text, term)).slice(0, 30);
  if (leftPositions.length === 0 || rightPositions.length === 0) return false;
  for (const left of leftPositions) {
    for (const right of rightPositions) {
      if (Math.abs(left - right) <= input.windowChars) return true;
    }
  }
  return false;
}

function nearMissThreshold(requiredCount: number): number {
  if (requiredCount <= 1) return 1;
  if (requiredCount === 2) return 0.5;
  if (requiredCount === 3) return 2 / 3;
  return 0.75;
}

const STRICT_PERIPHERAL_COVERAGE_MIN = 0.6;
const NEAR_MISS_CORE_THRESHOLD = 0.65;

function hasDoctrinalNearMissSignals(checklist: PropositionChecklist): boolean {
  const hasRequiredHooks = checklist.hookGroups.some((group) => group.required);
  const hasRequiredRelations = checklist.relations.some((relation) => relation.required) || checklist.interactionRequired;
  const hasRequiredOutcome = checklist.outcomeConstraint.required;
  return hasRequiredHooks || hasRequiredRelations || hasRequiredOutcome;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function confidenceBand(score: number): "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" {
  if (score >= 0.86) return "VERY_HIGH";
  if (score >= 0.71) return "HIGH";
  if (score >= 0.51) return "MEDIUM";
  return "LOW";
}

function exploratoryConfidenceBand(score: number): "MEDIUM" | "LOW" {
  return score >= 0.4 ? "MEDIUM" : "LOW";
}

function isStrictHighConfidenceEligible(input: { caseItem: ScoredCase; result: PropositionGateResult }): boolean {
  return (
    input.result.match === "exact_strict" &&
    Boolean(input.caseItem.verification.detailChecked) &&
    Boolean(input.caseItem.verification.hasRoleSentence) &&
    Boolean(input.caseItem.verification.hasChainSentence) &&
    Boolean(input.caseItem.verification.hasRelationSentence) &&
    Boolean(input.caseItem.verification.hasPolaritySentence) &&
    Boolean(input.caseItem.verification.hasHookIntersectionSentence)
  );
}

function calibrateConfidence(input: {
  caseItem: ScoredCase;
  result: PropositionGateResult;
}): { score: number; saturationPrevented: boolean } {
  const base = input.caseItem.rankingScore ?? input.caseItem.score;
  const structural =
    input.result.coreCoverage * 0.34 +
    input.result.mandatoryStepCoverage * 0.22 +
    input.result.chainCoverage * 0.1 +
    input.result.hookGroupCoverage * 0.12 +
    (input.result.relationSatisfied ? 0.08 : 0) +
    (input.result.outcomePolaritySatisfied ? 0.08 : 0) +
    input.result.peripheralCoverage * 0.06;

  let confidence = clamp(base * 0.45 + structural * 0.55);
  if (!input.caseItem.verification.detailChecked) {
    confidence -= 0.06;
  }
  if (input.caseItem.verification.hasRoleSentence) confidence += 0.02;
  if (input.caseItem.verification.hasChainSentence) confidence += 0.02;
  if (input.caseItem.verification.hasRelationSentence) confidence += 0.03;
  if (input.caseItem.verification.hasPolaritySentence) confidence += 0.03;
  if (input.caseItem.verification.hasHookIntersectionSentence) confidence += 0.03;
  if (!input.result.actorRoleSatisfied) confidence -= 0.12;
  if (!input.result.proceedingRoleSatisfied) confidence -= 0.08;
  if (!input.result.chainSatisfied) confidence -= 0.12;
  if (!input.caseItem.verification.hasRelationSentence && !input.result.relationSatisfied) confidence -= 0.03;
  if (!input.caseItem.verification.hasPolaritySentence && !input.result.outcomePolaritySatisfied) confidence -= 0.04;
  if (input.result.polarityMismatch) confidence -= 0.16;
  if (input.result.contradiction) confidence -= 0.25;
  confidence = clamp(confidence);

  let cap =
    input.result.match === "exact_strict"
      ? 0.95
      : input.result.match === "exact_provisional"
        ? PROVISIONAL_CONFIDENCE_CAP
        : input.result.match === "near_miss"
          ? EXPLORATORY_CONFIDENCE_CAP
          : 0.5;
  const highEligible = isStrictHighConfidenceEligible(input);
  if (STRICT_HIGH_CONFIDENCE_ONLY && !highEligible) {
    cap = Math.min(cap, PROVISIONAL_CONFIDENCE_CAP);
  }
  if (!input.caseItem.verification.detailChecked) {
    cap = Math.min(cap, 0.55);
  }
  const capped = Math.min(confidence, cap);
  return {
    score: Number(capped.toFixed(3)),
    saturationPrevented: confidence > cap,
  };
}

function hasMinimumExploratorySignal(input: {
  caseItem: ScoredCase;
  result: PropositionGateResult;
}): boolean {
  const relevanceMatched =
    input.caseItem.verification.issuesMatched +
      input.caseItem.verification.proceduresMatched +
      input.caseItem.verification.anchorsMatched >=
    2;
  return (
    input.result.requiredCoverage >= 0.25 ||
    input.result.coreCoverage >= 0.25 ||
    relevanceMatched
  );
}

function isExploratoryEligible(input: {
  caseItem: ScoredCase;
  result: PropositionGateResult;
}): boolean {
  return (
    !input.result.contradiction &&
    !input.result.polarityMismatch &&
    (input.caseItem.court === "SC" || input.caseItem.court === "HC") &&
    hasMinimumExploratorySignal(input)
  );
}

function buildUnverifiedChecklist(checklist: PropositionChecklist): PropositionChecklist {
  if (!checklist.graph) {
    return checklist;
  }
  return {
    ...checklist,
    graph: {
      ...checklist.graph,
      mandatorySteps: checklist.graph.mandatorySteps.filter(
        (step) => step.kind !== "chain" && step.kind !== "role",
      ),
      roleConstraints: [],
      chainConstraints: [],
    },
  };
}

export function buildPropositionChecklist(input: {
  context: ContextProfile;
  cleanedQuery: string;
  reasonerPlan?: ReasonerPlan;
}): PropositionChecklist {
  const { context, cleanedQuery, reasonerPlan } = input;
  const actorTerms = axisValuesFromReasonerOrContext(
    reasonerPlan?.proposition.actors,
    context.actors,
    cleanedQuery,
    ACTOR_HINTS,
  );
  const proceedingTerms = axisValuesFromReasonerOrContext(
    reasonerPlan?.proposition.proceeding,
    context.procedures,
    cleanedQuery,
    PROCEEDING_HINTS,
  );
  const legalHookTerms = normalizeTerms(
    [...(reasonerPlan?.proposition.legal_hooks ?? []), ...context.statutesOrSections],
    24,
  );

  const outcomeTerms = normalizeTerms(
    [
      ...(reasonerPlan?.proposition.outcome_required ?? []),
      ...context.issues,
      ...parseOutcomePhrasesFromQuery(cleanedQuery),
      ...OUTCOME_HINTS.filter((hint) => normalizeText(cleanedQuery).includes(hint)),
    ],
    16,
  );
  const contradictionTerms = normalizeTerms(
    [
      ...(reasonerPlan?.proposition.outcome_negative ?? []),
      ...(reasonerPlan?.must_not_have_terms ?? []),
    ],
    16,
  );

  const hookGroups = buildHookGroupsFromTerms({
    legalHookTerms,
    reasonerPlan,
  });
  const relationBundle = buildRelations({
    groups: hookGroups,
    cleanedQuery,
    reasonerPlan,
  });
  const outcomeConstraint = normalizeOutcomeConstraint({
    reasonerOutcome: reasonerPlan?.proposition.outcome_constraint,
    outcomeTerms,
    contradictionTerms,
    query: cleanedQuery,
  });

  const actorRequired = actorTerms.length > 0;
  const proceedingRequired = proceedingTerms.length > 0;
  const legalHookRequired = hookGroups.some((group) => group.required);
  const outcomeRequired = outcomeConstraint.required;

  const axes: PropositionAxis[] = [
    buildAxis({
      key: "actor",
      label: "actor or party role",
      required: actorRequired,
      terms: actorTerms,
    }),
    buildAxis({
      key: "proceeding",
      label: "proceeding or posture",
      required: proceedingRequired,
      terms: proceedingTerms,
    }),
    buildAxis({
      key: "legal_hook",
      label: "statute/section/legal hook",
      required: legalHookRequired,
      terms: legalHookTerms,
    }),
    buildAxis({
      key: "outcome",
      label: "required outcome",
      required: outcomeRequired,
      terms: outcomeConstraint.terms,
    }),
  ];

  const graph = compilePropositionGraph({
    cleanedQuery,
    context,
    actorTerms,
    proceedingTerms,
    outcomeTerms: outcomeConstraint.terms,
    outcomePolarity: outcomeConstraint.polarity,
    hookGroupCount: hookGroups.filter((group) => group.required).length,
  });

  return {
    axes,
    requiredElements: axes.filter((axis) => axis.required).map((axis) => axis.label),
    optionalElements: axes.filter((axis) => !axis.required).map((axis) => axis.label),
    contradictionTerms: normalizeTerms([...contradictionTerms, ...outcomeConstraint.contradictionTerms], 18),
    courtHint: reasonerPlan?.proposition.jurisdiction_hint ?? "ANY",
    hookGroups,
    relations: relationBundle.relations,
    interactionRequired: relationBundle.interactionRequired,
    outcomeConstraint,
    graph,
  };
}

export function evaluatePropositionSignals(
  input: string | PropositionSignalInput,
  checklist: PropositionChecklist,
): PropositionSignalSummary {
  const mainText = typeof input === "string" ? input : input.text;
  const evidenceText = typeof input === "string" ? "" : (input.evidenceText ?? "");
  const normalized = normalizeText(mainText);
  const normalizedEvidence = evidenceText ? normalizeText(evidenceText) : normalized;
  const evidence: string[] = [];

  const axisResults = checklist.axes.map((axis) => {
    const matchedTerms = axis.terms.filter((term) => containsTerm(normalized, term)).slice(0, 3);
    const matched = matchedTerms.length > 0;
    if (matched) {
      evidence.push(`${axis.label}: ${matchedTerms.join(", ")}`);
    }
    return { axis, matched, matchedTerms };
  });

  const matchedElements = axisResults.filter((item) => item.matched).map((item) => item.axis.label);
  const missingElements = axisResults
    .filter((item) => item.axis.required && !item.matched)
    .map((item) => item.axis.label);

  const hookGroups = checklist.hookGroups;
  const requiredHookGroups = hookGroups.filter((group) => group.required);
  const hookGroupResults = hookGroups.map((group) => {
    const matchedTerms = group.terms.filter((term) => containsTerm(normalized, term)).slice(0, 8);
    const matched = matchedTerms.length >= group.minMatch;
    if (matched) {
      evidence.push(`hookGroup[${group.groupId}]: ${matchedTerms.slice(0, 2).join(", ")}`);
    }
    return { group, matched, matchedTerms };
  });
  const matchedRequiredHookGroups = hookGroupResults.filter((item) => item.group.required && item.matched);
  const hookGroupCoverage =
    requiredHookGroups.length > 0 ? matchedRequiredHookGroups.length / requiredHookGroups.length : 1;
  const matchedHookGroups = matchedRequiredHookGroups.map((item) => item.group.groupId);
  const missingHookGroups = hookGroupResults
    .filter((item) => item.group.required && !item.matched)
    .map((item) => item.group.groupId);

  const requiredRelations = checklist.relations.filter((relation) => relation.required);
  const relationFailures: string[] = [];
  for (const relation of requiredRelations) {
    const left = hookGroups.find((group) => group.groupId === relation.leftGroupId);
    const right = hookGroups.find((group) => group.groupId === relation.rightGroupId);
    if (!left || !right) continue;
    const satisfied = relationSatisfiedByProximity({
      text: normalizedEvidence,
      leftTerms: left.terms,
      rightTerms: right.terms,
      windowChars: 220,
    });
    if (!satisfied) {
      relationFailures.push(relation.relationId);
    } else {
      evidence.push(`relation[${relation.type}]: ${left.groupId}↔${right.groupId}`);
    }
  }
  const relationSatisfied = relationFailures.length === 0;

  const matchedOutcomeTerms = checklist.outcomeConstraint.terms.filter((term) =>
    containsTerm(normalizedEvidence, term),
  );
  const matchedOutcomeContradictions = checklist.outcomeConstraint.contradictionTerms.filter((term) =>
    containsOutcomeContradictionTerm(normalizedEvidence, term),
  );
  const outcomePolaritySatisfied =
    !checklist.outcomeConstraint.required ||
    (matchedOutcomeTerms.length > 0 && matchedOutcomeContradictions.length === 0);
  const polarityMismatch = checklist.outcomeConstraint.required && !outcomePolaritySatisfied;
  if (matchedOutcomeTerms.length > 0) {
    evidence.push(`outcome[${checklist.outcomeConstraint.polarity}]: ${matchedOutcomeTerms.slice(0, 2).join(", ")}`);
  }

  const contradictionTerms = checklist.contradictionTerms.filter((term) =>
    containsOutcomeContradictionTerm(normalizedEvidence, term),
  );
  const contradiction = contradictionTerms.length > 0 || matchedOutcomeContradictions.length > 0;
  const contradictionBag = normalizeTerms([...contradictionTerms, ...matchedOutcomeContradictions], 8);
  const graphSignal = evaluatePropositionGraph({
    text: normalized,
    graph: checklist.graph,
    contradictionTerms: contradictionBag,
  });
  evidence.push(...graphSignal.evidence);

  const actorAxis = axisResults.find((item) => item.axis.key === "actor");
  const proceedingAxis = axisResults.find((item) => item.axis.key === "proceeding");
  const peripheralComponents = [
    ...(actorAxis && actorAxis.axis.required ? [{ label: actorAxis.axis.label, ok: actorAxis.matched }] : []),
    ...(proceedingAxis && proceedingAxis.axis.required
      ? [{ label: proceedingAxis.axis.label, ok: proceedingAxis.matched }]
      : []),
    ...graphSignal.peripheralStepResults.map((step) => ({
      label: `step:${step.label}`,
      ok: step.ok,
    })),
  ];

  const coreComponents = [
    ...requiredHookGroups.map((group) => ({
      label: `hook group:${group.groupId}`,
      ok: matchedHookGroups.includes(group.groupId),
    })),
    ...(requiredRelations.length > 0 || checklist.interactionRequired
      ? [
          {
            label: "required hook interaction",
            ok: relationSatisfied && (requiredHookGroups.length <= 1 || matchedRequiredHookGroups.length > 1),
          },
        ]
      : []),
    ...(checklist.outcomeConstraint.required
      ? [{ label: `outcome polarity:${checklist.outcomeConstraint.polarity}`, ok: outcomePolaritySatisfied }]
      : []),
    ...graphSignal.mandatoryStepResults.map((step) => ({
      label: `step:${step.label}`,
      ok: step.ok,
    })),
  ];

  const requiredComponents = [...coreComponents, ...peripheralComponents];
  const satisfiedRequiredComponents = requiredComponents.filter((item) => item.ok).length;
  const requiredCoverage = requiredComponents.length > 0 ? satisfiedRequiredComponents / requiredComponents.length : 0;
  const coreCoverage =
    coreComponents.length > 0 ? coreComponents.filter((item) => item.ok).length / coreComponents.length : 1;
  const peripheralCoverage =
    peripheralComponents.length > 0
      ? peripheralComponents.filter((item) => item.ok).length / peripheralComponents.length
      : 1;

  const mergedMissing = [...missingElements];
  for (const groupId of missingHookGroups) {
    mergedMissing.push(`hook group:${groupId}`);
  }
  if ((requiredRelations.length > 0 || checklist.interactionRequired) && !relationSatisfied) {
    mergedMissing.push("required hook interaction");
  }
  if (polarityMismatch) {
    mergedMissing.push(`outcome polarity:${checklist.outcomeConstraint.polarity}`);
  }
  if (contradiction) {
    mergedMissing.push("contradictory outcome");
  }
  for (const missingStep of graphSignal.missingMandatorySteps) {
    const label = checklist.graph?.mandatorySteps.find((step) => step.id === missingStep)?.label ?? missingStep;
    mergedMissing.push(`mandatory step:${label}`);
  }

  const missingCoreElements = unique(coreComponents.filter((item) => !item.ok).map((item) => item.label));
  const matchedCoreElements = unique(coreComponents.filter((item) => item.ok).map((item) => item.label));
  const missingPeripheralElements = unique(
    peripheralComponents.filter((item) => !item.ok).map((item) => item.label),
  );
  const matchedPeripheralElements = unique(
    peripheralComponents.filter((item) => item.ok).map((item) => item.label),
  );

  return {
    requiredCoverage,
    coreCoverage,
    peripheralCoverage,
    mandatoryStepCoverage:
      graphSignal.mandatoryStepResults.length > 0
        ? graphSignal.matchedMandatorySteps.length / graphSignal.mandatoryStepResults.length
        : 1,
    chainCoverage:
      graphSignal.mandatoryStepResults.filter((step) => step.id.startsWith("chain:")).length > 0
        ? graphSignal.mandatoryStepResults.filter((step) => step.id.startsWith("chain:") && step.ok).length /
          graphSignal.mandatoryStepResults.filter((step) => step.id.startsWith("chain:")).length
        : graphSignal.chainSatisfied
          ? 1
          : 0,
    actorRoleSatisfied: graphSignal.actorRoleSatisfied,
    proceedingRoleSatisfied: graphSignal.proceedingRoleSatisfied,
    chainSatisfied: graphSignal.chainSatisfied,
    matchedMandatorySteps: graphSignal.matchedMandatorySteps,
    missingMandatorySteps: graphSignal.missingMandatorySteps,
    requiredComponentCount: requiredComponents.length,
    coreComponentCount: coreComponents.length,
    peripheralComponentCount: peripheralComponents.length,
    hookGroupCoverage,
    matchedElements: unique([
      ...matchedElements,
      ...matchedHookGroups.map((groupId) => `hook group:${groupId}`),
      ...(relationSatisfied && (requiredRelations.length > 0 || checklist.interactionRequired)
        ? ["required hook interaction"]
        : []),
      ...(outcomePolaritySatisfied && checklist.outcomeConstraint.required
        ? [`outcome polarity:${checklist.outcomeConstraint.polarity}`]
        : []),
    ]),
    missingElements: unique(mergedMissing),
    matchedCoreElements,
    missingCoreElements,
    matchedPeripheralElements,
    missingPeripheralElements,
    matchedHookGroups,
    missingHookGroups,
    relationSatisfied,
    outcomePolaritySatisfied,
    polarityMismatch,
    contradiction,
    contradictionTerms: contradictionBag,
    evidence: unique(evidence).slice(0, 12),
  };
}

export function gateCandidateAgainstProposition(
  candidate: ScoredCase,
  checklist: PropositionChecklist,
): PropositionGateResult {
  const evidenceText = candidate.detailArtifact?.evidenceWindows?.join(" ") ?? "";
  const bodyText = candidate.detailArtifact?.bodyExcerpt?.join(" ") ?? candidate.detailText ?? "";
  const text = `${candidate.title} ${candidate.snippet} ${bodyText}`;
  const effectiveChecklist = candidate.verification.detailChecked
    ? checklist
    : buildUnverifiedChecklist(checklist);
  const signal = evaluatePropositionSignals({ text, evidenceText }, effectiveChecklist);

  const coreRequiredCount = signal.coreComponentCount;
  const requiredCount = signal.requiredComponentCount;
  const threshold = nearMissThreshold(requiredCount);
  const coreThreshold = Math.max(NEAR_MISS_CORE_THRESHOLD, nearMissThreshold(coreRequiredCount));
  const doctrinalNearMissEligible = hasDoctrinalNearMissSignals(checklist);

  const exactStrict =
    candidate.verification.detailChecked &&
    !signal.contradiction &&
    signal.coreCoverage >= 1 &&
    signal.mandatoryStepCoverage >= 1 &&
    signal.hookGroupCoverage >= 1 &&
    signal.relationSatisfied &&
    signal.outcomePolaritySatisfied &&
    signal.chainSatisfied &&
    signal.actorRoleSatisfied &&
    signal.proceedingRoleSatisfied &&
    signal.peripheralCoverage >= STRICT_PERIPHERAL_COVERAGE_MIN;

  if (exactStrict) {
    return {
      match: "exact_strict",
      missingElements: [],
      matchedElements: signal.matchedElements,
      missingCoreElements: [],
      matchedCoreElements: signal.matchedCoreElements,
      matchEvidence: signal.evidence,
      contradiction: false,
      requiredCoverage: signal.requiredCoverage,
      coreCoverage: signal.coreCoverage,
      peripheralCoverage: signal.peripheralCoverage,
      hookGroupCoverage: signal.hookGroupCoverage,
      relationSatisfied: signal.relationSatisfied,
      outcomePolaritySatisfied: signal.outcomePolaritySatisfied,
      polarityMismatch: signal.polarityMismatch,
      mandatoryStepCoverage: signal.mandatoryStepCoverage,
      chainCoverage: signal.chainCoverage,
      actorRoleSatisfied: signal.actorRoleSatisfied,
      proceedingRoleSatisfied: signal.proceedingRoleSatisfied,
      chainSatisfied: signal.chainSatisfied,
      missingMandatorySteps: [],
      matchedMandatorySteps: signal.matchedMandatorySteps,
    };
  }

  const exactProvisional =
    !signal.contradiction &&
    signal.coreCoverage >= 1 &&
    signal.mandatoryStepCoverage >= (candidate.verification.detailChecked ? 1 : 0.75) &&
    signal.hookGroupCoverage >= 1 &&
    signal.relationSatisfied &&
    signal.outcomePolaritySatisfied;

  if (exactProvisional) {
    return {
      match: "exact_provisional",
      missingElements: signal.missingElements,
      matchedElements: signal.matchedElements,
      missingCoreElements: signal.missingCoreElements,
      matchedCoreElements: signal.matchedCoreElements,
      matchEvidence: signal.evidence,
      contradiction: false,
      requiredCoverage: signal.requiredCoverage,
      coreCoverage: signal.coreCoverage,
      peripheralCoverage: signal.peripheralCoverage,
      hookGroupCoverage: signal.hookGroupCoverage,
      relationSatisfied: signal.relationSatisfied,
      outcomePolaritySatisfied: signal.outcomePolaritySatisfied,
      polarityMismatch: signal.polarityMismatch,
      mandatoryStepCoverage: signal.mandatoryStepCoverage,
      chainCoverage: signal.chainCoverage,
      actorRoleSatisfied: signal.actorRoleSatisfied,
      proceedingRoleSatisfied: signal.proceedingRoleSatisfied,
      chainSatisfied: signal.chainSatisfied,
      missingMandatorySteps: signal.missingMandatorySteps,
      matchedMandatorySteps: signal.matchedMandatorySteps,
    };
  }

  const nearMiss =
    doctrinalNearMissEligible &&
    !signal.contradiction &&
    signal.coreCoverage >= coreThreshold &&
    signal.requiredCoverage >= threshold &&
    (signal.matchedCoreElements.length > 0 || signal.matchedElements.length > 0 || signal.matchedHookGroups.length > 0);

  if (nearMiss) {
    return {
      match: "near_miss",
      missingElements: signal.missingElements,
      matchedElements: signal.matchedElements,
      missingCoreElements: signal.missingCoreElements,
      matchedCoreElements: signal.matchedCoreElements,
      matchEvidence: signal.evidence,
      contradiction: false,
      requiredCoverage: signal.requiredCoverage,
      coreCoverage: signal.coreCoverage,
      peripheralCoverage: signal.peripheralCoverage,
      hookGroupCoverage: signal.hookGroupCoverage,
      relationSatisfied: signal.relationSatisfied,
      outcomePolaritySatisfied: signal.outcomePolaritySatisfied,
      polarityMismatch: signal.polarityMismatch,
      mandatoryStepCoverage: signal.mandatoryStepCoverage,
      chainCoverage: signal.chainCoverage,
      actorRoleSatisfied: signal.actorRoleSatisfied,
      proceedingRoleSatisfied: signal.proceedingRoleSatisfied,
      chainSatisfied: signal.chainSatisfied,
      missingMandatorySteps: signal.missingMandatorySteps,
      matchedMandatorySteps: signal.matchedMandatorySteps,
    };
  }

  return {
    match: "reject",
    missingElements: signal.missingElements,
    matchedElements: signal.matchedElements,
    missingCoreElements: signal.missingCoreElements,
    matchedCoreElements: signal.matchedCoreElements,
    matchEvidence: signal.evidence,
    contradiction: signal.contradiction,
    requiredCoverage: signal.requiredCoverage,
    coreCoverage: signal.coreCoverage,
    peripheralCoverage: signal.peripheralCoverage,
    hookGroupCoverage: signal.hookGroupCoverage,
    relationSatisfied: signal.relationSatisfied,
    outcomePolaritySatisfied: signal.outcomePolaritySatisfied,
    polarityMismatch: signal.polarityMismatch,
    mandatoryStepCoverage: signal.mandatoryStepCoverage,
    chainCoverage: signal.chainCoverage,
    actorRoleSatisfied: signal.actorRoleSatisfied,
    proceedingRoleSatisfied: signal.proceedingRoleSatisfied,
    chainSatisfied: signal.chainSatisfied,
    missingMandatorySteps: signal.missingMandatorySteps,
    matchedMandatorySteps: signal.matchedMandatorySteps,
  };
}

export function splitByProposition(rankedCases: ScoredCase[], checklist: PropositionChecklist): PropositionGateSummary {
  const exactStrict: ScoredCase[] = [];
  const exactProvisional: ScoredCase[] = [];
  const exact: ScoredCase[] = [];
  const nearMiss: NearMissCase[] = [];
  const unverifiedRejectBackfill: Array<{
    enriched: ScoredCase;
    missingElements: string[];
    missingCoreElements: string[];
    signalStrength: number;
  }> = [];
  const missingElementBreakdown: Record<string, number> = {};
  const coreFailureBreakdown: Record<string, number> = {};
  const chainMandatoryFailureBreakdown: Record<string, number> = {};
  let contradictionRejectCount = 0;
  let relationFailureCount = 0;
  let polarityMismatchCount = 0;
  let roleConstraintFailureCount = 0;
  let highConfidenceEligibleCount = 0;
  let saturationPreventedCount = 0;
  const coverageValues: number[] = [];
  const hookCoverageValues: number[] = [];
  const chainCoverageValues: number[] = [];
  const confidenceValues: number[] = [];
  const doctrinalNearMissEligible = hasDoctrinalNearMissSignals(checklist);

  for (const item of rankedCases) {
    const result = gateCandidateAgainstProposition(item, checklist);
    const calibrated = calibrateConfidence({ caseItem: item, result });
    const exploratoryScore = Math.min(calibrated.score, EXPLORATORY_CONFIDENCE_CAP);
    const enriched = {
      ...item,
      score: calibrated.score,
      confidenceScore: calibrated.score,
      confidenceBand: confidenceBand(calibrated.score),
      fallbackReason: "none" as const,
      exactnessType:
        result.match === "exact_strict"
          ? ("strict" as const)
          : result.match === "exact_provisional"
            ? ("provisional" as const)
            : undefined,
      missingCoreElements: result.missingCoreElements,
      missingMandatorySteps: result.missingMandatorySteps,
      matchEvidence: result.matchEvidence,
      propositionStepEvidence: result.matchEvidence,
      roleMatch: {
        actorRoleSatisfied: result.actorRoleSatisfied,
        proceedingRoleSatisfied: result.proceedingRoleSatisfied,
      },
    };
    if (calibrated.saturationPrevented) saturationPreventedCount += 1;
    if (isStrictHighConfidenceEligible({ caseItem: item, result }) && calibrated.score >= 0.71) {
      highConfidenceEligibleCount += 1;
    }

    coverageValues.push(result.requiredCoverage);
    hookCoverageValues.push(result.hookGroupCoverage);
    chainCoverageValues.push(result.chainCoverage);
    confidenceValues.push(calibrated.score);

    if (result.match === "exact_strict") {
      exactStrict.push({
        ...enriched,
        exactnessType: "strict",
        retrievalTier: "exact_strict",
      });
      exact.push({
        ...enriched,
        exactnessType: "strict",
        retrievalTier: "exact_strict",
      });
      continue;
    }

    if (result.match === "exact_provisional") {
      exactProvisional.push({
        ...enriched,
        exactnessType: "provisional",
        retrievalTier: "exact_provisional",
      });
      exact.push({
        ...enriched,
        exactnessType: "provisional",
        retrievalTier: "exact_provisional",
      });
      continue;
    }

    if (result.match === "near_miss" && isExploratoryEligible({ caseItem: item, result })) {
      nearMiss.push({
        ...enriched,
        score: exploratoryScore,
        confidenceScore: exploratoryScore,
        confidenceBand: exploratoryConfidenceBand(exploratoryScore),
        retrievalTier: "exploratory",
        missingElements: result.missingElements,
        missingCoreElements: result.missingCoreElements,
        gapSummary: result.missingElements,
      });
    } else if (
      isExploratoryEligible({ caseItem: item, result }) &&
      !item.verification.detailChecked &&
      (result.requiredCoverage >= 0.25 ||
        result.coreCoverage >= 0.2 ||
        result.matchedElements.length > 0 ||
        result.matchedCoreElements.length > 0)
    ) {
      unverifiedRejectBackfill.push({
        enriched,
        missingElements: result.missingElements,
        missingCoreElements: result.missingCoreElements,
        signalStrength:
          result.requiredCoverage * 0.45 +
          result.coreCoverage * 0.35 +
          result.hookGroupCoverage * 0.1 +
          (result.outcomePolaritySatisfied ? 0.1 : 0),
      });
    }

    if (result.contradiction) contradictionRejectCount += 1;
    if (!result.relationSatisfied && checklist.relations.some((relation) => relation.required)) relationFailureCount += 1;
    if (result.polarityMismatch) polarityMismatchCount += 1;
    if (!result.actorRoleSatisfied || !result.proceedingRoleSatisfied || !result.chainSatisfied) {
      roleConstraintFailureCount += 1;
    }
    for (const missingMandatory of result.missingMandatorySteps) {
      chainMandatoryFailureBreakdown[missingMandatory] =
        (chainMandatoryFailureBreakdown[missingMandatory] ?? 0) + 1;
    }
    for (const missingCore of result.missingCoreElements) {
      coreFailureBreakdown[missingCore] = (coreFailureBreakdown[missingCore] ?? 0) + 1;
    }

    for (const missing of result.missingElements) {
      missingElementBreakdown[missing] = (missingElementBreakdown[missing] ?? 0) + 1;
    }
  }

  if (doctrinalNearMissEligible && exact.length === 0 && nearMiss.length === 0 && unverifiedRejectBackfill.length > 0) {
    const seenUrls = new Set<string>();
    const fallbackNearMisses = [...unverifiedRejectBackfill]
      .sort((a, b) => {
        const aScore = a.signalStrength + (a.enriched.confidenceScore ?? a.enriched.score) * 0.4;
        const bScore = b.signalStrength + (b.enriched.confidenceScore ?? b.enriched.score) * 0.4;
        return bScore - aScore;
      })
      .filter((entry) => {
        if (seenUrls.has(entry.enriched.url)) return false;
        seenUrls.add(entry.enriched.url);
        return true;
      })
      .slice(0, Math.min(8, rankedCases.length))
      .map((entry) => ({
        ...entry.enriched,
        score: Math.min(entry.enriched.confidenceScore ?? entry.enriched.score, EXPLORATORY_CONFIDENCE_CAP),
        confidenceScore: Math.min(entry.enriched.confidenceScore ?? entry.enriched.score, EXPLORATORY_CONFIDENCE_CAP),
        confidenceBand: exploratoryConfidenceBand(
          Math.min(entry.enriched.confidenceScore ?? entry.enriched.score, EXPLORATORY_CONFIDENCE_CAP),
        ),
        retrievalTier: "exploratory" as const,
        missingElements: entry.missingElements,
        missingCoreElements: entry.missingCoreElements,
        gapSummary: entry.missingElements,
      }));

    nearMiss.push(...fallbackNearMisses);
  }

  const requiredElementCoverageAvg =
    coverageValues.length > 0
      ? Math.round((coverageValues.reduce((sum, value) => sum + value, 0) / coverageValues.length) * 1000) / 1000
      : 0;
  const hookGroupCoverageAvg =
    hookCoverageValues.length > 0
      ? Math.round((hookCoverageValues.reduce((sum, value) => sum + value, 0) / hookCoverageValues.length) * 1000) /
        1000
      : 0;
  const maxConfidence =
    confidenceValues.length > 0 ? Number(Math.max(...confidenceValues).toFixed(3)) : 0;
  const chainCoverageAvg =
    chainCoverageValues.length > 0
      ? Math.round((chainCoverageValues.reduce((sum, value) => sum + value, 0) / chainCoverageValues.length) * 1000) /
        1000
      : 0;

  return {
    exactStrict,
    exactProvisional,
    exact,
    nearMiss,
    exactMatchCount: exact.length,
    strictExactCount: exactStrict.length,
    provisionalExactCount: exactProvisional.length,
    nearMissCount: nearMiss.length,
    missingElementBreakdown,
    coreFailureBreakdown,
    requiredElementCoverageAvg,
    contradictionRejectCount,
    hookGroupCoverageAvg,
    chainCoverageAvg,
    roleConstraintFailureCount,
    chainMandatoryFailureBreakdown,
    relationFailureCount,
    polarityMismatchCount,
    highConfidenceEligibleCount,
    scoreCalibration: {
      maxConfidence,
      saturationPreventedCount,
    },
  };
}
