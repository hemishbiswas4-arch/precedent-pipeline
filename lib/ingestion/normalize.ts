import { CourtLevel } from "@/lib/types";

export type IkRawDocument = {
  id?: string | number;
  tid?: string | number;
  docId?: string | number;
  documentId?: string | number;
  title?: string;
  headline?: string;
  docsource?: string;
  court?: string;
  courtName?: string;
  decisionDate?: string;
  date?: string;
  publishdate?: string;
  docsize?: number;
  url?: string;
  permalink?: string;
  citations?: string[];
  equivalentCitations?: string[];
  statutes?: string[];
  sections?: string[];
  text?: string;
  judgmentText?: string;
  snippet?: string;
};

export type NormalizedIkDocument = {
  docId: string;
  title: string;
  court: CourtLevel;
  decisionDate?: string;
  url: string;
  citations: string[];
  statuteTokens: string[];
  text: string;
  sourceVersion: string;
};

function normalizeText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .trim();
}

function normalizeToken(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9()\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function normalizeCourt(value: string | undefined): CourtLevel {
  const normalized = normalizeToken(value ?? "");
  if (!normalized) return "UNKNOWN";
  if (normalized.includes("supreme")) return "SC";
  if (normalized.includes("high")) return "HC";
  return "UNKNOWN";
}

function normalizeDocId(input: IkRawDocument): string {
  const docId = input.docId ?? input.documentId ?? input.id ?? input.tid;
  if (docId !== undefined && docId !== null) {
    const normalized = String(docId).trim();
    if (normalized) return normalized;
  }

  const url = input.url ?? input.permalink ?? "";
  const fromUrl = url.match(/\/(?:doc|docfragment)\/(\d+)\/?/i)?.[1];
  if (fromUrl) return fromUrl;

  const title = normalizeToken(input.title ?? input.headline ?? "untitled");
  return `synthetic_${title.replace(/\s+/g, "_").slice(0, 40) || "doc"}`;
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString().slice(0, 10);

  const ddMmYyyy = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (ddMmYyyy) {
    const day = Number(ddMmYyyy[1]);
    const month = Number(ddMmYyyy[2]);
    const year = Number(ddMmYyyy[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return undefined;
}

function extractStatuteTokens(input: IkRawDocument): string[] {
  const bag: string[] = [];
  bag.push(...(input.statutes ?? []));
  bag.push(...(input.sections ?? []));
  bag.push(...(input.citations ?? []));
  bag.push(...(input.equivalentCitations ?? []));

  const text = `${input.title ?? ""} ${input.snippet ?? ""}`.toLowerCase();
  const sections = Array.from(text.matchAll(/\bsection\s*\d+[a-z]?(?:\([0-9a-z]+\))*/gi)).map((m) => m[0]);
  bag.push(...sections);

  if (text.includes("crpc")) bag.push("crpc");
  if (text.includes("ipc")) bag.push("ipc");
  if (text.includes("limitation act")) bag.push("limitation act");
  if (text.includes("prevention of corruption act") || text.includes("pc act")) {
    bag.push("prevention of corruption act");
    bag.push("pc act");
  }

  return unique(
    bag
      .map((item) => normalizeToken(item))
      .filter((item) => item.length >= 2),
  ).slice(0, 64);
}

export function normalizeIkDocument(input: IkRawDocument, sourceVersion = "ik_api_v1"): NormalizedIkDocument {
  const docId = normalizeDocId(input);
  const title = normalizeText(input.title ?? input.headline ?? "Untitled case");
  const urlCandidate = normalizeText(input.url ?? input.permalink ?? "");
  const url = urlCandidate || `https://indiankanoon.org/doc/${docId}/`;
  const text = normalizeText(input.text ?? input.judgmentText ?? input.snippet ?? title);

  return {
    docId,
    title: title || "Untitled case",
    court: normalizeCourt(input.court ?? input.courtName ?? input.docsource),
    decisionDate: normalizeDate(input.decisionDate ?? input.date ?? input.publishdate),
    url,
    citations: unique([...(input.citations ?? []), ...(input.equivalentCitations ?? [])]).slice(0, 24),
    statuteTokens: extractStatuteTokens(input),
    text,
    sourceVersion,
  };
}

export function normalizeIkDocuments(inputs: IkRawDocument[], sourceVersion = "ik_api_v1"): NormalizedIkDocument[] {
  const docs = inputs.map((item) => normalizeIkDocument(item, sourceVersion));
  const seen = new Set<string>();
  const out: NormalizedIkDocument[] = [];
  for (const doc of docs) {
    const dedupeKey = `${doc.docId}|${doc.url}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(doc);
  }
  return out;
}
