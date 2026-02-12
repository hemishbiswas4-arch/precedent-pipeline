import { CaseCandidate, CourtLevel } from "@/lib/types";

export type IndianKanoonParserMode =
  | "result_container"
  | "result_title"
  | "h4_anchor"
  | "generic_anchor"
  | "doc_link_harvest";

export type ParsedIndianKanoonSearchPage = {
  rawCases: CaseCandidate[];
  parserMode: IndianKanoonParserMode;
  challenge: boolean;
  noMatch: boolean;
  nextPageUrl: string | null;
  docLinkSignals: number;
  resultSignals: number;
};

export function stripHtmlTags(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parseIntSafe(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/,/g, "").trim();
  const asNumber = Number(normalized);
  return Number.isFinite(asNumber) ? asNumber : undefined;
}

export function normalizeSearchHref(href: string): string | null {
  if (!href) {
    return null;
  }
  try {
    if (href.startsWith("http://") || href.startsWith("https://")) {
      return href;
    }
    if (href.startsWith("//")) {
      return `https:${href}`;
    }
    return new URL(href, "https://indiankanoon.org").toString();
  } catch {
    return null;
  }
}

export function normalizeDocHref(href: string): string | null {
  if (!href) {
    return null;
  }

  const absolute = normalizeSearchHref(href);
  if (!absolute) {
    return null;
  }
  const fragmentMatch = absolute.match(/\/docfragment\/(\d+)\/?/i);
  if (fragmentMatch) {
    return `https://indiankanoon.org/docfragment/${fragmentMatch[1]}/`;
  }
  const docId = absolute.match(/\/doc\/(\d+)\/?/i)?.[1];
  if (!docId) {
    return null;
  }
  return `https://indiankanoon.org/doc/${docId}/`;
}

function inferCourtLevel(text: string): CourtLevel {
  const t = text.toLowerCase();
  if (t.includes("supreme court")) {
    return "SC";
  }
  if (t.includes("high court")) {
    return "HC";
  }
  return "UNKNOWN";
}

export function isLikelyStatute(title: string, snippet: string): boolean {
  const text = `${title} ${snippet}`.toLowerCase();
  return (
    /\bindian penal code\b/.test(text) ||
    /\bpenal code,\s*\d{4}\b/.test(text) ||
    /\bcode of criminal procedure\b/.test(text) ||
    /\bcriminal procedure code\b/.test(text) ||
    /\bsection\s+\d+[a-z]?\b[\s\S]{0,60}\b(?:punishment|whoever|shall be punished)\b/.test(text) ||
    /\bconstitution of india\b/.test(text) ||
    /\bact,\s*\d{4}\b/.test(text) ||
    /\bcode,\s*\d{4}\b/.test(text) ||
    /\brules,\s*\d{4}\b/.test(text) ||
    /\bregulations?\b/.test(text) ||
    /\bmunicipal(?:ity|ities)? act\b/.test(text) ||
    /\bgoods and services tax act\b/.test(text)
  );
}

export function isLikelyCaseLaw(title: string, snippet: string): boolean {
  const titleText = title.toLowerCase();
  const snippetText = snippet.toLowerCase();
  const titleSignals =
    /\b v(?:s\.?|\.?) \b/.test(titleText) ||
    /\bon\s+\d{1,2}\s+[a-z]{3,9}\s+\d{4}\b/.test(titleText) ||
    /\b(?:petitioner|respondent|appellant|appeal|criminal appeal|writ petition|judgment)\b/.test(titleText);
  const snippetSignals =
    /\b v(?:s\.?|\.?) \b/.test(snippetText) ||
    /\b(?:petitioner|respondent|appellant|appeal|criminal appeal|writ petition|judgment)\b/.test(snippetText);
  return titleSignals || (snippetSignals && !isLikelyStatute(title, ""));
}

function extractResultChunks(html: string): Array<{ start: number; chunk: string }> {
  const starts = Array.from(
    html.matchAll(/<div[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>/gim),
  ).map((m) => m.index ?? -1);

  if (starts.length === 0) {
    return [];
  }

  const chunks: Array<{ start: number; chunk: string }> = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = starts[i + 1] ?? html.length;
    chunks.push({ start, chunk: html.slice(start, end) });
  }
  return chunks;
}

