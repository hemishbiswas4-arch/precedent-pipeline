import { ContextProfile } from "@/lib/types";

export type ReasonerCourtHint = "SC" | "HC" | "ANY";
export type ReasonerOutcomePolarity =
  | "required"
  | "not_required"
  | "allowed"
  | "refused"
  | "dismissed"
  | "quashed"
  | "unknown";
export type ReasonerRelationType = "requires" | "applies_to" | "interacts_with" | "excluded_by";

export type ReasonerHookGroup = {
  group_id: string;
  terms: string[];
  min_match: number;
  required: boolean;
};

export type ReasonerRelation = {
  type: ReasonerRelationType;
  left_group_id: string;
  right_group_id: string;
  required: boolean;
};

export type ReasonerOutcomeConstraint = {
  polarity: ReasonerOutcomePolarity;
  modality?: string;
  terms: string[];
  contradiction_terms: string[];
};

export type ReasonerProposition = {
  actors: string[];
  proceeding: string[];
  legal_hooks: string[];
  outcome_required: string[];
  outcome_negative: string[];
  jurisdiction_hint: ReasonerCourtHint;
  hook_groups: ReasonerHookGroup[];
  relations: ReasonerRelation[];
  outcome_constraint: ReasonerOutcomeConstraint;
  interaction_required: boolean;
};

export type ReasonerPlan = {
  proposition: ReasonerProposition;
  must_have_terms: string[];
  must_not_have_terms: string[];
  query_variants_strict: string[];
  query_variants_broad: string[];
  case_anchors: string[];
};

export type ReasonerValidationResult = {
  plan: ReasonerPlan;
  warnings: string[];
};

export type ReasonerSketch = {
  actors: string[];
  proceeding: string[];
  outcome: string[];
  hooks: string[];
  polarity: ReasonerOutcomePolarity;
  strict_terms: string[];
  broad_terms: string[];
  court_hint: ReasonerCourtHint;
};

export type ReasonerSketchValidationResult = {
  sketch: ReasonerSketch;
  warnings: string[];
};

export type ReasonerGroundingTelemetry = {
  applied: boolean;
  droppedOutcome: boolean;
  droppedHooks: number;
  variantPrunedCount: number;
};

function asTextList(value: unknown, maxItems: number, maxTokenLength = 120): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const normalized = raw
      .toLowerCase()
      .replace(/[\n\r\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) continue;
    if (normalized.length > maxTokenLength) continue;
    if (output.includes(normalized)) continue;
    output.push(normalized);
    if (output.length >= maxItems) break;
  }
  return output;
}

function asTextListFlexible(value: unknown, maxItems: number, maxTokenLength = 120): string[] {
  if (Array.isArray(value)) return asTextList(value, maxItems, maxTokenLength);
  if (typeof value === "string") return asTextList([value], maxItems, maxTokenLength);
  return [];
}

function mergeTextAliases(values: unknown[], maxItems: number, maxTokenLength = 120): string[] {
  const output: string[] = [];
  for (const value of values) {
    for (const token of asTextListFlexible(value, maxItems, maxTokenLength)) {
      if (output.includes(token)) continue;
      output.push(token);
      if (output.length >= maxItems) return output;
    }
  }
  return output;
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function sanitizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 48);
}

function normalizeCourtHint(value: unknown): ReasonerCourtHint {
  if (typeof value !== "string") return "ANY";
  const normalized = value.trim().toUpperCase();
  if (normalized === "SC") return "SC";
  if (normalized === "HC") return "HC";
  return "ANY";
}

function normalizeOutcomePolarity(value: unknown): ReasonerOutcomePolarity {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized === "required") return "required";
  if (normalized === "not_required" || normalized === "not required") return "not_required";
  if (normalized === "allowed") return "allowed";
  if (normalized === "refused") return "refused";
  if (normalized === "dismissed") return "dismissed";
  if (normalized === "quashed") return "quashed";
  return "unknown";
}

