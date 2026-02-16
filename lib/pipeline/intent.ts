import { buildContextProfile } from "@/lib/context";
import { sanitizeNlqForSearch } from "@/lib/nlq";
import { enrichEntities, EnrichedEntities } from "@/lib/pipeline/entity-enrichment";
import { IntentProfile } from "@/lib/pipeline/types";

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
    dateWindow: extractDateWindow(cleanedQuery),
    entities,
  };
}