function parseResultMetadata(chunk: string): {
  courtText?: string;
  citesCount?: number;
  citedByCount?: number;
  author?: string;
  fullDocumentUrl?: string;
} {
  const citesMatch = chunk.match(/>\s*Cites\s*([0-9,]+)\s*</im);
  const citedByMatch = chunk.match(/>\s*Cited\s*by\s*([0-9,]+)\s*</im);
  const authorMatch = chunk.match(/<a[^>]+href=["'][^"']*\?authors=[^"']*["'][^>]*>([\s\S]*?)<\/a>/im);
  const fullDocumentMatch = chunk.match(
    /<a[^>]+href=["']([^"']*\/(?:doc|docfragment)\/\d+\/?(?:\?[^"']*)?)["'][^>]*>\s*Full\s*Document\s*<\/a>/im,
  );

  let courtText = "";
  const markerIdx = chunk.search(/Cites|Cited\s*by|Full\s*Document/i);
  if (markerIdx >= 0) {
    const leftWindow = chunk.slice(Math.max(0, markerIdx - 300), markerIdx);
    courtText =
      stripHtmlTags(leftWindow)
        .split(/[-–|]/)
        .map((v) => v.trim())
        .filter((v) => v.length > 2)
        .pop() ?? "";
  }

  return {
    courtText: courtText || undefined,
    citesCount: parseIntSafe(citesMatch?.[1]),
    citedByCount: parseIntSafe(citedByMatch?.[1]),
    author: stripHtmlTags(authorMatch?.[1] ?? "") || undefined,
    fullDocumentUrl: normalizeDocHref(fullDocumentMatch?.[1] ?? "") ?? undefined,
  };
}

function scoreDocTitle(title: string): number {
  const normalized = title.trim();
  if (!normalized) return -10;
  const lower = normalized.toLowerCase();
  let score = 0;
  if (isLikelyCaseLaw(normalized, "")) score += 6;
  if (/\b v(?:s\.?|\.?) \b/.test(lower)) score += 5;
  if (/\bon\s+\d{1,2}\s+[a-z]{3,9},?\s+\d{4}\b/.test(lower)) score += 4;
  if (/\b(appeal|petition|petitioner|respondent|judgment)\b/.test(lower)) score += 2;
  if (isLikelyStatute(normalized, "")) score -= 8;
  if (/^section\b/.test(lower)) score -= 5;
  if (normalized.length < 10) score -= 2;
  return score;
}

function parseCandidateFromResultChunk(resultChunk: string): CaseCandidate | null {
  const irrelevantTitle = /^(full document|similar judgments?|search)$/i;
  const h4LinkMatch = resultChunk.match(
    /<h4[^>]*>\s*<a[^>]+href=["']([^"']*\/(?:doc|docfragment)\/\d+\/?(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h4>/im,
  );
  const resultTitleMatch = resultChunk.match(
    /<div[^>]*class=["'][^"']*result_title[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']*\/(?:doc|docfragment)\/\d+\/?(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/im,
  );
  const fallbackLinkMatches = Array.from(
    resultChunk.matchAll(
      /<a[^>]+href=["']([^"']*\/(?:doc|docfragment)\/\d+\/?(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gim,
    ),
  );
  const fallbackLinkMatch = fallbackLinkMatches
    .map((m) => ({ url: normalizeDocHref(m[1]), title: stripHtmlTags(m[2] ?? "") }))
    .filter((item) => Boolean(item.url) && item.title.length > 0 && !irrelevantTitle.test(item.title))
    .sort((a, b) => scoreDocTitle(b.title) - scoreDocTitle(a.title))[0];

  const activeMatch = h4LinkMatch
    ? { url: normalizeDocHref(h4LinkMatch[1]), title: stripHtmlTags(h4LinkMatch[2] ?? "") }
    : resultTitleMatch
      ? { url: normalizeDocHref(resultTitleMatch[1]), title: stripHtmlTags(resultTitleMatch[2] ?? "") }
      : fallbackLinkMatch
        ? { url: fallbackLinkMatch.url, title: fallbackLinkMatch.title }
        : null;

  if (!activeMatch?.url) return null;
  const title = activeMatch.title;
  if (!title || irrelevantTitle.test(title)) return null;

  const snippetMatch =
    resultChunk.match(
      /<div[^>]*class=["'][^"']*(?:result_snippet|snippet|headline|citation)[^"']*["'][^>]*>([\s\S]*?)<\/div>/im,
    ) ?? resultChunk.match(/<p[^>]*>([\s\S]*?)<\/p>/im);
  const snippet = stripHtmlTags(snippetMatch?.[1] ?? "");
  const metadata = parseResultMetadata(resultChunk);
  const court = inferCourtLevel(`${metadata.courtText ?? ""} ${title} ${snippet}`);

  return {
    source: "indiankanoon",
    title,
    url: activeMatch.url,
    snippet,
    court,
    courtText: metadata.courtText,
    citesCount: metadata.citesCount,
    citedByCount: metadata.citedByCount,
    author: metadata.author,
    fullDocumentUrl: metadata.fullDocumentUrl ?? activeMatch.url,
  };
}

export function harvestIndianKanoonDocLinks(html: string): CaseCandidate[] {
  const parsed: CaseCandidate[] = [];
  const seen = new Set<string>();
  const anchorPattern =
    /<a[^>]+href=["']([^"']*\/(?:doc|docfragment)\/\d+\/?(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gim;
  let match: RegExpExecArray | null = anchorPattern.exec(html);

  while (match) {
    const url = normalizeDocHref(match[1] ?? "");
    const title = stripHtmlTags(match[2] ?? "");
    const chunk = html.slice(Math.max(0, match.index - 500), match.index + 4200);
    const snippet = stripHtmlTags(
      chunk.match(
        /<div[^>]*class=["'][^"']*(?:result_snippet|snippet|headline|citation)[^"']*["'][^>]*>([\s\S]*?)<\/div>/im,
      )?.[1] ?? "",
    );

    if (!url || seen.has(url)) {
      match = anchorPattern.exec(html);
      continue;
    }
    if (/^(full document|similar judgments?|search)$/i.test(title)) {
      match = anchorPattern.exec(html);
      continue;
    }
    if (title.length < 3 && snippet.length < 30) {
      match = anchorPattern.exec(html);
      continue;
    }

    parsed.push({
      source: "indiankanoon",
      title: title.length > 0 ? title : "Untitled case link",
      url,
      snippet,
      court: inferCourtLevel(`${title} ${snippet}`),
      fullDocumentUrl: url,
    });
    seen.add(url);
    match = anchorPattern.exec(html);
  }

  return parsed;
}

export function detectIndianKanoonChallenge(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("attention required") ||
    lower.includes("just a moment") ||
    lower.includes("cf-chl") ||
    lower.includes("cloudflare")
  );
}

export function hasIndianKanoonNoMatch(html: string): boolean {
  return /no matching results/i.test(stripHtmlTags(html));
}

export function parseIndianKanoonNextPageUrl(html: string): string | null {
  const relNext =
    html.match(/<a[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i) ??
    html.match(/<a[^>]+href=["']([^"']+)["'][^>]+rel=["']next["']/i);
  if (relNext) {
    return normalizeSearchHref(relNext[1]);
  }
  const textNext = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*>\s*Next\s*<\/a>/i);
  if (textNext) {
    return normalizeSearchHref(textNext[1]);
  }
  return null;
}

export function parseIndianKanoonSearchPage(html: string): ParsedIndianKanoonSearchPage {
  const noMatch = hasIndianKanoonNoMatch(html);
  const challenge = detectIndianKanoonChallenge(html);
  const nextPageUrl = parseIndianKanoonNextPageUrl(html);
  const docLinkSignals = (html.match(/\/(?:doc|docfragment)\/\d+/gi) ?? []).length;
  const resultSignals =
    (html.match(/result_title|result_snippet|class=["'][^"']*result[^"']*["']/gi) ?? []).length;

  if (noMatch) {
    return {
      rawCases: [],
      parserMode: "generic_anchor",
      challenge,
      noMatch,
      nextPageUrl,
      docLinkSignals,
      resultSignals,
    };
  }

  const parsed: CaseCandidate[] = [];
  const seen = new Set<string>();
  const irrelevantTitle = /^(full document|similar judgments?|search)$/i;

  const chunks = extractResultChunks(html);
  if (chunks.length > 0) {
    for (const { chunk } of chunks) {
      const candidate = parseCandidateFromResultChunk(chunk);
      if (candidate && !seen.has(candidate.url) && !irrelevantTitle.test(candidate.title)) {
        parsed.push(candidate);
        seen.add(candidate.url);
      }
    }
  }
  if (parsed.length > 0) {
    return {
      rawCases: parsed,
      parserMode: "result_container",
      challenge,
      noMatch,
      nextPageUrl,
      docLinkSignals,
      resultSignals,
    };
  }

  const titleAnchorPattern =
    /<div[^>]*class=["'][^"']*result_title[^"']*["'][^>]*>[\s\S]{0,700}?<a[^>]+href=["']([^"']*\/(?:doc|docfragment)\/\d+\/?(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gim;
  let titleMatch: RegExpExecArray | null = titleAnchorPattern.exec(html);
  while (titleMatch) {
    const chunk = html.slice(titleMatch.index, titleMatch.index + 5200);
    const candidate = parseCandidateFromResultChunk(chunk);
    if (candidate && !seen.has(candidate.url) && !irrelevantTitle.test(candidate.title)) {
      parsed.push(candidate);
      seen.add(candidate.url);
    }
    titleMatch = titleAnchorPattern.exec(html);
  }
  if (parsed.length > 0) {
    return {
      rawCases: parsed,
      parserMode: "result_title",
      challenge,
      noMatch,
      nextPageUrl,
      docLinkSignals,
      resultSignals,
    };
  }

  const h4Pattern =
    /<h4[^>]*>\s*<a[^>]+href=["']([^"']*\/(?:doc|docfragment)\/\d+\/?(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h4>/gim;
  let h4Match: RegExpExecArray | null = h4Pattern.exec(html);
  while (h4Match) {
    const chunk = html.slice(h4Match.index, h4Match.index + 4600);
    const candidate = parseCandidateFromResultChunk(chunk);
    if (candidate && !seen.has(candidate.url) && !irrelevantTitle.test(candidate.title)) {
      parsed.push(candidate);
      seen.add(candidate.url);
    }
    h4Match = h4Pattern.exec(html);
  }
  if (parsed.length > 0) {
    return {
      rawCases: parsed,
      parserMode: "h4_anchor",
      challenge,
      noMatch,
      nextPageUrl,
      docLinkSignals,
      resultSignals,
    };
  }

  const anchorPattern =
    /<a[^>]+href=["']([^"']*\/(?:doc|docfragment)\/\d+\/?(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gim;
  let anchorMatch: RegExpExecArray | null = anchorPattern.exec(html);
  while (anchorMatch) {
    const chunk = html.slice(anchorMatch.index, anchorMatch.index + 4200);
    const chunkText = stripHtmlTags(chunk).toLowerCase();
    const searchResultContext =
      /\b(cites|cited by|full document|petitioner|respondent|appellant|judgment|appeal)\b/.test(chunkText) ||
      /result[_\s-]?title|result[_\s-]?snippet|class=["'][^"']*result/i.test(chunk);
    if (!searchResultContext) {
      anchorMatch = anchorPattern.exec(html);
      continue;
    }
    const candidate = parseCandidateFromResultChunk(chunk);
    if (candidate && isLikelyCaseLaw(candidate.title, candidate.snippet) && !seen.has(candidate.url)) {
      parsed.push(candidate);
      seen.add(candidate.url);
    }
    anchorMatch = anchorPattern.exec(html);
  }
  if (parsed.length > 0) {
    return {
      rawCases: parsed,
      parserMode: "generic_anchor",
      challenge,
      noMatch,
      nextPageUrl,
      docLinkSignals,
      resultSignals,
    };
  }

  const harvested = harvestIndianKanoonDocLinks(html);
  return {
    rawCases: harvested,
    parserMode: harvested.length > 0 ? "doc_link_harvest" : "generic_anchor",
    challenge,
    noMatch,
    nextPageUrl,
    docLinkSignals,
    resultSignals,
  };
}