function normalizeRelationType(value: unknown): ReasonerRelationType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "requires") return "requires";
  if (normalized === "applies_to" || normalized === "applies to") return "applies_to";
  if (normalized === "interacts_with" || normalized === "interacts with") return "interacts_with";
  if (normalized === "excluded_by" || normalized === "excluded by") return "excluded_by";
  return null;
}

function isWeakHookTerm(term: string): boolean {
  const normalized = term.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.length <= 1) return true;
  if (/^\d{1,4}$/.test(normalized)) return true;
  if (/^(?:[ivxlcdm]+)$/.test(normalized)) return true;
  return false;
}

function isStatutoryHookTerm(term: string): boolean {
  const normalized = term.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /\bsection\s*\d+[a-z]?(?:\([0-9a-z]+\))*(?:\([a-z]\))?/i.test(normalized) ||
    /\barticle\s*\d+[a-z]?\b/i.test(normalized) ||
    /\b(?:ipc|crpc|bnss|cpc|pc act|limitation act|prevention of corruption act)\b/i.test(normalized) ||
    /\b[a-z][a-z\s]{2,}\s+act\b/i.test(normalized)
  );
}

function asHookGroups(value: unknown): ReasonerHookGroup[] {
  if (!Array.isArray(value)) return [];
  const output: ReasonerHookGroup[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const payload = raw as Record<string, unknown>;
    const groupId = sanitizeId(payload.group_id);
    if (!groupId) continue;
    const terms = asTextList(payload.terms, 10).filter((term) => !isWeakHookTerm(term));
    if (terms.length === 0) continue;
    const minMatchRaw = Number(payload.min_match);
    const minMatch = Number.isFinite(minMatchRaw)
      ? Math.max(1, Math.min(Math.floor(minMatchRaw), Math.min(terms.length, 4)))
      : 1;
    output.push({
      group_id: groupId,
      terms,
      min_match: minMatch,
      required: asBoolean(payload.required, true),
    });
    if (output.length >= 8) break;
  }
  return output;
}

function asRelations(value: unknown, groupIds: Set<string>): ReasonerRelation[] {
  if (!Array.isArray(value)) return [];
  const output: ReasonerRelation[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const payload = raw as Record<string, unknown>;
    const type = normalizeRelationType(payload.type);
    const leftGroupId = sanitizeId(payload.left_group_id);
    const rightGroupId = sanitizeId(payload.right_group_id);
    if (!type || !leftGroupId || !rightGroupId) continue;
    if (!groupIds.has(leftGroupId) || !groupIds.has(rightGroupId)) continue;
    output.push({
      type,
      left_group_id: leftGroupId,
      right_group_id: rightGroupId,
      required: asBoolean(payload.required, true),
    });
    if (output.length >= 12) break;
  }
  return output;
}

function asOutcomeConstraint(value: unknown): ReasonerOutcomeConstraint | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  return {
    polarity: normalizeOutcomePolarity(payload.polarity),
    modality:
      typeof payload.modality === "string" ? payload.modality.toLowerCase().replace(/\s+/g, " ").trim() : undefined,
    terms: asTextList(payload.terms, 10),
    contradiction_terms: asTextList(payload.contradiction_terms, 10),
  };
}

function sanitizeVariant(value: string): string | null {
  const cleaned = value
    .replace(/\b(?:doctypes|sortby|fromdate|todate):\S+/gi, " ")
    .replace(/\b(?:cases?\s+where|precedents?\s+where|judgments?\s+where)\b/gi, " ")
    .replace(/\b(?:find|show|list)\s+(?:me\s+)?(?:cases?|precedents?|judgments?)\b/gi, " ")
    .replace(/[^a-z0-9\s()]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!cleaned) return null;
  const tokens = cleaned.split(/\s+/).slice(0, 14);
  if (tokens.length < 2) return null;
  return tokens.join(" ");
}

function sanitizeVariants(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const cleaned = sanitizeVariant(raw);
    if (!cleaned) continue;
    if (result.includes(cleaned)) continue;
    result.push(cleaned);
    if (result.length >= maxItems) break;
  }
  return result;
}

