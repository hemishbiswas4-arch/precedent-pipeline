import { buildContextProfile } from "@/lib/context";
import { sanitizeNlqForSearch } from "@/lib/nlq";
import { enrichEntities, EnrichedEntities } from "@/lib/pipeline/entity-enrichment";
import { IntentProfile, RetrievalIntentProfile } from "@/lib/pipeline/types";

function parseMonthName(name: string): number | null {
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const idx = months.indexOf(name.toLowerCase());
  return idx >= 0 ? idx + 1 : null;
}

function extractDateWindow(query: string): { fromDate?: string; toDate?: string } {
  const q = query.toLowerCase();
  const yearMatch = q.match(/\b(19[5-9]\d|20\d{2})\b/);
  if (!yearMatch) {
    return {};
  }
  const year = Number(yearMatch[1]);
  const monthNameMatch = q.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/,
  );
  const monthNumberMatch = q.match(/\bmonth[:\s]+(1[0-2]|0?[1-9])\b/);

  let month: number | null = null;
  if (monthNameMatch) {
    month = parseMonthName(monthNameMatch[1]);
  } else if (monthNumberMatch) {
    month = Number(monthNumberMatch[1]);
  }

  if (!month) {
    return {
      fromDate: `1-1-${year}`,
      toDate: `31-12-${year}`,
    };
  }

  const lastDay = new Date(year, month, 0).getDate();
  return {
    fromDate: `1-${month}-${year}`,
    toDate: `${lastDay}-${month}-${year}`,
  };
}

function inferCourtHint(cleaned: string): "SC" | "HC" | "ANY" {
  const q = cleaned.toLowerCase();
  const hasSc = /\bsupreme court\b|\bsc\b/.test(q);
  const hasHc = /\bhigh court\b|\bhc\b/.test(q);
  if (hasSc && !hasHc) return "SC";
  if (hasHc && !hasSc) return "HC";
  return "ANY";
}

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s()/.:-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeToken(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function hasOpenEndedOutcomeQuestion(text: string): boolean {
  return (
    /\b(?:whether|when|can|could|would|if)\b/.test(text) &&
    /\b(?:condon(?:e|ed|ation)|quash(?:ed|ing)?|dismiss(?:ed)?|allow(?:ed)?|grant(?:ed)?|refus(?:e|ed)|reject(?:ed)?|discharge|framing\s+of\s+charge)\b/.test(
      text,
    )
  );
}

function hasExplicitDisposition(text: string): boolean {
  return /\b(?:dismissed|refused|rejected|denied|declined|quashed|allowed|granted|restored|not condoned|time barred|barred by limitation)\b/.test(
    text,
  );
}

function inferOutcomePolarity(input: {
  cleanedQuery: string;
  issues: string[];
}): RetrievalIntentProfile["outcomePolarity"] {
  const bag = normalizeToken(`${input.cleanedQuery} ${input.issues.join(" ")}`);
  if (
    /\b(?:cannot|can not|not)\s+(?:continue|proceed|launch|take cognizance)[a-z\s]{0,40}\bwithout\s+sanction\b/.test(
      bag,
    ) ||
    /\bunless\s+(?:prior|previous)?\s*sanction\b/.test(bag)
  ) {
    return "required";
  }
  const sanctionNotRequired = /\b(?:sanction\s+not\s+required|not\s+required|no\s+sanction\s+required|sanction\s+unnecessary|without\s+(?:prior|previous\s+)?sanction)\b/.test(
    bag,
  );
  if (sanctionNotRequired) return "not_required";
  if (/\b(?:sanction\s+required|prior\s+sanction|previous\s+sanction|mandatory\s+sanction)\b/.test(bag)) {
    return "required";
  }
  const openEndedQuestion = hasOpenEndedOutcomeQuestion(bag);
  const explicitDisposition = hasExplicitDisposition(bag);
  if (!openEndedQuestion || explicitDisposition) {
    if (/\bdismissed|time barred|barred by limitation\b/.test(bag)) return "dismissed";
    if (/\bquash|quashed\b/.test(bag)) return "quashed";
    if (/\brefused|rejected|denied|declined|not condoned\b/.test(bag)) return "refused";
    if (/\ballowed|granted|condoned\b/.test(bag)) return "allowed";
  }
  return "unknown";
}

function buildHookGroups(input: {
  statutes: string[];
  sections: string[];
  contextStatutes: string[];
}): RetrievalIntentProfile["hookGroups"] {
  const bag = unique([...input.statutes, ...input.sections, ...input.contextStatutes]).slice(0, 28);
  const groups = new Map<string, { groupId: string; terms: string[]; required: boolean }>();

  const groupIdFor = (term: string): string => {
    if (/\bsection\s*197\b|\b197\s*crpc\b/.test(term)) return "sec_197_crpc";
    if (/\bsection\s*19\b/.test(term) && /\bpc act|prevention of corruption/.test(term)) return "sec_19_pc_act";
    if (/\bsection\s*482\b/.test(term)) return "sec_482_crpc";
    if (/\bsection\s*5\b/.test(term) && /\blimitation/.test(term)) return "sec_5_limitation";
    if (/\bpc act|prevention of corruption/.test(term)) return "pc_act";
    if (/\bcrpc\b|\bcode of criminal procedure\b|\bbnss\b|\bbharatiya nagarik suraksha sanhita\b/.test(term)) {
      return "crpc";
    }
    if (/\bipc\b/.test(term)) return "ipc";
    if (/\blimitation act\b/.test(term)) return "limitation_act";
    const section = term.match(/\bsection\s*([0-9]+(?:\([0-9a-z]+\))*(?:\([a-z]\))?)/i)?.[1];
    if (section) return `sec_${section.replace(/[^0-9a-z]+/gi, "_")}`;
    return `hook_${term.split(/\s+/).slice(0, 3).join("_")}`;
  };

  for (const term of bag) {
    const groupId = groupIdFor(term);
    const existing = groups.get(groupId);
    if (!existing) {
      groups.set(groupId, {
        groupId,
        terms: [term],
        required: true,
      });
      continue;
    }
    if (!existing.terms.includes(term)) existing.terms.push(term);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      terms: group.terms.slice(0, 8),
    }))
    .slice(0, 8);
}

