const NLQ_NOISE_PATTERNS: RegExp[] = [
  /\bcases?\s+where\b/gi,
  /\bprecedents?\s+where\b/gi,
  /\bjudgments?\s+where\b/gi,
  /\bfind\s+(?:me\s+)?(?:cases?|precedents?|judgments?)\b/gi,
  /\bshow\s+(?:me\s+)?(?:cases?|precedents?|judgments?)\b/gi,
  /\blooking\s+for\s+(?:cases?|precedents?|judgments?)\b/gi,
  /\bis\s+there\s+(?:any|a)\b/gi,
  /\b(?:can|could|would)\s+you\s+(?:find|show|give|list)\b/gi,
  /\b(?:please|kindly)\b/gi,
  /\banything\s+found\b/gi,
];

const SEARCH_NOISE_WORDS = new Set([
  "any",
  "anything",
  "case",
  "cases",
  "where",
  "with",
  "within",
  "into",
  "through",
  "from",
  "in",
  "on",
  "or",
  "find",
  "show",
  "me",
  "looking",
  "for",
  "precedent",
  "precedents",
  "judgment",
  "judgments",
  "please",
  "need",
  "want",
  "give",
  "tell",
  "once",
  "check",
  "period",
  "over",
  "cannot",
  "cant",
  "associated",
  "was",
  "were",
  "had",
  "been",
  "after",
  "before",
  "even",
  "though",
  "order",
  "pending",
  "granted",
  "against",
  "through",
  "whether",
  "should",
  "could",
  "would",
]);

const LEGAL_PHRASE_PATTERNS: RegExp[] = [
  /\bquashing of criminal proceedings\b/gi,
  /\bcriminal prosecution\b/gi,
  /\bcriminal proceedings\b/gi,
  /\bdisproportionate assets?\b/gi,
  /\bcheck period\b/gi,
  /\bmerit[-\s]+based exoneration\b/gi,
  /\bdepartmental adjudication\b/gi,
  /\bcivil and criminal proceedings\b/gi,
  /\bappeal pending\b/gi,
  /\bno stay\b/gi,
  /\bsection 197 crpc sanction\b/gi,
  /\bsection 19 prevention of corruption act\b/gi,
  /\bsanction for prosecution\b/gi,
];

export function sanitizeNlqForSearch(input: string): string {
  let text = input;
  for (const pattern of NLQ_NOISE_PATTERNS) {
    text = text.replace(pattern, " ");
  }
  return text.replace(/\s+/g, " ").trim();
}

function extractLegalPhrases(input: string): string[] {
  const matches: string[] = [];
  for (const pattern of LEGAL_PHRASE_PATTERNS) {
    const found = input.match(pattern);
    if (found) {
      matches.push(...found.map((v) => v.toLowerCase().trim()));
    }
  }
  return [...new Set(matches)];
}

export function extractSearchTerms(input: string, maxTerms: number): string[] {
  const cleaned = sanitizeNlqForSearch(input).toLowerCase();
  const phraseTerms = extractLegalPhrases(cleaned);
  const tokenTerms = cleaned
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !SEARCH_NOISE_WORDS.has(token))
    .slice(0, maxTerms * 2);
  return [...new Set([...phraseTerms, ...tokenTerms])].slice(0, maxTerms);
}
