import { ContextProfile } from "@/lib/types";

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
  "kindly",
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

const DOMAIN_MAP: Array<{ domain: string; terms: string[] }> = [
  { domain: "criminal", terms: ["criminal", "crpc", "ipc", "prosecution", "acquittal", "conviction", "fir"] },
  { domain: "civil", terms: ["civil", "cpc", "decree", "contract", "plaintiff", "defendant"] },
  { domain: "tax", terms: ["tax", "gst", "assessment", "adjudication", "customs", "excise"] },
  { domain: "appellate", terms: ["appeal", "appellate", "limitation", "condonation"] },
  { domain: "anti-corruption", terms: ["corruption", "disproportionate assets", "public servant", "pc act"] },
  { domain: "corporate", terms: ["company", "director", "corporate"] },
];

const ACTOR_TERMS: Array<{ label: string; terms: string[] }> = [
  { label: "state", terms: ["state", "state of", "government", "union of india"] },
  { label: "prosecution", terms: ["prosecution"] },
  { label: "department", terms: ["department", "authority"] },
  { label: "director", terms: ["director"] },
  { label: "company", terms: ["company", "corporation"] },
  { label: "accused", terms: ["accused"] },
  { label: "complainant", terms: ["complainant"] },
  { label: "public servant", terms: ["public servant", "officer"] },
  { label: "appellant", terms: ["appellant", "appellants"] },
  { label: "respondent", terms: ["respondent", "respondents"] },
];

const PROCEDURE_TERMS: Array<{ label: string; terms: string[] }> = [
  { label: "appeal", terms: ["appeal", "appellate"] },
  { label: "criminal appeal", terms: ["criminal appeal", "appeal against acquittal", "section 378 crpc"] },
  { label: "appeal against acquittal", terms: ["appeal against acquittal", "leave to appeal", "section 378"] },
  { label: "delay condonation application", terms: ["condonation", "delay condonation", "section 5 limitation"] },
  { label: "revision", terms: ["revision"] },
  { label: "writ petition", terms: ["writ petition", "article 226", "article 32"] },
  { label: "section 482 crpc", terms: ["section 482 crpc", "quashing"] },
  { label: "investigation", terms: ["investigation", "enquiry", "inquiry"] },
  { label: "trial", terms: ["trial"] },
  { label: "sanction for prosecution", terms: ["sanction for prosecution", "previous sanction", "prior sanction"] },
];

const ISSUE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "delay condonation refused",
    pattern: /\bdelay\s+(?:has|was|is|had)?\s*not\s+(?:been\s+)?condon(?:ed|able)\b/gi,
  },
  {
    label: "delay condonation refused",
    pattern: /\bcondonation\s+of\s+delay\s+(?:was\s+|is\s+|has\s+been\s+)?(?:refused|rejected|denied|dismissed|declined)\b/gi,
  },
  {
    label: "delay condonation refused",
    pattern: /\bcondonation(?:\s+of\s+delay)?\s+not\s+granted\b/gi,
  },
  {
    label: "delay condonation refused",
    pattern:
      /\b(?:delay\s+condonation|condonation(?:\s+of\s+delay)?|application\s+for\s+condonation)\b[\s\S]{0,80}\b(?:refused|rejected|dismissed|declined|denied)\b/gi,
  },
  {
    label: "appeal dismissed as time barred",
    pattern: /\bappeal\s+(?:was\s+)?(?:dismissed|rejected)\s+(?:as\s+)?time[-\s]*barred\b/gi,
  },
  { label: "barred by limitation", pattern: /\bbarred\s+by\s+limitation\b/gi },
  { label: "quashing of proceedings", pattern: /\bproceedings?\s+(?:were\s+)?quashed\b/gi },
  {
    label: "sanction required",
    pattern: /\b(?:sanction\s+(?:is\s+)?required|sanction\s+must\s+be\s+required|prior\s+sanction)\b/gi,
  },
  {
    label: "sanction not required",
    pattern: /\b(?:sanction\s+not\s+required|without\s+sanction|no\s+sanction\s+required)\b/gi,
  },
  {
    label: "delay condoned",
    pattern: /\bdelay\s+(?:has|was|is|had)?\s*(?:been\s+)?condoned\b/gi,
  },
  {
    label: "condonation granted",
    pattern: /\bcondonation(?:\s+of\s+delay)?\s+(?:was\s+|is\s+|has\s+been\s+)?granted\b/gi,
  },
  {
    label: "appeal restored",
    pattern: /\bappeal\s+(?:was\s+|is\s+|has\s+been\s+)?restored\b/gi,
  },
  { label: "appeal allowed", pattern: /\bappeal\s+(?:was\s+)?allowed\b/gi },
];

