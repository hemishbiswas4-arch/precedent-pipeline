import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { getBedrockClient, getBedrockModelConfig } from "@/lib/bedrock-client";
import { CaseCandidate } from "@/lib/types";

type RerankScore = {
  url: string;
  score: number;
};

function normalizeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

function lexicalRerank(query: string, candidates: CaseCandidate[]): RerankScore[] {
  const q = new Set(normalizeTokens(query));
  const out: RerankScore[] = [];

  for (const candidate of candidates) {
    const text = `${candidate.title} ${candidate.snippet} ${candidate.detailText ?? ""}`;
    const c = new Set(normalizeTokens(text));
    if (q.size === 0 || c.size === 0) {
      out.push({ url: candidate.url, score: 0 });
      continue;
    }

    let overlap = 0;
    for (const token of q) {
      if (c.has(token)) overlap += 1;
    }
    const score = overlap / q.size;
    out.push({ url: candidate.url, score: Number(Math.max(0, Math.min(1, score)).toFixed(6)) });
  }

  return out;
}

function parseRerankResponse(text: string): Array<{ id: string; score: number }> {
  const clean = text
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const payload = JSON.parse(clean) as { scores?: Array<{ id?: unknown; score?: unknown }> };
    const rows = Array.isArray(payload.scores) ? payload.scores : [];
    return rows
      .map((row) => ({
        id: String(row.id ?? "").trim(),
        score: Number(row.score ?? 0),
      }))
      .filter((row) => row.id.length > 0 && Number.isFinite(row.score));
  } catch {
    return [];
  }
}

async function hostedRerank(query: string, candidates: CaseCandidate[]): Promise<RerankScore[] | null> {
  const modelConfig = getBedrockModelConfig({ envKey: "RERANK_MODEL_ID" });
  if (!modelConfig.ok) return null;

  const docs = candidates.map((candidate, index) => ({
    id: String(index),
    title: candidate.title.slice(0, 180),
    snippet: candidate.snippet.slice(0, 320),
    court: candidate.court,
  }));

  const prompt = [
    "Return strict JSON only.",
    "Schema: {\"scores\":[{\"id\":\"0\",\"score\":0.0}]}",
    "Score each document for retrieval relevance to the legal query.",
    "Scores must be in [0,1].",
    JSON.stringify({ query, docs }),
  ].join("\n");

  try {
    const command = new ConverseCommand({
      modelId: modelConfig.modelId,
      system: [
        {
          text: "You are a legal retrieval reranker. Output only JSON.",
        },
      ],
      messages: [
        {
          role: "user",
          content: [{ text: prompt }],
        },
      ],
      inferenceConfig: {
        maxTokens: 350,
        temperature: 0,
      },
    });

    const response = await getBedrockClient({ modelId: modelConfig.modelId }).send(command);
    const text = (response.output?.message?.content ?? [])
      .flatMap((block) => ("text" in block && typeof block.text === "string" ? [block.text] : []))
      .join("\n")
      .trim();

    if (!text) return null;
    const scored = parseRerankResponse(text);
    if (scored.length === 0) return null;

    const out: RerankScore[] = [];
    for (const row of scored) {
      const index = Number(row.id);
      if (!Number.isFinite(index) || index < 0 || index >= candidates.length) continue;
      out.push({
        url: candidates[index].url,
        score: Number(Math.max(0, Math.min(1, row.score)).toFixed(6)),
      });
    }

    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export async function rerankCandidates(input: {
  query: string;
  candidates: CaseCandidate[];
  topN?: number;
}): Promise<{
  reranked: CaseCandidate[];
  applied: boolean;
}> {
  const topN = Math.max(2, Math.min(input.topN ?? 24, input.candidates.length));
  if (topN <= 0 || input.candidates.length === 0) {
    return {
      reranked: input.candidates,
      applied: false,
    };
  }

  const head = input.candidates.slice(0, topN);
  const tail = input.candidates.slice(topN);

  const hosted = await hostedRerank(input.query, head);
  const local = hosted ?? lexicalRerank(input.query, head);
  const scoreByUrl = new Map(local.map((row) => [row.url, row.score]));

  const rerankedHead = [...head]
    .map((candidate) => ({
      ...candidate,
      retrieval: {
        ...(candidate.retrieval ?? {}),
        rerankScore: scoreByUrl.get(candidate.url) ?? 0,
      },
    }))
    .sort((left, right) => {
      const leftScore = left.retrieval?.rerankScore ?? 0;
      const rightScore = right.retrieval?.rerankScore ?? 0;
      return rightScore - leftScore;
    });

  return {
    reranked: [...rerankedHead, ...tail],
    applied: true,
  };
}
