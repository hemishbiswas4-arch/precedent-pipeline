import { ContextProfile } from "@/lib/types";
import { parseLegalReferences, ParsedLegalReferences } from "@/lib/kb/legal-reference-parser";

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
  {
    domain: "criminal",
    terms: ["criminal", "crpc", "bnss", "ipc", "prosecution", "acquittal", "conviction", "fir"],
  },
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
  { label: "discharge", terms: ["discharge", "section 227 crpc"] },
  { label: "framing of charge", terms: ["framing of charge", "frame charge", "charge framed", "section 228 crpc"] },
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
    label: "discharge",
    pattern: /\b(?:order\s+of\s+)?discharge\b/gi,
  },
  {
    label: "refused to interfere",
    pattern: /\b(?:refused|declined|not\s+inclined)\s+to\s+interfere\b/gi,
  },
  {
    label: "discharge upheld",
    pattern: /\b(?:upheld|affirmed|confirmed)\s+(?:the\s+)?(?:order\s+of\s+)?discharge\b/gi,
  },
  {
    label: "framing of charge",
    pattern: /\bframing\s+of\s+charge\b|\bcharge\s+(?:was\s+)?framed\b|\bframe\s+charge\b/gi,
  },
  {
    label: "quashing of proceedings",
    pattern: /\b(?:quash|quashing)\s+(?:of\s+)?(?:fir|f\.?i\.?r\.?|proceedings?|complaint)\b/gi,
  },
  {
    label: "civil nature allegations",
    pattern: /\b(?:civil\s+in\s+nature|civil\s+dispute|purely\s+civil)\b/gi,
  },
  {
    label: "road accident",
    pattern: /\b(?:road\s+accident|motor(?:\s+vehicle)?\s+accident)\b/gi,
  },
  {
    label: "rash and negligent driving",
    pattern: /\b(?:rash\s+and\s+negligent\s+driving|rash\s+driving|negligent\s+driving)\b/gi,
  },
  {
    label: "drunken driving",
    pattern: /\b(?:drunk(?:en)?\s+driving|driving\s+under\s+the\s+influence)\b/gi,
  },
  {
    label: "knowledge versus negligence",
    pattern: /\bknowledge\s+(?:versus|vs\.?|v\.?)\s+negligence\b/gi,
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

function extractSectionsAndStatutes(query: string, refs: ParsedLegalReferences): string[] {
  const q = normalize(query);
  const acts: string[] = [];
  if (/\bgst\b/.test(q)) acts.push("gst");
  return unique([...refs.sections, ...refs.statutes, ...refs.transitionAliases, ...acts]).slice(0, 24);
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

function extractIssues(query: string, refs: ParsedLegalReferences): string[] {
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

  if (
    /\b(?:construed as|to be construed as|read as references?|to be read as references?)\b/.test(q) ||
    /\breferences?\s+to\b[\s\S]{0,80}\bread as\b/.test(q)
  ) {
    issues.push("statutory reference substitution");
  }

  if (
    /\b(?:notification|s\.?\s*o\.?|g\.?\s*s\.?\s*r\.?)\b/.test(q) &&
    /\b(?:interpreted|applied|construed|read as)\b/.test(q)
  ) {
    issues.push("notification interpretation");
  }

  const hasCrpcAlias = refs.transitionAliases.some((term) => term.includes("crpc"));
  const hasBnssAlias = refs.transitionAliases.some((term) => term.includes("bnss"));
  if (hasCrpcAlias && hasBnssAlias) {
    issues.push("crpc bnss transition interpretation");
  }

  return unique(issues).slice(0, 16);
}

function extractAnchors(input: {
  query: string;
  statutesOrSections: string[];
  procedures: string[];
  actors: string[];
  issues: string[];
  softTerms: string[];
}): string[] {
  const queryTokens = tokenize(input.query);
  const phraseAnchors = [
    ...input.statutesOrSections,
    ...input.procedures,
    ...input.actors,
    ...input.issues,
    ...input.softTerms,
  ];
  return unique([...phraseAnchors, ...queryTokens]).slice(0, 28);
}

export function buildContextProfile(query: string): ContextProfile {
  const legalRefs = parseLegalReferences(query);
  const domains = extractDomains(query);
  const statutesOrSections = extractSectionsAndStatutes(query, legalRefs);
  const procedures = extractProcedures(query);
  const actors = extractActors(query);
  const issues = extractIssues(query, legalRefs);
  const anchors = extractAnchors({
    query,
    statutesOrSections,
    procedures,
    actors,
    issues,
    softTerms: legalRefs.softHintTerms.slice(0, 8),
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
