function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s().,:/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

const MONTH_NAMES =
  "january|february|march|april|may|june|july|august|september|october|november|december";

const CRPC_PATTERNS = [
  /\bcr\.?\s*p\.?\s*c\.?\b/i,
  /\bcrpc\b/i,
  /\bcode\s+of\s+criminal\s+procedure(?:\s*,?\s*1973)?\b/i,
  /\bcriminal\s+procedure\s+code\b/i,
];

const BNSS_PATTERNS = [
  /\bbnss\b/i,
  /\bbharatiya\s+nagarik\s+suraksha\s+sanhita(?:\s*,?\s*2023)?\b/i,
];

const GENERAL_CLAUSES_PATTERNS = [
  /\bgeneral\s+clauses\s+act(?:\s*,?\s*1897)?\b/i,
];

const NOTIFICATION_ID_PATTERN =
  /(?:^|[^a-z0-9])((?:s\.?\s*o\.?|g\.?\s*s\.?\s*r\.?))\s*([0-9]{1,6}\([a-z]\))(?=$|[^a-z0-9])/gi;
const DATE_PATTERN = new RegExp(`\\b([0-3]?\\d)(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\s+(19\\d{2}|20\\d{2})\\b`, "gi");

const SECTION_PATTERN =
  /\b(?:section|sec\.?|s\.)\s*([0-9]+(?:\([0-9a-z]+\))*(?:\([a-z]\))?)/gi;
const BARE_SUBSECTION_PATTERN =
  /(?:^|[^a-z0-9])([0-9]+(?:\([0-9a-z]+\)){1,3}(?:\([a-z]\))?)(?=$|[^a-z0-9])/gi;

const TRANSITION_ALIASES: Array<{ left: RegExp[]; right: string[] }> = [
  {
    left: [...CRPC_PATTERNS, ...BNSS_PATTERNS],
    right: [
      "crpc",
      "code of criminal procedure, 1973",
      "bnss",
      "bharatiya nagarik suraksha sanhita, 2023",
      "code of criminal procedure reference read as bnss reference",
    ],
  },
];

const SECTION_CONTEXT_ACTS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\bprevention\s+of\s+corruption\s+act\b/i, value: "prevention of corruption act" },
  { pattern: /\bpc\s*act\b/i, value: "pc act" },
  { pattern: /\bgeneral\s+clauses\s+act\b/i, value: "general clauses act" },
  { pattern: /\blimitation\s+act\b/i, value: "limitation act" },
  { pattern: /\bcode\s+of\s+criminal\s+procedure\b|\bcrpc\b|\bcr\.?\s*p\.?\s*c\.?\b/i, value: "crpc" },
  { pattern: /\bindian\s+penal\s+code\b|\bipc\b/i, value: "ipc" },
  { pattern: /\bcode\s+of\s+civil\s+procedure\b|\bcpc\b/i, value: "cpc" },
];

function detectActHint(windowText: string): string | null {
  for (const entry of SECTION_CONTEXT_ACTS) {
    if (entry.pattern.test(windowText)) return entry.value;
  }
  return null;
}

function hasNotificationSignals(windowText: string): boolean {
  return /\b(?:s\.?\s*o\.?|g\.?\s*s\.?\s*r\.?|notification|gazette)\b/i.test(windowText);
}

function canonicalStatutes(query: string): string[] {
  const statutes: string[] = [];
  if (CRPC_PATTERNS.some((pattern) => pattern.test(query))) {
    statutes.push("crpc", "code of criminal procedure, 1973");
  }
  if (BNSS_PATTERNS.some((pattern) => pattern.test(query))) {
    statutes.push("bnss", "bharatiya nagarik suraksha sanhita, 2023");
  }
  if (GENERAL_CLAUSES_PATTERNS.some((pattern) => pattern.test(query))) {
    statutes.push("general clauses act, 1897", "general clauses act");
  }

  const genericActs = Array.from(query.matchAll(/\b([a-z][a-z\s]{2,70}?\sact(?:\s*,\s*\d{4})?)\b/gi)).map(
    (match) => match[1],
  );
  statutes.push(...genericActs);
  return unique(statutes).slice(0, 20);
}

function extractNotificationIds(query: string): string[] {
  const ids: string[] = [];
  for (const match of query.matchAll(NOTIFICATION_ID_PATTERN)) {
    const prefixRaw = normalizeText(match[1]).replace(/\s+/g, "");
    const prefix = prefixRaw.startsWith("g") ? "g.s.r." : "s.o.";
    const id = normalizeText(match[2]);
    if (!id) continue;
    ids.push(`${prefix} ${id}`);
  }
  return unique(ids).slice(0, 8);
}

function extractNotificationDates(query: string): string[] {
  const dates: string[] = [];
  for (const match of query.matchAll(DATE_PATTERN)) {
    const day = Number(match[1]);
    const month = normalizeText(match[2]);
    const year = normalizeText(match[3]);
    if (!Number.isFinite(day) || !month || !year) continue;
    dates.push(`${day} ${month} ${year}`);
  }
  return unique(dates).slice(0, 8);
}

function sectionTerm(sectionToken: string, actHint?: string | null): string {
  if (actHint) return `section ${sectionToken} ${actHint}`;
  return `section ${sectionToken}`;
}

