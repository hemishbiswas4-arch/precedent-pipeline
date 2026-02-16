import { NormalizedIkDocument } from "@/lib/ingestion/normalize";

export type LegalChunk = {
  docId: string;
  chunkId: string;
  court: NormalizedIkDocument["court"];
  decisionDate?: string;
  citations: string[];
  statuteTokens: string[];
  text: string;
  sourceVersion: string;
};

const DEFAULT_MIN_CHUNK_CHARS = 450;
const DEFAULT_MAX_CHUNK_CHARS = 1400;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitByLegalBoundaries(text: string): string[] {
  const compact = normalizeText(text);
  if (!compact) return [];

  const sentenceBoundary = compact
    .replace(/\b(?:Para|Paragraph|Section|Held|Issue|Facts)\b/gi, "\n$&")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => normalizeText(part))
    .filter((part) => part.length > 0);

  if (sentenceBoundary.length === 0) return [compact];
  return sentenceBoundary;
}

function buildChunkId(docId: string, index: number): string {
  return `${docId}#c${String(index + 1).padStart(4, "0")}`;
}

function mergeCitationSafe(parts: string[], minChars: number, maxChars: number): string[] {
  const out: string[] = [];
  let current = "";

  const flushCurrent = (): void => {
    const value = normalizeText(current);
    if (value) out.push(value);
    current = "";
  };

  for (const part of parts) {
    const sectionLike = /\bsection\s*\d+[a-z]?(?:\([0-9a-z]+\))*/i.test(part);
    const citationLike = /\b\d{4}\s+\w+\s+\d+\b|\bAIR\s+\d{4}\b/i.test(part);

    if (!current) {
      current = part;
      continue;
    }

    const candidate = `${current} ${part}`.trim();
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if ((sectionLike || citationLike) && current.length < minChars) {
      current = candidate.slice(0, maxChars);
      flushCurrent();
      const remainder = candidate.slice(maxChars).trim();
      if (remainder) current = remainder;
      continue;
    }

    flushCurrent();
    current = part;
  }

  flushCurrent();
  return out;
}

export function chunkLegalDocument(input: {
  document: NormalizedIkDocument;
  minChunkChars?: number;
  maxChunkChars?: number;
}): LegalChunk[] {
  const minChunkChars = Math.max(220, input.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS);
  const maxChunkChars = Math.max(minChunkChars + 120, input.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS);

  const segments = splitByLegalBoundaries(input.document.text);
  const merged = mergeCitationSafe(segments, minChunkChars, maxChunkChars);

  if (merged.length === 0) {
    return [
      {
        docId: input.document.docId,
        chunkId: buildChunkId(input.document.docId, 0),
        court: input.document.court,
        decisionDate: input.document.decisionDate,
        citations: input.document.citations,
        statuteTokens: input.document.statuteTokens,
        text: input.document.text,
        sourceVersion: input.document.sourceVersion,
      },
    ];
  }

  return merged.map((text, index) => ({
    docId: input.document.docId,
    chunkId: buildChunkId(input.document.docId, index),
    court: input.document.court,
    decisionDate: input.document.decisionDate,
    citations: input.document.citations,
    statuteTokens: input.document.statuteTokens,
    text,
    sourceVersion: input.document.sourceVersion,
  }));
}

export function chunkLegalDocuments(input: {
  documents: NormalizedIkDocument[];
  minChunkChars?: number;
  maxChunkChars?: number;
}): LegalChunk[] {
  const out: LegalChunk[] = [];
  for (const document of input.documents) {
    out.push(
      ...chunkLegalDocument({
        document,
        minChunkChars: input.minChunkChars,
        maxChunkChars: input.maxChunkChars,
      }),
    );
  }
  return out;
}