const EMPTY_PLAN: ReasonerPlan = {
  proposition: {
    actors: [],
    proceeding: [],
    legal_hooks: [],
    outcome_required: [],
    outcome_negative: [],
    jurisdiction_hint: "ANY",
    hook_groups: [],
    relations: [],
    outcome_constraint: {
      polarity: "unknown",
      terms: [],
      contradiction_terms: [],
    },
    interaction_required: false,
  },
  must_have_terms: [],
  must_not_have_terms: [],
  query_variants_strict: [],
  query_variants_broad: [],
  case_anchors: [],
};

const EMPTY_SKETCH: ReasonerSketch = {
  actors: [],
  proceeding: [],
  outcome: [],
  hooks: [],
  polarity: "unknown",
  strict_terms: [],
  broad_terms: [],
  court_hint: "ANY",
};

function uniqueTerms(values: string[], maxItems: number): string[] {
  const output: string[] = [];
  for (const value of values) {
    if (!value || output.includes(value)) continue;
    output.push(value);
    if (output.length >= maxItems) break;
  }
  return output;
}

function makeVariant(terms: string[], maxTokens = 12): string | null {
  const cleaned = terms
    .flatMap((entry) => entry.split(/\s+/))
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (cleaned.length < 2) return null;
  return sanitizeVariant(cleaned.slice(0, maxTokens).join(" "));
}

function defaultContradictionTerms(polarity: ReasonerOutcomePolarity): string[] {
  if (polarity === "refused") {
    return ["condoned", "delay condoned", "allowed", "restored"];
  }
  if (polarity === "dismissed") {
    return ["allowed", "set aside", "restored"];
  }
  if (polarity === "required") {
    return ["not required", "without", "dispensed with"];
  }
  if (polarity === "not_required") {
    return ["required", "mandatory", "necessary"];
  }
  return [];
}

export function validateReasonerSketch(raw: unknown): ReasonerSketchValidationResult {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object") {
    warnings.push("reasoner sketch payload is not an object");
    return { sketch: EMPTY_SKETCH, warnings };
  }

  const payload = raw as Record<string, unknown>;
  const propositionRaw =
    payload.proposition && typeof payload.proposition === "object"
      ? (payload.proposition as Record<string, unknown>)
      : {};
  const outcomeConstraintRaw =
    propositionRaw.outcome_constraint && typeof propositionRaw.outcome_constraint === "object"
      ? (propositionRaw.outcome_constraint as Record<string, unknown>)
      : {};

  const sketch: ReasonerSketch = {
    actors: mergeTextAliases(
      [payload.actors, payload.actor, propositionRaw.actors, propositionRaw.actor, propositionRaw.actor_role],
      8,
    ),
    proceeding: mergeTextAliases(
      [payload.proceeding, payload.posture, propositionRaw.proceeding, propositionRaw.posture],
      8,
    ),
    outcome: mergeTextAliases(
      [
        payload.outcome,
        payload.outcome_required,
        payload.required_outcome,
        propositionRaw.outcome_required,
        propositionRaw.required_outcome,
      ],
      10,
      160,
    ),
    hooks: mergeTextAliases(
      [payload.hooks, payload.legal_hooks, propositionRaw.legal_hooks, payload.statutes, payload.statutes_or_sections],
      12,
      160,
    ),
    polarity: normalizeOutcomePolarity(
      payload.polarity ?? payload.outcome_polarity ?? outcomeConstraintRaw.polarity ?? propositionRaw.outcome_polarity,
    ),
    strict_terms: sanitizeVariants(payload.strict_terms ?? payload.query_variants_strict, 12),
    broad_terms: sanitizeVariants(payload.broad_terms ?? payload.query_variants_broad, 12),
    court_hint: normalizeCourtHint(payload.court_hint ?? payload.jurisdiction_hint ?? propositionRaw.jurisdiction_hint),
  };

  if (sketch.strict_terms.length === 0) {
    warnings.push("reasoner sketch has no strict_terms");
  }
  return { sketch, warnings };
}

