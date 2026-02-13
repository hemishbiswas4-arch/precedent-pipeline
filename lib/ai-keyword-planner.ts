import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockModelConfig,
  getBedrockClient,
  getBedrockModelConfig as resolveBedrockModelConfig,
} from "@/lib/bedrock-client";
import { ContextProfile, KeywordPack } from "@/lib/types";
import { sanitizeNlqForSearch } from "@/lib/nlq";

export type AIKeywordPlanResult = {
  keywordPack: KeywordPack;
  source: "bedrock" | "fallback";
  modelId?: string;
  error?: string;
};

type PlannerPayload = {
  primary?: unknown;
  legalSignals?: unknown;
  searchPhrases?: unknown;
};

const FALLBACK_NOISE = new Set([
  "case",
  "cases",
  "precedent",
  "precedents",
  "judgment",
  "judgments",
  "find",
  "show",
  "where",
  "anything",
  "found",
]);

export type BedrockPlannerAvailability = {
  available: boolean;
  modelId?: string;
  debugModelId?: string;
  error?: string;
};

function getBedrockModelConfig(): BedrockModelConfig {
  return resolveBedrockModelConfig({
    envKey: "BEDROCK_INFERENCE_PROFILE_ARN",
  });
}

export function getBedrockPlannerAvailability(): BedrockPlannerAvailability {
  const config = getBedrockModelConfig();
  if (!config.ok) {
    return {
      available: false,
      error: config.error,
      debugModelId: config.debugModelId,
    };
  }
  return {
    available: true,
    modelId: config.modelId,
    debugModelId: config.debugModelId,
  };
}

function toTextList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeTerm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`"'()[\]{}]/g, " ")
    .replace(/[^a-z0-9\s.:-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePrimary(value: string): string | null {
  const normalized = normalizeTerm(value);
  if (!normalized || normalized.length < 3) {
    return null;
  }
  if (FALLBACK_NOISE.has(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeSearchPhrase(value: string): string | null {
  const sanitized = sanitizeNlqForSearch(value);
  const normalized = normalizeTerm(sanitized)
    .replace(/\b(?:sortby|doctypes|fromdate|todate):\S+/gi, " ")
    .replace(/\b(?:cases?\s+where|precedents?\s+where|judgments?\s+where)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length < 8) {
    return null;
  }
  const words = normalized.split(/\s+/);
  if (words.length < 2) {
    return null;
  }
  return words.slice(0, 11).join(" ");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function extractJsonObject(raw: string): PlannerPayload | null {
  const trimmed = raw.trim();
  const direct = trimmed.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(direct) as PlannerPayload;
  } catch {
    const firstCurly = trimmed.indexOf("{");
    const lastCurly = trimmed.lastIndexOf("}");
    if (firstCurly >= 0 && lastCurly > firstCurly) {
      const slice = trimmed.slice(firstCurly, lastCurly + 1);
      try {
        return JSON.parse(slice) as PlannerPayload;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildPlannerPrompt(query: string, context: ContextProfile): string {
  const payload = {
    query,
    context,
    instructions: [
      "Create highly targeted Indian legal search keywords and short search phrases for precedents.",
      "Focus on legal concepts, statute sections, procedure hooks, and fact anchors.",
      "Exclude filler words and conversational wrappers.",
      "Do NOT include search operators like sortby:, doctypes:, fromdate:, todate:.",
      "Do NOT include prefixes like 'cases where', 'find cases', 'show cases'.",
      "Keep search phrases between 3 and 11 words.",
      "Return strict JSON only with keys: primary, legalSignals, searchPhrases.",
      "primary: 10-28 terms; legalSignals: 3-12; searchPhrases: 8-16",
    ],
  };
  return JSON.stringify(payload);
}

async function callBedrockPlanner(
  query: string,
  context: ContextProfile,
  modelId: string,
): Promise<PlannerPayload | null> {
  const client = getBedrockClient({ modelId });
  const command = new ConverseCommand({
    modelId,
    system: [
      {
        text: [
          "You are a legal search planner.",
          "Return only strict JSON with keys primary, legalSignals, searchPhrases.",
          "No markdown, no prose.",
        ].join(" "),
      },
    ],
    messages: [
      {
        role: "user",
        content: [{ text: buildPlannerPrompt(query, context) }],
      },
    ],
    inferenceConfig: {
      maxTokens: 700,
    },
  });

  const response = await client.send(command);
  const content = response.output?.message?.content ?? [];
  const text = content
    .flatMap((block) => ("text" in block && typeof block.text === "string" ? [block.text] : []))
    .join("\n")
    .trim();

  if (!text) {
    return null;
  }
  return extractJsonObject(text);
}

export async function buildKeywordPackWithAI(
  query: string,
  context: ContextProfile,
  fallbackPack: KeywordPack,
): Promise<AIKeywordPlanResult> {
  const modelConfig = getBedrockModelConfig();
  if (!modelConfig.ok) {
    return {
      keywordPack: fallbackPack,
      source: "fallback",
      modelId: modelConfig.debugModelId,
      error: modelConfig.error,
    };
  }
  const modelId = modelConfig.modelId;

  try {
    const payload = await callBedrockPlanner(query, context, modelId);
    if (!payload) {
      return {
        keywordPack: fallbackPack,
        source: "fallback",
        modelId: modelConfig.debugModelId,
        error: "Bedrock planner returned no parseable JSON",
      };
    }

    const primary = unique(
      [...toTextList(payload.primary), ...fallbackPack.primary]
        .map(normalizePrimary)
        .filter((v): v is string => Boolean(v)),
    ).slice(0, 28);

    const legalSignals = unique(
      [...toTextList(payload.legalSignals), ...fallbackPack.legalSignals]
        .map(normalizePrimary)
        .filter((v): v is string => Boolean(v)),
    ).slice(0, 12);

    const searchPhrases = unique(
      [...toTextList(payload.searchPhrases), ...fallbackPack.searchPhrases]
        .map(normalizeSearchPhrase)
        .filter((v): v is string => Boolean(v)),
    ).slice(0, 16);

    if (searchPhrases.length === 0) {
      return {
        keywordPack: fallbackPack,
        source: "fallback",
        modelId: modelConfig.debugModelId,
        error: "Bedrock planner produced zero valid search phrases",
      };
    }

    return {
      keywordPack: {
        primary: primary.length > 0 ? primary : fallbackPack.primary,
        legalSignals: legalSignals.length > 0 ? legalSignals : fallbackPack.legalSignals,
        searchPhrases,
      },
      source: "bedrock",
      modelId: modelConfig.debugModelId,
    };
  } catch (error) {
    return {
      keywordPack: fallbackPack,
      source: "fallback",
      modelId: modelConfig.debugModelId,
      error: error instanceof Error ? error.message : "Bedrock planner error",
    };
  }
}