function extractSections(query: string): string[] {
  const sections: string[] = [];
  const normalized = normalizeText(query);
  const explicitSectionTokens = new Set<string>();

  for (const match of normalized.matchAll(SECTION_PATTERN)) {
    const sectionToken = normalizeText(match[1]);
    if (!sectionToken) continue;
    explicitSectionTokens.add(sectionToken);
    const idx = match.index ?? 0;
    const window = normalized.slice(Math.max(0, idx - 20), Math.min(normalized.length, idx + 140));
    const actHint = detectActHint(window);
    sections.push(sectionTerm(sectionToken, actHint));
  }

  for (const match of normalized.matchAll(BARE_SUBSECTION_PATTERN)) {
    const token = normalizeText(match[1]);
    if (!token || explicitSectionTokens.has(token)) continue;
    const raw = match[0] ?? "";
    const tokenOffset = raw.indexOf(match[1]);
    const idx = Math.max(0, (match.index ?? 0) + (tokenOffset >= 0 ? tokenOffset : 0));
    const window = normalized.slice(Math.max(0, idx - 50), Math.min(normalized.length, idx + 80));
    if (hasNotificationSignals(window)) continue;
    const actHint = detectActHint(window);
    const hasSectionContext = /\bsection\b/.test(window);
    const hasLegalContext = Boolean(actHint) || hasSectionContext;
    if (!hasLegalContext) continue;
    sections.push(sectionTerm(token, actHint));
  }

  return unique(sections).slice(0, 24);
}

function hasAnyTransitionSignal(bag: string): boolean {
  return TRANSITION_ALIASES.some((entry) => entry.left.some((pattern) => pattern.test(bag)));
}

export function expandMinimalTransitionAliases(terms: string[]): string[] {
  const bag = normalizeText(terms.join(" "));
  const expanded: string[] = [];
  for (const entry of TRANSITION_ALIASES) {
    if (!entry.left.some((pattern) => pattern.test(bag))) continue;
    expanded.push(...entry.right);
  }
  return unique(expanded).slice(0, 12);
}

export type ParsedLegalReferences = {
  sections: string[];
  statutes: string[];
  references: string[];
  notificationIds: string[];
  notificationDates: string[];
  hardIncludeTokens: string[];
  softHintTerms: string[];
  transitionAliases: string[];
};

export function parseLegalReferences(query: string): ParsedLegalReferences {
  const normalizedQuery = normalizeText(query);
  const sections = extractSections(normalizedQuery);
  const statutes = canonicalStatutes(normalizedQuery);
  const transitionAliases = expandMinimalTransitionAliases([...sections, ...statutes, normalizedQuery]);
  const notificationIds = extractNotificationIds(normalizedQuery);
  const notificationDates = extractNotificationDates(normalizedQuery);

  // Precision-safe terms: explicit legal references and statute transitions.
  const hardIncludeTokens = unique([
    ...sections,
    ...statutes,
    ...transitionAliases,
    ...notificationIds,
  ]).slice(0, 18);

  const softHintTerms = unique([
    ...transitionAliases,
    ...statutes,
    ...sections,
    ...notificationIds,
    ...notificationDates,
    hasAnyTransitionSignal(normalizedQuery) ? "statutory reference substitution" : "",
  ]).slice(0, 26);

  const references = unique([...sections, ...statutes, ...notificationIds]).slice(0, 28);

  return {
    sections,
    statutes,
    references,
    notificationIds,
    notificationDates,
    hardIncludeTokens,
    softHintTerms,
    transitionAliases,
  };
}

function hasLegalNeedle(text: string, refs: ParsedLegalReferences): boolean {
  const normalized = normalizeText(text);
  const needles = unique([
    ...refs.sections,
    ...refs.statutes,
    ...refs.transitionAliases,
    ...refs.notificationIds,
  ]);
  return needles.some((needle) => normalized.includes(needle));
}

export function isLikelyLegalDisjunction(query: string, refs: ParsedLegalReferences): boolean {
  const normalized = normalizeText(query);
  if (!/\b(?:or|either|alternatively|versus|vs\.?|instead\s+of)\b/.test(normalized)) {
    return false;
  }

  if (
    /\b(?:appeal|revision|petition|application|charge)\s+or\s+(?:appeal|revision|petition|application|charge)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/\bsection\s*\d+[a-z]?(?:\([0-9a-z]+\))*(?:\([a-z]\))?\s+or\s+section\s*\d+/i.test(normalized)) {
    return true;
  }

  const genericFalsePositivePatterns = [
    /\blaws?\s+or\s+proceedings?\b/,
    /\binterpreted\s+or\s+applied\b/,
    /\bapplied\s+or\s+interpreted\b/,
    /\brules?\s+or\s+regulations?\b/,
    /\bacts?\s+or\s+rules?\b/,
  ];

  if (genericFalsePositivePatterns.some((pattern) => pattern.test(normalized))) {
    const hasClearEither = /\beither\b/.test(normalized);
    if (!hasClearEither) {
      return false;
    }
  }

  const connectorPattern = /\b(?:or|versus|vs\.?|instead\s+of|alternatively)\b/g;
  for (const match of normalized.matchAll(connectorPattern)) {
    const idx = match.index ?? 0;
    const left = normalized.slice(Math.max(0, idx - 80), idx);
    const right = normalized.slice(idx + match[0].length, Math.min(normalized.length, idx + 80));
    if (genericFalsePositivePatterns.some((pattern) => pattern.test(`${left} ${right}`))) {
      continue;
    }
    if (hasLegalNeedle(left, refs) && hasLegalNeedle(right, refs)) {
      return true;
    }
  }

  return /\beither\b/.test(normalized) && hasLegalNeedle(normalized, refs);
}