export function expandReasonerPlanFromSketch(sketch: ReasonerSketch): ReasonerPlan {
  const mustHaveTerms = uniqueTerms(
    [...sketch.actors, ...sketch.proceeding, ...sketch.outcome, ...sketch.hooks, ...sketch.strict_terms],
    16,
  );
  const contradictionTerms = defaultContradictionTerms(sketch.polarity);
  const strictVariantsFromSketch = sanitizeVariants(sketch.strict_terms, 12);
  const strictVariantsFallback = [
    makeVariant([sketch.actors[0] ?? "", sketch.proceeding[0] ?? "", sketch.outcome[0] ?? "", ...(sketch.hooks.slice(0, 2) ?? [])]),
    makeVariant([sketch.actors[0] ?? "", sketch.proceeding[0] ?? "", sketch.outcome[0] ?? ""]),
    makeVariant([sketch.proceeding[0] ?? "", sketch.outcome[0] ?? "", ...(sketch.hooks.slice(0, 2) ?? [])]),
  ]
    .filter((value): value is string => Boolean(value));
  const strictVariants = uniqueTerms([...strictVariantsFromSketch, ...strictVariantsFallback], 12);
  const broadVariants = uniqueTerms(
    [
      ...sanitizeVariants(sketch.broad_terms, 12),
      ...sanitizeVariants(sketch.strict_terms, 12),
      makeVariant([sketch.proceeding[0] ?? "", sketch.outcome[0] ?? "", sketch.hooks[0] ?? ""]) ?? "",
      makeVariant([sketch.outcome[0] ?? "", sketch.hooks[0] ?? ""]) ?? "",
    ].filter(Boolean) as string[],
    12,
  );

  const hookGroupsRaw = sketch.hooks
    .map((hook) => hook.trim().toLowerCase())
    .filter((hook) => hook.length > 0 && !isWeakHookTerm(hook))
    .slice(0, 6);
  const disjunctiveSketch =
    /\b(?:or|either|alternatively|versus|vs\.?|instead of)\b/.test(sketch.outcome.join(" ")) ||
    /\b(?:or|either|alternatively|versus|vs\.?|instead of)\b/.test(sketch.proceeding.join(" ")) ||
    /\b(?:or|either|alternatively|versus|vs\.?|instead of)\b/.test(sketch.strict_terms.join(" "));
  const statutoryHookCount = hookGroupsRaw.filter((hook) => isStatutoryHookTerm(hook)).length;
  const hookGroups: ReasonerHookGroup[] = hookGroupsRaw.map((hook, index) => {
    const statutory = isStatutoryHookTerm(hook);
    const required = disjunctiveSketch
      ? statutory
      : statutoryHookCount > 0
        ? statutory
        : index === 0;
    return {
      group_id: `hook_${index + 1}`,
      terms: [hook],
      min_match: 1,
      required,
    };
  });
  if (hookGroups.length > 0 && !hookGroups.some((group) => group.required)) {
    hookGroups[0].required = true;
  }
  const relations: ReasonerRelation[] = [];

  return {
    proposition: {
      actors: sketch.actors,
      proceeding: sketch.proceeding,
      legal_hooks: hookGroupsRaw,
      outcome_required: sketch.outcome,
      outcome_negative: contradictionTerms,
      jurisdiction_hint: sketch.court_hint,
      hook_groups: hookGroups,
      relations,
      outcome_constraint: {
        polarity: sketch.polarity,
        terms: uniqueTerms([...sketch.outcome, ...sketch.strict_terms.slice(0, 2)], 10),
        contradiction_terms: contradictionTerms,
      },
      interaction_required: false,
    },
    must_have_terms: mustHaveTerms,
    must_not_have_terms: contradictionTerms,
    query_variants_strict: strictVariants,
    query_variants_broad: broadVariants,
    case_anchors: uniqueTerms([...sketch.strict_terms, ...sketch.outcome, ...sketch.proceeding], 12),
  };
}

