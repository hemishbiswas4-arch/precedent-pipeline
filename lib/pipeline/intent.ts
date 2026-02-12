import { buildContextProfile } from "@/lib/context";
import { sanitizeNlqForSearch } from "@/lib/nlq";
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

export function buildIntentProfile(query: string): IntentProfile {
  const cleanedQuery = sanitizeNlqForSearch(query);
  const context = buildContextProfile(cleanedQuery);
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
  };
}
