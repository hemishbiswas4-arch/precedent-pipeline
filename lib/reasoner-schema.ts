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

function asHookGroups(value: unknown): ReasonerHookGroup[] {
  if (!Array.isArray(value)) return [];
  const output: ReasonerHookGroup[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const payload = raw as Record<string, unknown>;
    const groupId = sanitizeId(payload.group_id);
    if (!groupId) continue;
    const terms = asTextList(payload.terms, 10);
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
    actors: asTextList(propositionRaw.actors, 8),
    proceeding: asTextList(propositionRaw.proceeding, 8),
    legal_hooks: asTextList(propositionRaw.legal_hooks, 12),
    outcome_required: asTextList(propositionRaw.outcome_required, 10),
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