export function validateReasonerPlan(raw: unknown): ReasonerValidationResult {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object") {
    warnings.push("reasoner payload is not an object");
    return { plan: EMPTY_PLAN, warnings };
  }

  const payload = raw as Record<string, unknown>;
  const propositionRaw =
    payload.proposition && typeof payload.proposition === "object"
      ? (payload.proposition as Record<string, unknown>)
      : {};

  const hookGroups = asHookGroups(propositionRaw.hook_groups);
  const hookGroupIds = new Set(hookGroups.map((group) => group.group_id));
  const relations = asRelations(propositionRaw.relations, hookGroupIds);
  const normalizedOutcomeConstraint = asOutcomeConstraint(propositionRaw.outcome_constraint);

  const proposition: ReasonerProposition = {
    actors: mergeTextAliases([propositionRaw.actors, propositionRaw.actor, propositionRaw.actor_role], 8),
    proceeding: mergeTextAliases([propositionRaw.proceeding, propositionRaw.posture], 8),
    legal_hooks: asTextList(propositionRaw.legal_hooks, 12),
    outcome_required: mergeTextAliases([propositionRaw.outcome_required, propositionRaw.required_outcome], 10, 160),
    outcome_negative: asTextList(propositionRaw.outcome_negative, 10),
    jurisdiction_hint: normalizeCourtHint(propositionRaw.jurisdiction_hint),
    hook_groups: hookGroups,
    relations,
    outcome_constraint:
      normalizedOutcomeConstraint ??
      ({
        polarity: "unknown",
        terms: asTextList(propositionRaw.outcome_required, 10),
        contradiction_terms: asTextList(propositionRaw.outcome_negative, 10),
      } satisfies ReasonerOutcomeConstraint),
    interaction_required: asBoolean(propositionRaw.interaction_required, false),
  };

  const strictVariants = sanitizeVariants(payload.query_variants_strict, 12);
  const broadVariants = sanitizeVariants(payload.query_variants_broad, 12);

  if (strictVariants.length === 0) {
    warnings.push("no valid strict variants from reasoner");
  }

  const plan: ReasonerPlan = {
    proposition,
    must_have_terms: asTextList(payload.must_have_terms, 16),
    must_not_have_terms: asTextList(payload.must_not_have_terms, 16),
    query_variants_strict: strictVariants,
    query_variants_broad: broadVariants,
    case_anchors: asTextList(payload.case_anchors, 12),
  };

  return { plan, warnings };
}

export function isUsableReasonerPlan(plan: ReasonerPlan): boolean {
  return plan.query_variants_strict.length > 0 || plan.query_variants_broad.length > 0;
}

