import { ContextProfile } from "@/lib/types";
import { parseLegalReferences } from "@/lib/kb/legal-reference-parser";

export type EnrichedEntities = {
  person: string[];
  org: string[];
  statute: string[];
  section: string[];
  case_citation: string[];
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s()./-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractSections(query: string): string[] {
  return parseLegalReferences(query).sections.slice(0, 24);
}

function extractStatutes(query: string, context: ContextProfile): string[] {
  const refs = parseLegalReferences(query);
  const acts = Array.from(query.matchAll(/\b([a-z][a-z\s]{2,40}? act)\b/gi)).map((match) => match[1]);
  const abbreviations: string[] = [];
  if (/\bcrpc\b/i.test(query)) abbreviations.push("crpc");
  if (/\bipc\b/i.test(query)) abbreviations.push("ipc");
  if (/\bcpc\b/i.test(query)) abbreviations.push("cpc");
  if (/\bpc act\b|prevention of corruption act/i.test(query)) {
    abbreviations.push("pc act", "prevention of corruption act");
  }
  if (/\blimitation act\b/i.test(query)) abbreviations.push("limitation act");

  return unique([...acts, ...abbreviations, ...refs.statutes, ...refs.transitionAliases, ...context.statutesOrSections]).slice(
    0,
    24,
  );
}

function extractOrganizations(query: string): string[] {
  const patterns = [
    /\bstate of [a-z\s]{2,30}\b/gi,
    /\bunion of india\b/gi,
    /\b[a-z][a-z\s]{2,24} department\b/gi,
    /\b[a-z][a-z\s]{2,24} authority\b/gi,
    /\b[a-z][a-z\s]{2,24}(?: ltd\.?| limited| corporation| company)\b/gi,
  ];

  const values: string[] = [];
  for (const pattern of patterns) {
    values.push(...Array.from(query.matchAll(pattern)).map((match) => match[0]));
  }
  return unique(values).slice(0, 20);
}

function extractPersons(query: string): string[] {
  const values = Array.from(
    query.matchAll(/\b(?:mr\.?|ms\.?|mrs\.?|dr\.?)\s+[a-z][a-z\s]{2,30}\b/gi),
  ).map((match) => match[0]);

  const versusNames = Array.from(
    query.matchAll(/\b([a-z][a-z\s]{2,30})\s+v(?:s\.?|\.)\s+([a-z][a-z\s]{2,30})\b/gi),
  );
  for (const match of versusNames) {
    values.push(match[1], match[2]);
  }

  return unique(values).slice(0, 16);
}

function extractCaseCitations(query: string): string[] {
  const values: string[] = [];

  values.push(...Array.from(query.matchAll(/\bAIR\s+\d{4}\s+[A-Z]{2,10}\s+\d+\b/gi)).map((match) => match[0]));
  values.push(...Array.from(query.matchAll(/\b\d{4}\s+\d+\s+[A-Z]{2,12}\s+\d+\b/gi)).map((match) => match[0]));
  values.push(...Array.from(query.matchAll(/\(\d{4}\)\s*\d+\s*[A-Z]{2,12}\s*\d+/gi)).map((match) => match[0]));

  return unique(values).slice(0, 20);
}

export function enrichEntities(input: {
  query: string;
  context: ContextProfile;
}): EnrichedEntities {
  const query = input.query;

  return {
    person: extractPersons(query),
    org: extractOrganizations(query),
    statute: extractStatutes(query, input.context),
    section: extractSections(query),
    case_citation: extractCaseCitations(query),
  };
}