function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(input: string): string[] {
  return normalize(input)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function extractSectionsAndStatutes(query: string): string[] {
  const q = normalize(query);
  const sections = Array.from(
    q.matchAll(
      /\b(?:section|sec\.?|s\.)\s*\d+[a-z]?(?:\([0-9a-z]+\))*(?:\s*(?:ipc|crpc|cpc|pc act|limitation act))?/gi,
    ),
  ).map((match) => match[0].replace(/\s+/g, " ").trim());
  // Match subsection tokens like 13(1)(e) even though they end with ')', which breaks \b boundaries.
  const bareSections = Array.from(
    q.matchAll(
      /(?:^|[^a-z0-9])(\d+(?:\([0-9a-z]+\))+(?:\s*(?:ipc|crpc|cpc|pc act|prevention of corruption act|limitation act))?)(?=$|[^a-z0-9])/gi,
    ),
  ).map((match) => {
    const token = (match[1] ?? "").replace(/\s+/g, " ").trim();
    return token.startsWith("section") ? token : `section ${token}`;
  });

  const acts: string[] = [];
  if (/\bipc\b/.test(q)) acts.push("ipc");
  if (/\bcrpc\b/.test(q)) acts.push("crpc");
  if (/\bcpc\b/.test(q)) acts.push("cpc");
  if (/\blimitation act\b/.test(q)) acts.push("limitation act");
  if (/\bprevention of corruption act\b|\bpc act\b/.test(q)) acts.push("prevention of corruption act");
  if (/\bgst\b/.test(q)) acts.push("gst");

  return unique([...sections, ...bareSections, ...acts]).slice(0, 20);
}

function extractDomains(query: string): string[] {
  const q = normalize(query);
  return DOMAIN_MAP.filter((item) => item.terms.some((term) => q.includes(term))).map((item) => item.domain);
}

function extractActors(query: string): string[] {
  const q = normalize(query);
  return ACTOR_TERMS.filter((item) => item.terms.some((term) => q.includes(term))).map((item) => item.label);
}

function extractProcedures(query: string): string[] {
  const q = normalize(query);
  return PROCEDURE_TERMS.filter((item) => item.terms.some((term) => q.includes(term))).map((item) => item.label);
}

function extractIssues(query: string): string[] {
  const q = normalize(query);
  const issues: string[] = [];
  const hasSectionSpecific = /\bsection\s*\d+|\b\d+\([0-9a-z]+\)(?:\([a-z]\))?/i.test(q);

  for (const item of ISSUE_PATTERNS) {
    const matches = q.match(item.pattern);
    if (matches) {
      issues.push(item.label);
    }
  }

  const hasSection197 = /\bsection\s*197\b|\b197\s*crpc\b|\bcrpc\b/.test(q);
  const hasPcAct =
    /\bprevention of corruption act\b|\bpc act\b|\bsection\s*13(?:\(\d+\))?(?:\([a-z]\))?/i.test(q);
  if (hasSection197 && hasPcAct) {
    issues.push("section interaction between section 197 crpc and pc act");
  }

  if (/\bsanction\b/.test(q) && !hasSectionSpecific && !issues.some((issue) => issue.startsWith("sanction"))) {
    issues.push("sanction issue");
  }
  if (/\binterplay|interaction|read with|vis[-\s]?a[-\s]?vis|requires under\b/.test(q) && hasSection197 && hasPcAct) {
    issues.push("statutory interaction required");
  }

  return unique(issues).slice(0, 16);
}

function extractAnchors(input: {
  query: string;
  statutesOrSections: string[];
  procedures: string[];
  actors: string[];
  issues: string[];
}): string[] {
  const queryTokens = tokenize(input.query);
  const phraseAnchors = [
    ...input.statutesOrSections,
    ...input.procedures,
    ...input.actors,
    ...input.issues,
  ];
  return unique([...phraseAnchors, ...queryTokens]).slice(0, 28);
}

export function buildContextProfile(query: string): ContextProfile {
  const domains = extractDomains(query);
  const statutesOrSections = extractSectionsAndStatutes(query);
  const procedures = extractProcedures(query);
  const actors = extractActors(query);
  const issues = extractIssues(query);
  const anchors = extractAnchors({
    query,
    statutesOrSections,
    procedures,
    actors,
    issues,
  });

  return {
    domains: unique(domains),
    issues: unique(issues),
    statutesOrSections: unique(statutesOrSections),
    procedures: unique(procedures),
    actors: unique(actors),
    anchors,
  };
}