function normalizeForGrounding(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s()/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForGrounding(value: string): string[] {
  return normalizeForGrounding(value)
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function hasOutcomePolarityEvidence(input: { cleanedQuery: string; context: ContextProfile }): boolean {
  const q = normalizeForGrounding(input.cleanedQuery);
  const contextIssues = input.context.issues.map((issue) => normalizeForGrounding(issue));
  if (contextIssues.length > 0) return true;
  return /\b(refused|rejected|dismissed|allowed|quashed|denied|required|not required|time barred|barred by limitation|not condoned|condoned)\b/.test(
    q,
  );
}

function buildLegalSignalTokenSet(input: { cleanedQuery: string; context: ContextProfile }): Set<string> {
  const signals = new Set<string>();
  const sourceTerms = [...input.context.statutesOrSections, input.cleanedQuery];
  for (const term of sourceTerms) {
    const normalized = normalizeForGrounding(term);
    if (!normalized) continue;
    for (const token of tokenizeForGrounding(normalized)) {
      signals.add(token);
    }
    if (/\bpc act\b|\bprevention of corruption\b/.test(normalized)) {
      ["pc", "prevention", "corruption", "act"].forEach((token) => signals.add(token));
    }
    if (/\bcrpc\b|\bbnss\b|\bcriminal procedure\b|bharatiya nagarik suraksha sanhita/.test(normalized)) {
      ["crpc", "bnss", "criminal", "procedure", "code", "bharatiya", "nagarik", "suraksha", "sanhita"].forEach(
        (token) => signals.add(token),
      );
    }
    if (/\bipc\b|\bindian penal code\b/.test(normalized)) {
      ["ipc", "indian", "penal", "code"].forEach((token) => signals.add(token));
    }
    const sectionMatches = normalized.match(/\d+(?:\([0-9a-z]+\))*/g) ?? [];
    for (const section of sectionMatches) {
      signals.add(section);
      signals.add(section.replace(/[()]/g, ""));
    }
  }
  return signals;
}

function isSupportedHookTerm(term: string, legalSignals: Set<string>): boolean {
  const normalized = normalizeForGrounding(term);
  if (!normalized) return false;
  const tokens = tokenizeForGrounding(normalized).filter((token) => token !== "section" && token !== "act");
  if (tokens.length === 0) return false;
  const numeric = normalized.match(/\d+(?:\([0-9a-z]+\))*/g) ?? [];
  for (const numberToken of numeric) {
    if (legalSignals.has(numberToken) || legalSignals.has(numberToken.replace(/[()]/g, ""))) {
      return true;
    }
  }
  return tokens.some((token) => legalSignals.has(token));
}

function pruneVariants(variants: string[], blockedTerms: string[]): { kept: string[]; pruned: number } {
  if (variants.length === 0 || blockedTerms.length === 0) {
    return { kept: variants, pruned: 0 };
  }
  const normalizedBlocked = blockedTerms
    .map((term) => normalizeForGrounding(term))
    .filter((term) => term.length > 2);
  const kept = variants.filter((variant) => {
    const phrase = normalizeForGrounding(variant);
    return !normalizedBlocked.some((term) => phrase.includes(term));
  });
  return {
    kept,
    pruned: Math.max(0, variants.length - kept.length),
  };
}

export function groundReasonerPlanToIntent(input: {
  plan: ReasonerPlan;
  cleanedQuery: string;
  context: ContextProfile;
}): {
  plan: ReasonerPlan;
  telemetry: ReasonerGroundingTelemetry;
} {
  const basePlan = input.plan;
  let nextPlan: ReasonerPlan = {
    ...basePlan,
    proposition: {
      ...basePlan.proposition,
      hook_groups: basePlan.proposition.hook_groups.map((group) => ({ ...group, terms: [...group.terms] })),
      relations: basePlan.proposition.relations.map((relation) => ({ ...relation })),
      outcome_constraint: {
        ...basePlan.proposition.outcome_constraint,
        terms: [...basePlan.proposition.outcome_constraint.terms],
        contradiction_terms: [...basePlan.proposition.outcome_constraint.contradiction_terms],
      },
    },
    must_have_terms: [...basePlan.must_have_terms],
    must_not_have_terms: [...basePlan.must_not_have_terms],
    query_variants_strict: [...basePlan.query_variants_strict],
    query_variants_broad: [...basePlan.query_variants_broad],
    case_anchors: [...basePlan.case_anchors],
  };

  let droppedOutcome = false;
  let droppedHooks = 0;
  let variantPrunedCount = 0;

  const hasOutcomeEvidence = hasOutcomePolarityEvidence({
    cleanedQuery: input.cleanedQuery,
    context: input.context,
  });
  if (!hasOutcomeEvidence) {
    droppedOutcome =
      nextPlan.proposition.outcome_required.length > 0 ||
      nextPlan.proposition.outcome_negative.length > 0 ||
      nextPlan.proposition.outcome_constraint.terms.length > 0 ||
      nextPlan.proposition.outcome_constraint.polarity !== "unknown";
    if (droppedOutcome) {
      const droppedTerms = [
        ...nextPlan.proposition.outcome_required,
        ...nextPlan.proposition.outcome_negative,
        ...nextPlan.proposition.outcome_constraint.terms,
      ];
      nextPlan = {
        ...nextPlan,
        proposition: {
          ...nextPlan.proposition,
          outcome_required: [],
          outcome_negative: [],
          outcome_constraint: {
            polarity: "unknown",
            terms: [],
            contradiction_terms: [],
          },
        },
        must_not_have_terms: nextPlan.must_not_have_terms.filter(
          (term) =>
            !droppedTerms.some((dropped) => normalizeForGrounding(term).includes(normalizeForGrounding(dropped))),
        ),
      };
      const strictPrune = pruneVariants(nextPlan.query_variants_strict, droppedTerms);
      const broadPrune = pruneVariants(nextPlan.query_variants_broad, droppedTerms);
      variantPrunedCount += strictPrune.pruned + broadPrune.pruned;
      nextPlan.query_variants_strict = strictPrune.kept;
      nextPlan.query_variants_broad = broadPrune.kept;
    }
  }

  const legalSignals = buildLegalSignalTokenSet({
    cleanedQuery: input.cleanedQuery,
    context: input.context,
  });
  const hasLegalSignal = input.context.statutesOrSections.length > 0;
  if (!hasLegalSignal) {
    droppedHooks +=
      nextPlan.proposition.legal_hooks.length +
      nextPlan.proposition.hook_groups.reduce((sum, group) => sum + group.terms.length, 0);
    nextPlan.proposition.legal_hooks = [];
    nextPlan.proposition.hook_groups = [];
    nextPlan.proposition.relations = [];
    nextPlan.proposition.interaction_required = false;
  } else if (nextPlan.proposition.legal_hooks.length > 0 || nextPlan.proposition.hook_groups.length > 0) {
    const originalHookTerms = [...nextPlan.proposition.legal_hooks];
    const filteredHooks = nextPlan.proposition.legal_hooks.filter((term) => isSupportedHookTerm(term, legalSignals));
    droppedHooks += Math.max(0, nextPlan.proposition.legal_hooks.length - filteredHooks.length);

    const groupMap = new Map<string, string>();
    const filteredGroups = nextPlan.proposition.hook_groups
      .map((group) => {
        const terms = group.terms.filter((term) => isSupportedHookTerm(term, legalSignals));
        if (terms.length === 0) {
          droppedHooks += group.terms.length;
          return null;
        }
        droppedHooks += Math.max(0, group.terms.length - terms.length);
        const groupId = sanitizeId(group.group_id) ?? group.group_id;
        groupMap.set(group.group_id, groupId);
        return {
          ...group,
          group_id: groupId,
          terms,
          min_match: Math.max(1, Math.min(group.min_match, terms.length)),
        };
      })
      .filter((group): group is ReasonerHookGroup => Boolean(group));

    const validGroupIds = new Set(filteredGroups.map((group) => group.group_id));
    const filteredRelations = nextPlan.proposition.relations.filter((relation) => {
      const left = groupMap.get(relation.left_group_id) ?? relation.left_group_id;
      const right = groupMap.get(relation.right_group_id) ?? relation.right_group_id;
      return validGroupIds.has(left) && validGroupIds.has(right);
    });

    nextPlan.proposition.legal_hooks = filteredHooks;
    nextPlan.proposition.hook_groups = filteredGroups;
    nextPlan.proposition.relations = filteredRelations;
    nextPlan.proposition.interaction_required =
      nextPlan.proposition.interaction_required && filteredRelations.length > 0;

    const droppedHookTerms = originalHookTerms.filter((term) => !filteredHooks.includes(term));
    if (droppedHookTerms.length > 0) {
      const strictPrune = pruneVariants(nextPlan.query_variants_strict, droppedHookTerms);
      const broadPrune = pruneVariants(nextPlan.query_variants_broad, droppedHookTerms);
      variantPrunedCount += strictPrune.pruned + broadPrune.pruned;
      nextPlan.query_variants_strict = strictPrune.kept;
      nextPlan.query_variants_broad = broadPrune.kept;
    }
  }

  const telemetry: ReasonerGroundingTelemetry = {
    applied: droppedOutcome || droppedHooks > 0 || variantPrunedCount > 0,
    droppedOutcome,
    droppedHooks,
    variantPrunedCount,
  };

  return { plan: nextPlan, telemetry };
}
