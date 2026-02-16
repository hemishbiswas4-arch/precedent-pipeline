import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { getBedrockClient, getBedrockModelConfig } from "@/lib/bedrock-client";

const LOCAL_DIM = 192;

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function unitNormalize(values: number[]): number[] {
  let norm = 0;
  for (const value of values) {
    norm += value * value;
  }
  if (norm <= 0) return values;
  const inv = 1 / Math.sqrt(norm);
  return values.map((value) => Number((value * inv).toFixed(7)));
}

function localEmbedding(text: string, dim = LOCAL_DIM): number[] {
  const values = new Array<number>(dim).fill(0);
  const tokens = normalizeText(text).split(/\s+/).filter((token) => token.length > 1);
  if (tokens.length === 0) return values;

  for (const token of tokens) {
    const hash = hashToken(token);
    const idx = hash % dim;
    const sign = hash % 2 === 0 ? 1 : -1;
    const weight = Math.min(3.2, 1 + token.length / 12);
    values[idx] += sign * weight;
  }

  return unitNormalize(values);
}

function extractEmbedding(payload: unknown): number[] | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;

  if (Array.isArray(row.embedding) && row.embedding.every((value) => typeof value === "number")) {
    return row.embedding as number[];
  }

  if (Array.isArray(row.embeddings)) {
    const first = row.embeddings[0];
    if (Array.isArray(first) && first.every((value) => typeof value === "number")) {
      return first as number[];
    }
  }

  if (row.data && Array.isArray((row.data as Array<unknown>)[0] as Array<unknown>)) {
    const first = (row.data as Array<unknown>)[0];
    if (Array.isArray(first) && first.every((value) => typeof value === "number")) {
      return first as number[];
    }
  }

  return null;
}

export async function embedText(input: { text: string; preferPassage?: boolean }): Promise<number[]> {
  const modelConfig = getBedrockModelConfig({ envKey: "EMBEDDING_MODEL_ID" });
  if (!modelConfig.ok) {
    return localEmbedding(input.text);
  }

  const payloads: Array<Record<string, unknown>> = [
    {
      inputText: input.text,
    },
    {
      texts: [input.text],
      input_type: input.preferPassage ? "search_document" : "search_query",
      truncate: "END",
    },
  ];

  for (const body of payloads) {
    try {
      const command = new InvokeModelCommand({
        modelId: modelConfig.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(body),
      });
      const response = await getBedrockClient({ modelId: modelConfig.modelId }).send(command);
      const raw = response.body?.transformToString ? await response.body.transformToString() : "";
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      const embedding = extractEmbedding(parsed);
      if (embedding && embedding.length > 0) {
        return unitNormalize(embedding.map((value) => Number(value)));
      }
    } catch {
      // Continue with fallback payload then local embedding.
    }
  }

  return localEmbedding(input.text);
}

export async function embedTexts(input: {
  texts: string[];
  preferPassage?: boolean;
}): Promise<number[][]> {
  const out: number[][] = [];
  for (const text of input.texts) {
    out.push(await embedText({ text, preferPassage: input.preferPassage }));
  }
  return out;
}