function extractJudgeHints(query: string): string[] {
  const values = Array.from(
    query.matchAll(
      /\b(?:justice|hon'?ble justice|judge)\s+([a-z][a-z.\s]{2,48})\b/gi,
    ),
  ).map((match) => normalizeToken(match[0]));
  return unique(values).slice(0, 8);
}

function buildRetrievalIntent(input: {
  cleanedQuery: string;
  context: ReturnType<typeof buildContextProfile>;
  entities: EnrichedEntities;
  dateWindow: IntentProfile["dateWindow"];
}): RetrievalIntentProfile {
  return {
    actors: unique([...input.context.actors, ...input.entities.person, ...input.entities.org]).slice(0, 12),
    proceeding: unique(input.context.procedures).slice(0, 10),
    hookGroups: buildHookGroups({
      statutes: input.entities.statute,
      sections: input.entities.section,
      contextStatutes: input.context.statutesOrSections,
    }),
    outcomePolarity: inferOutcomePolarity({
      cleanedQuery: input.cleanedQuery,
      issues: input.context.issues,
    }),
    citationHints: unique(input.entities.case_citation).slice(0, 12),
    judgeHints: extractJudgeHints(input.cleanedQuery),
    dateWindow: input.dateWindow,
    doctypeProfile: "judgments_sc_hc_tribunal",
  };
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

type EntityEnricher = (input: { query: string; context: ReturnType<typeof buildContextProfile> }) => EnrichedEntities;

const ENTITY_ENRICHERS: EntityEnricher[] = [enrichEntities];

export function registerEntityEnricher(enricher: EntityEnricher): void {
  ENTITY_ENRICHERS.push(enricher);
}

function mergeEntities(entities: EnrichedEntities[]): EnrichedEntities {
  const unique = (values: string[]): string[] => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return {
    person: unique(entities.flatMap((item) => item.person)).slice(0, 24),
    org: unique(entities.flatMap((item) => item.org)).slice(0, 24),
    statute: unique(entities.flatMap((item) => item.statute)).slice(0, 32),
    section: unique(entities.flatMap((item) => item.section)).slice(0, 32),
    case_citation: unique(entities.flatMap((item) => item.case_citation)).slice(0, 24),
  };
}

export function buildIntentProfile(query: string): IntentProfile {
  const cleanedQuery = sanitizeNlqForSearch(query);
  const context = buildContextProfile(cleanedQuery);
  const dateWindow = extractDateWindow(cleanedQuery);
  const entityEnrichmentEnabled = parseBooleanEnv(process.env.ENTITY_ENRICHMENT_V1, true);
  const entities = entityEnrichmentEnabled
    ? mergeEntities(ENTITY_ENRICHERS.map((enricher) => enricher({ query, context })))
    : {
        person: [],
        org: [],
        statute: [],
        section: [],
        case_citation: [],
      };
  return {
    query,
    cleanedQuery,
    context,
    domains: context.domains,
    issues: context.issues,
    statutes: context.statutesOrSections,
    procedures: context.procedures,
    actors: context.actors,
    anchors: context.anchors,
    courtHint: inferCourtHint(cleanedQuery),
    dateWindow,
    retrievalIntent: buildRetrievalIntent({
      cleanedQuery,
      context,
      entities,
      dateWindow,
    }),
    entities,
  };
}
