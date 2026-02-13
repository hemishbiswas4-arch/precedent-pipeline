import { randomUUID, createHash } from "crypto";
import { ConverseCommand, type ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { getBedrockClient, getBedrockModelConfig } from "@/lib/bedrock-client";
import { sharedCache } from "@/lib/cache/shared-cache";
import { ContextProfile } from "@/lib/types";
import {
  expandReasonerPlanFromSketch,
  isUsableReasonerPlan,
  ReasonerPlan,
  validateReasonerPlan,
  validateReasonerSketch,
} from "@/lib/reasoner-schema";

type ReasonerCachePayload = {
  plan: ReasonerPlan;
  modelId: string;
  createdAt: number;
};

type CircuitState = {
  failures: number;
  openUntil: number;
};

export type ReasonerTelemetry = {
  mode: "opus" | "deterministic";
  cacheHit: boolean;
  latencyMs?: number;
  degraded: boolean;
  timeout: boolean;
  timeoutMsUsed?: number;
  adaptiveTimeoutApplied?: boolean;
  error?: string;
  modelId?: string;
  warnings?: string[];
  reasonerStage?: "sketch" | "expand" | "pass2" | "skipped";
  reasonerStageLatencyMs?: Record<string, number>;
  reasonerPlanSource?: "llm_sketch+deterministic_expand" | "deterministic_only";
};

export type ReasonerExecution = {
  plan?: ReasonerPlan;
  telemetry: ReasonerTelemetry;
  fingerprint: string;
};

export type ReasonerMode = "pass1" | "pass2";

let inflightReasonerCalls = 0;

const MODE = (process.env.LLM_REASONER_MODE ?? "initial").toLowerCase();
// Production default favors a single, slightly longer attempt so we actually use the reasoner,
// instead of timing out quickly and falling back to deterministic every time.
const TIMEOUT_MS = Math.max(200, Number(process.env.LLM_REASONER_TIMEOUT_MS ?? "1800"));
const MAX_TIMEOUT_MS = Math.max(TIMEOUT_MS, Number(process.env.LLM_REASONER_MAX_TIMEOUT_MS ?? "4500"));
const MAX_TOKENS = Math.max(100, Number(process.env.LLM_REASONER_MAX_TOKENS ?? "360"));
// Guardrail: long generations are a primary source of latency/timeouts on big models.
// Use LLM_REASONER_MAX_TOKENS to tune, but keep a sane upper bound unless explicitly overridden.
const HARD_MAX_TOKENS = Math.max(120, Number(process.env.LLM_REASONER_HARD_MAX_TOKENS ?? "520"));
const MAX_CALLS_PER_REQUEST = Math.max(0, Number(process.env.LLM_REASONER_MAX_CALLS_PER_REQUEST ?? "2"));
const CACHE_TTL_SEC = Math.max(60, Number(process.env.LLM_REASONER_CACHE_TTL_SEC ?? "21600"));
const PASS2_CACHE_TTL_SEC = Math.max(60, Number(process.env.LLM_REASONER_PASS2_CACHE_TTL_SEC ?? "900"));
const CIRCUIT_ENABLED = (process.env.LLM_CIRCUIT_BREAKER_ENABLED ?? "1") !== "0";
const CIRCUIT_FAIL_THRESHOLD = Math.max(1, Number(process.env.LLM_CIRCUIT_FAIL_THRESHOLD ?? "2"));
const CIRCUIT_COOLDOWN_MS = Math.max(1_000, Number(process.env.LLM_CIRCUIT_COOLDOWN_MS ?? "30000"));
const LOCAL_MAX_INFLIGHT = Math.max(1, Number(process.env.LLM_REASONER_MAX_INFLIGHT ?? "4"));
const GLOBAL_RATE_LIMIT = Math.max(0, Number(process.env.LLM_REASONER_GLOBAL_RATE_LIMIT ?? "0"));
const GLOBAL_RATE_WINDOW_SEC = Math.max(5, Number(process.env.LLM_REASONER_GLOBAL_RATE_WINDOW_SEC ?? "60"));
const LOCK_TTL_SEC = Math.max(2, Math.ceil(TIMEOUT_MS / 1000) + 2);
const LOCK_WAIT_MS = Math.max(100, Number(process.env.LLM_REASONER_LOCK_WAIT_MS ?? "250"));
// Default on: keep attempting pass-1 so users still get LLM reasoning when the model is healthy.
const FORCE_PASS1_ATTEMPT = (process.env.LLM_REASONER_FORCE_PASS1_ATTEMPT ?? "1") !== "0";
const FALLBACK_TIMEOUT_BONUS_MS = Math.max(0, Number(process.env.LLM_REASONER_FALLBACK_TIMEOUT_BONUS_MS ?? "2200"));
// Keep default off to avoid chaining a second expensive model call after non-timeout parse/config issues.
const FALLBACK_ON_NON_TIMEOUT_ERROR_ENABLED =
  (process.env.LLM_REASONER_FALLBACK_ON_NON_TIMEOUT_ERROR ?? "0") !== "0";
const PASS1_COMPACT_PROMPT = (process.env.LLM_REASONER_PASS1_COMPACT_PROMPT ?? "1") !== "0";
const STRUCTURED_OUTPUT_ENABLED = (process.env.LLM_REASONER_STRUCTURED_OUTPUT ?? "1") !== "0";
const OPTIMIZED_LATENCY_ENABLED = (process.env.LLM_REASONER_OPTIMIZED_LATENCY ?? "1") !== "0";
const FALLBACK_MODEL_ID = process.env.LLM_REASONER_FALLBACK_MODEL_ID?.trim() ?? "";

const CIRCUIT_KEY = "reasoner:circuit:v1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function stripPartialFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeJsonLikeText(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\u00a0/g, " ")
    .trim();
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

function previewForTelemetry(text: string, maxChars = 900): string {
  const cleaned = text
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (cleaned.length <= maxChars) return cleaned;
  const headLen = Math.max(200, Math.floor(maxChars * 0.7));
  const tailLen = Math.max(140, maxChars - headLen);
  return `${cleaned.slice(0, headLen)} … ${cleaned.slice(-tailLen)}`;
}

function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  const normalized = normalizeJsonLikeText(text);
  const directCandidates = [
    normalized,
    stripMarkdownFences(normalized),
    stripPartialFence(normalized),
  ];

  for (const candidate of directCandidates) {
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      // keep trying
    }
  }

  const extracted = extractBalancedJsonObject(stripPartialFence(stripMarkdownFences(normalized)));
  if (!extracted) {
    return null;
  }

  const extractedCandidates = [
    extracted,
    removeTrailingCommas(extracted),
  ];
  for (const candidate of extractedCandidates) {
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      // keep trying
    }
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decodeLooseJsonStringToken(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value
      .replace(/\\n/g, " ")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function extractLooseStringArrayField(
  text: string,
  key: string,
  maxItems: number,
  maxLength = 160,
): string[] {
  const keyRegex = new RegExp(`"${key}"\\s*:\\s*\\[`, "i");
  const keyMatch = keyRegex.exec(text);
  if (!keyMatch) return [];

  const start = keyMatch.index + keyMatch[0].length;
  let end = text.indexOf("]", start);
  if (end < 0) {
    const rest = text.slice(start);
    const nextKeyOffset = rest.search(/,\s*"[a-z_][a-z0-9_]*"\s*:/i);
    end = nextKeyOffset >= 0 ? start + nextKeyOffset : Math.min(text.length, start + 1800);
  }

  const segment = text.slice(start, end);
  const output: string[] = [];
  const stringRegex = /"((?:\\.|[^"\\])*)"/g;
  let match = stringRegex.exec(segment);
  while (match) {
    const decoded = decodeLooseJsonStringToken(match[1] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (decoded && decoded.length <= maxLength && !output.includes(decoded)) {
      output.push(decoded);
      if (output.length >= maxItems) break;
    }
    match = stringRegex.exec(segment);
  }
  return output;
}

function extractLooseStringField(text: string, key: string): string | undefined {
  const regex = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "i");
  const match = regex.exec(text);
  if (!match) return undefined;
  const decoded = decodeLooseJsonStringToken(match[1] ?? "").replace(/\s+/g, " ").trim();
  return decoded || undefined;
}

function composeLooseTerm(parts: Array<string | undefined>, maxWords = 12): string | null {
  const joined = parts
    .map((value) => value?.replace(/\s+/g, " ").trim() ?? "")
    .filter((value) => value.length > 0)
    .join(" ")
    .trim();
  if (!joined) return null;
  const tokens = joined.split(/\s+/).slice(0, maxWords);
  if (tokens.length < 2) return null;
  return tokens.join(" ");
}

function recoverSketchFromLoosePayload(text: string): Record<string, unknown> | null {
  const normalized = stripPartialFence(stripMarkdownFences(normalizeJsonLikeText(text)));
  if (!normalized || normalized.indexOf("{") < 0) return null;
  const payloadText = normalized.slice(normalized.indexOf("{"));

  const actors = extractLooseStringArrayField(payloadText, "actors", 8);
  const proceeding = extractLooseStringArrayField(payloadText, "proceeding", 8);
  const outcome = extractLooseStringArrayField(payloadText, "outcome", 10);
  const hooks = extractLooseStringArrayField(payloadText, "hooks", 12);
  const strictTerms = extractLooseStringArrayField(payloadText, "strict_terms", 8);
  const broadTerms = extractLooseStringArrayField(payloadText, "broad_terms", 8);
  const polarity = extractLooseStringField(payloadText, "polarity");
  const courtHint = extractLooseStringField(payloadText, "court_hint");

  const recoveredStrictTerms = strictTerms.length > 0
    ? strictTerms
    : [
        composeLooseTerm([actors[0], proceeding[0], outcome[0], hooks[0]]),
        composeLooseTerm([proceeding[0], outcome[0], hooks[0]]),
        composeLooseTerm([actors[0], outcome[0], hooks[0]]),
      ].filter((value): value is string => Boolean(value));

  if (
    recoveredStrictTerms.length === 0 &&
    actors.length === 0 &&
    proceeding.length === 0 &&
    outcome.length === 0 &&
    hooks.length === 0
  ) {
    return null;
  }

  const recovered: Record<string, unknown> = {
    strict_terms: recoveredStrictTerms,
  };
  if (actors.length > 0) recovered.actors = actors;
  if (proceeding.length > 0) recovered.proceeding = proceeding;
  if (outcome.length > 0) recovered.outcome = outcome;
  if (hooks.length > 0) recovered.hooks = hooks;
  if (broadTerms.length > 0) recovered.broad_terms = broadTerms;
  if (polarity) recovered.polarity = polarity;
  if (courtHint) recovered.court_hint = courtHint;

  return recovered;
}

function mergeWarnings(...sets: Array<string[] | undefined>): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const set of sets) {
    for (const warning of set ?? []) {
      if (!warning || seen.has(warning)) continue;
      seen.add(warning);
      output.push(warning);
    }
  }
  return output;
}

const REASONER_PLAN_JSON_SCHEMA = JSON.stringify({
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ReasonerPlan",
  type: "object",
  additionalProperties: false,
  required: [
    "proposition",
    "query_variants_strict",
  ],
  properties: {
    proposition: {
      type: "object",
      additionalProperties: false,
      required: [
        "jurisdiction_hint",
        "outcome_constraint",
      ],
      properties: {
        actors: { type: "array", items: { type: "string" } },
        proceeding: { type: "array", items: { type: "string" } },
        legal_hooks: { type: "array", items: { type: "string" } },
        outcome_required: { type: "array", items: { type: "string" } },
        outcome_negative: { type: "array", items: { type: "string" } },
        jurisdiction_hint: { type: "string", enum: ["SC", "HC", "ANY"] },
        hook_groups: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["group_id", "terms", "min_match", "required"],
            properties: {
              group_id: { type: "string" },
              terms: { type: "array", items: { type: "string" } },
              min_match: { type: "integer" },
              required: { type: "boolean" },
            },
          },
        },
        relations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "left_group_id", "right_group_id", "required"],
            properties: {
              type: { type: "string", enum: ["requires", "applies_to", "interacts_with", "excluded_by"] },
              left_group_id: { type: "string" },
              right_group_id: { type: "string" },
              required: { type: "boolean" },
            },
          },
        },
        outcome_constraint: {
          type: "object",
          additionalProperties: false,
          required: ["polarity", "terms", "contradiction_terms"],
          properties: {
            polarity: {
              type: "string",
              enum: ["required", "not_required", "allowed", "refused", "dismissed", "quashed", "unknown"],
            },
            modality: { type: "string" },
            terms: { type: "array", items: { type: "string" } },
            contradiction_terms: { type: "array", items: { type: "string" } },
          },
        },
        interaction_required: { type: "boolean" },
      },
    },
    must_have_terms: { type: "array", items: { type: "string" } },
    must_not_have_terms: { type: "array", items: { type: "string" } },
    query_variants_strict: {
      type: "array",
      items: { type: "string" },
    },
    query_variants_broad: { type: "array", items: { type: "string" } },
    case_anchors: { type: "array", items: { type: "string" } },
  },
});

const REASONER_SKETCH_JSON_SCHEMA = JSON.stringify({
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ReasonerSketch",
  type: "object",
  additionalProperties: false,
  required: ["strict_terms"],
  properties: {
    actors: { type: "array", items: { type: "string" } },
    proceeding: { type: "array", items: { type: "string" } },
    outcome: { type: "array", items: { type: "string" } },
    hooks: { type: "array", items: { type: "string" } },
    polarity: {
      type: "string",
      enum: ["required", "not_required", "allowed", "refused", "dismissed", "quashed", "unknown"],
    },
    strict_terms: { type: "array", items: { type: "string" } },
    broad_terms: { type: "array", items: { type: "string" } },
    court_hint: { type: "string", enum: ["SC", "HC", "ANY"] },
  },
});

function promptForReasoner(query: string, context: ContextProfile, compactMode = false): string {
  const strictLimit = compactMode ? 3 : 6;
  const broadLimit = compactMode ? 3 : 8;
  const tokenLimit = compactMode ? 8 : 11;
  const compactContext =
    compactMode
      ? {
          domains: context.domains.slice(0, 4),
          issues: context.issues.slice(0, 4),
          statutesOrSections: context.statutesOrSections.slice(0, 4),
          procedures: context.procedures.slice(0, 4),
          actors: context.actors.slice(0, 4),
          anchors: context.anchors.slice(0, 4),
        }
      : context;
  return [
    "Return ONE strict JSON object only (no markdown).",
    "Task: produce a compact ReasonerSketch for Indian case retrieval.",
    "Constraints:",
    "- Keys allowed: actors, proceeding, outcome, hooks, polarity, strict_terms, broad_terms, court_hint.",
    `- strict_terms<=${strictLimit}; broad_terms<=${broadLimit}; each term <=${tokenLimit} tokens.`,
    "- strict_terms must include actor+proceeding+outcome when present.",
    "- No search operators (doctypes:, sortby:, fromdate:, todate:).",
    compactMode ? "- Keep terms very short. Omit empty arrays." : "- Keep output compact. Omit empty arrays.",
    "Input:",
    JSON.stringify({ query, context: compactContext }),
  ].join("\n");
}

function promptForPass2Reasoner(
  input: {
  query: string;
  context: ContextProfile;
  basePlan: ReasonerPlan;
  snippets: string[];
},
  compactMode = false,
): string {
  const strictLimit = compactMode ? 4 : 5;
  const broadLimit = compactMode ? 5 : 6;
  const anchorLimit = compactMode ? 3 : 4;
  const tokenLimit = compactMode ? 10 : 12;
  const compactContext =
    compactMode
      ? {
          domains: input.context.domains.slice(0, 4),
          issues: input.context.issues.slice(0, 4),
          statutesOrSections: input.context.statutesOrSections.slice(0, 4),
          procedures: input.context.procedures.slice(0, 4),
          actors: input.context.actors.slice(0, 4),
          anchors: input.context.anchors.slice(0, 4),
        }
      : input.context;
  if (compactMode) {
    return [
      "Return one JSON object only.",
      "Refine base plan from snippets without weakening required proposition.",
      `Strict<=${strictLimit}, Broad<=${broadLimit}, Anchors<=${anchorLimit}.`,
      `Each variant <=${tokenLimit} tokens.`,
      `Input:${JSON.stringify({
        query: input.query,
        context: compactContext,
        base_plan: input.basePlan,
        snippets: input.snippets.slice(0, 6),
      })}`,
    ].join("\n");
  }
  return [
    "Return ONE strict JSON object (no markdown, no ``` fences).",
    "Task: refine the base ReasonerPlan using snippet evidence.",
    "Constraints:",
    "- Do not weaken the required legal proposition; tighten it when snippets show drift.",
    `- Keep output compact: query_variants_strict<=${strictLimit}; query_variants_broad<=${broadLimit}; case_anchors<=${anchorLimit}.`,
    `- Each query variant <=${tokenLimit} tokens.`,
    compactMode ? "- Use shortest legal phrases possible to reduce output length." : "",
    "- Preserve required hook group intersections when doctrinally necessary.",
    "- Set outcome_constraint.polarity explicitly and include contradiction_terms.",
    "Input:",
    JSON.stringify({
      query: input.query,
      context: compactContext,
      base_plan: input.basePlan,
      snippets: input.snippets.slice(0, 10),
    }),
  ].join("\n");
}

function telemetryDeterministic(
  fingerprint: string,
  error?: string,
  extras?: Partial<Omit<ReasonerTelemetry, "mode" | "cacheHit" | "degraded" | "timeout">>,
): ReasonerExecution {
  return {
    fingerprint,
    telemetry: {
      mode: "deterministic",
      cacheHit: false,
      degraded: true,
      timeout: false,
      error,
      reasonerStage: "skipped",
      reasonerPlanSource: "deterministic_only",
      ...extras,
    },
  };
}

async function getCircuitState(): Promise<CircuitState> {
  if (!CIRCUIT_ENABLED) return { failures: 0, openUntil: 0 };
  const state = await sharedCache.getJson<CircuitState>(CIRCUIT_KEY);
  if (!state) return { failures: 0, openUntil: 0 };
  return {
    failures: Math.max(0, Number(state.failures ?? 0)),
    openUntil: Math.max(0, Number(state.openUntil ?? 0)),
  };
}

async function setCircuitState(state: CircuitState): Promise<void> {
  if (!CIRCUIT_ENABLED) return;
  await sharedCache.setJson(CIRCUIT_KEY, state, Math.max(30, Math.ceil(CIRCUIT_COOLDOWN_MS / 1000) + 30));
}

async function onCircuitSuccess(): Promise<void> {
  if (!CIRCUIT_ENABLED) return;
  await setCircuitState({ failures: 0, openUntil: 0 });
}

async function onCircuitFailure(): Promise<void> {
  if (!CIRCUIT_ENABLED) return;
  const current = await getCircuitState();
  const failures = current.failures + 1;
  const openUntil = failures >= CIRCUIT_FAIL_THRESHOLD ? Date.now() + CIRCUIT_COOLDOWN_MS : 0;
  await setCircuitState({ failures, openUntil });
}

async function withinGlobalRateBudget(): Promise<boolean> {
  if (GLOBAL_RATE_LIMIT <= 0) return true;
  const bucket = Math.floor(Date.now() / (GLOBAL_RATE_WINDOW_SEC * 1000));
  const key = `reasoner:rate:${bucket}`;
  const count = await sharedCache.increment(key, GLOBAL_RATE_WINDOW_SEC + 2);
  return count <= GLOBAL_RATE_LIMIT;
}

export function buildQueryFingerprint(cleanedQuery: string, context: ContextProfile): string {
  const payload = {
    q: cleanedQuery.toLowerCase().replace(/\s+/g, " ").trim(),
    d: context.domains,
    i: context.issues,
    s: context.statutesOrSections,
    p: context.procedures,
    a: context.actors,
  };
  const serialized = JSON.stringify(payload);
  return createHash("sha256").update(serialized).digest("hex").slice(0, 32);
}

function buildPass2SeedHash(basePlan: ReasonerPlan | undefined, snippets: string[] | undefined): string {
  const payload = JSON.stringify({
    plan: basePlan ?? null,
    snippets: (snippets ?? []).map((snippet) => snippet.slice(0, 280)),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

async function invokeReasonerModel(input: {
  mode: ReasonerMode;
  target: "plan" | "sketch";
  query: string;
  context: ContextProfile;
  modelId: string;
  timeoutMs: number;
  basePlan?: ReasonerPlan;
  snippets?: string[];
  compactPrompt?: boolean;
  maxTokensOverride?: number;
  structuredOverride?: boolean;
  optimizedOverride?: boolean;
}): Promise<{
  plan?: ReasonerPlan;
  warnings: string[];
  timeout: boolean;
  error?: string;
  reasonerStage?: "sketch" | "expand" | "pass2";
  reasonerStageLatencyMs?: Record<string, number>;
  reasonerPlanSource?: "llm_sketch+deterministic_expand" | "deterministic_only";
}> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const warnings: string[] = [];
    const requestedMaxTokens = Math.max(80, input.maxTokensOverride ?? MAX_TOKENS);
    const maxTokensUsed = Math.min(requestedMaxTokens, HARD_MAX_TOKENS);
    if (requestedMaxTokens > maxTokensUsed) {
      warnings.push(`reasoner_max_tokens_capped:${maxTokensUsed}`);
    }
    const sendOnce = async (options: {
      structured: boolean;
      optimized: boolean;
      maxTokens: number;
      compactPrompt: boolean;
    }) => {
      const promptText =
        input.target === "plan" && input.mode === "pass2" && input.basePlan
          ? promptForPass2Reasoner(
              {
                query: input.query,
                context: input.context,
                basePlan: input.basePlan,
                snippets: input.snippets ?? [],
              },
              options.compactPrompt,
            )
          : promptForReasoner(input.query, input.context, options.compactPrompt);
      const outputSchema = input.target === "sketch" ? REASONER_SKETCH_JSON_SCHEMA : REASONER_PLAN_JSON_SCHEMA;
      const outputSchemaName = input.target === "sketch" ? "reasoner_sketch_v1" : "reasoner_plan_v1";

      const baseRequest: ConverseCommandInput = {
        modelId: input.modelId,
        system: [
          {
            text: [
              "You are a legal proposition planner for Indian case retrieval.",
              "Return a single strict JSON object only.",
              "No explanations. No markdown. No code fences.",
            ].join(" "),
          },
        ],
        messages: [
          {
            role: "user",
            content: [{ text: promptText }],
          },
        ],
        inferenceConfig: {
          maxTokens: options.maxTokens,
          temperature: 0,
        },
      };
      const payload: ConverseCommandInput = {
        ...baseRequest,
        ...(options.optimized ? { performanceConfig: { latency: "optimized" as const } } : {}),
        ...(options.structured
          ? {
              outputConfig: {
                textFormat: {
                  type: "json_schema" as const,
                  structure: {
                    jsonSchema: {
                      name: outputSchemaName,
                      description: "Reasoner output schema for retrieval pipeline.",
                      schema: outputSchema,
                    },
                  },
                },
              },
            }
          : {}),
      };
      const command = new ConverseCommand(payload);
      return await getBedrockClient({ modelId: input.modelId }).send(command, {
        abortSignal: controller.signal,
      });
    };

    const detectUnsupportedConfig = (
      error: unknown,
    ): { outputConfig: boolean; performanceConfig: boolean } | null => {
      const name = error instanceof Error ? error.name.toLowerCase() : "";
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      const combined = `${name} ${message}`;
      const outputConfigUnsupported =
        combined.includes("outputconfig") ||
        combined.includes("output_config") ||
        combined.includes("textformat") ||
        combined.includes("json_schema") ||
        combined.includes("jsonschema") ||
        combined.includes("format.schema") ||
        combined.includes("structured output");
      const performanceConfigUnsupported =
        combined.includes("performanceconfig") ||
        combined.includes("performancedconfig") ||
        combined.includes("latency");
      if (!outputConfigUnsupported && !performanceConfigUnsupported) {
        return null;
      }
      return {
        outputConfig: outputConfigUnsupported,
        performanceConfig: performanceConfigUnsupported,
      };
    };

    let usedStructured = input.structuredOverride ?? STRUCTURED_OUTPUT_ENABLED;
    let usedOptimized = input.optimizedOverride ?? OPTIMIZED_LATENCY_ENABLED;

    let response;
    try {
      response = await sendOnce({
        structured: usedStructured,
        optimized: usedOptimized,
        maxTokens: maxTokensUsed,
        compactPrompt: input.compactPrompt ?? false,
      });
    } catch (error) {
      const unsupported = detectUnsupportedConfig(error);
      if (!unsupported) {
        throw error;
      }

      // If Bedrock rejects outputConfig/performanceConfig for this model/profile, retry once with only the supported subset.
      if (unsupported.outputConfig) {
        usedStructured = false;
        warnings.push("reasoner_model_rejected_structured_output");
      }
      if (unsupported.performanceConfig) {
        usedOptimized = false;
        warnings.push("reasoner_model_rejected_latency_optimized");
      }

      response = await sendOnce({
        structured: usedStructured,
        optimized: usedOptimized,
        maxTokens: maxTokensUsed,
        compactPrompt: input.compactPrompt ?? false,
      });
    }

    if (usedStructured) {
      warnings.push("reasoner_structured_output_enabled");
    }
    if (usedOptimized) {
      warnings.push("reasoner_latency_optimized");
    }
    if (input.compactPrompt) {
      warnings.push("reasoner_compact_prompt");
    }
    if (typeof response.metrics?.latencyMs === "number") {
      warnings.push(`reasoner_bedrock_latency_ms:${response.metrics.latencyMs}`);
    }
    if (response.usage) {
      const inputTokens = response.usage.inputTokens ?? 0;
      const outputTokens = response.usage.outputTokens ?? 0;
      const totalTokens = response.usage.totalTokens ?? inputTokens + outputTokens;
      warnings.push(`reasoner_usage_tokens:in=${inputTokens} out=${outputTokens} total=${totalTokens}`);
    }

    const text = (response.output?.message?.content ?? [])
      .flatMap((block) => ("text" in block && typeof block.text === "string" ? [block.text] : []))
      .join("\n")
      .trim();

    if (!text) {
      return {
        warnings: mergeWarnings(warnings, ["reasoner returned empty response"]),
        timeout: false,
        error: "reasoner_empty_response",
      };
    }

    const normalizeToPlan = (
      raw: Record<string, unknown>,
      modelStageLatencyMs: number | undefined,
      extraWarnings?: string[],
    ):
      | {
          ok: true;
          plan: ReasonerPlan;
          warnings: string[];
          reasonerStage: "sketch" | "expand" | "pass2";
          reasonerPlanSource: "llm_sketch+deterministic_expand" | "deterministic_only";
          reasonerStageLatencyMs: Record<string, number>;
        }
      | { ok: false; error: string; warnings: string[] } => {
      if (input.target === "sketch") {
        const sketchValidated = validateReasonerSketch(raw);
        const expandStartedAt = Date.now();
        const expandedPlan = expandReasonerPlanFromSketch(sketchValidated.sketch);
        const expandLatencyMs = Math.max(0, Date.now() - expandStartedAt);
        if (!isUsableReasonerPlan(expandedPlan)) {
          return {
            ok: false,
            error: "reasoner_sketch_not_usable",
            warnings: mergeWarnings(extraWarnings, sketchValidated.warnings),
          };
        }
        return {
          ok: true,
          plan: expandedPlan,
          warnings: mergeWarnings(extraWarnings, sketchValidated.warnings),
          reasonerStage: "expand",
          reasonerPlanSource: "llm_sketch+deterministic_expand",
          reasonerStageLatencyMs: {
            sketch: Math.max(0, Math.floor(modelStageLatencyMs ?? 0)),
            expand: expandLatencyMs,
          },
        };
      }

      const validated = validateReasonerPlan(raw);
      if (!isUsableReasonerPlan(validated.plan)) {
        return {
          ok: false,
          error: "reasoner_plan_not_usable",
          warnings: mergeWarnings(extraWarnings, validated.warnings),
        };
      }
      return {
        ok: true,
        plan: validated.plan,
        warnings: mergeWarnings(extraWarnings, validated.warnings),
        reasonerStage: input.mode === "pass2" ? "pass2" : "expand",
        reasonerPlanSource: "llm_sketch+deterministic_expand",
        reasonerStageLatencyMs: {
          [input.mode === "pass2" ? "pass2" : "expand"]: Math.max(0, Math.floor(modelStageLatencyMs ?? 0)),
        },
      };
    };

    const parsed = safeJsonParse(text);
    if (!parsed) {
      if (input.target === "sketch") {
        const recovered = recoverSketchFromLoosePayload(text);
        if (recovered) {
          const recoveredNormalized = normalizeToPlan(
            recovered,
            typeof response.metrics?.latencyMs === "number" ? response.metrics.latencyMs : undefined,
            [
              "reasoner_loose_json_salvaged",
              response.stopReason ? `reasoner_stop_reason:${String(response.stopReason)}` : "",
            ],
          );
          if (recoveredNormalized.ok) {
            return {
              plan: recoveredNormalized.plan,
              warnings: mergeWarnings(warnings, recoveredNormalized.warnings),
              timeout: false,
              reasonerStage: recoveredNormalized.reasonerStage,
              reasonerPlanSource: recoveredNormalized.reasonerPlanSource,
              reasonerStageLatencyMs: recoveredNormalized.reasonerStageLatencyMs,
            };
          }
        }
      }

      const stopReason = String(response.stopReason ?? "");
      const maxTokensCutoff =
        stopReason.toLowerCase().includes("max_tokens") || stopReason.toLowerCase().includes("maxtokens");
      if (maxTokensCutoff && maxTokensUsed < HARD_MAX_TOKENS) {
        const retryMaxTokens = Math.min(HARD_MAX_TOKENS, Math.max(maxTokensUsed + 160, Math.ceil(maxTokensUsed * 1.5)));
        warnings.push(`reasoner_max_tokens_retry_attempt:${maxTokensUsed}->${retryMaxTokens}`);
        const retryResponse = await sendOnce({
          structured: usedStructured,
          optimized: usedOptimized,
          maxTokens: retryMaxTokens,
          compactPrompt: true,
        });
        if (typeof retryResponse.metrics?.latencyMs === "number") {
          warnings.push(`reasoner_bedrock_retry_latency_ms:${retryResponse.metrics.latencyMs}`);
        }
        const retryText = (retryResponse.output?.message?.content ?? [])
          .flatMap((block) => ("text" in block && typeof block.text === "string" ? [block.text] : []))
          .join("\n")
          .trim();
        const retryParsed = safeJsonParse(retryText);
        if (retryParsed) {
          const retryNormalized = normalizeToPlan(
            retryParsed,
            typeof retryResponse.metrics?.latencyMs === "number" ? retryResponse.metrics.latencyMs : undefined,
            [
              retryResponse.stopReason ? `reasoner_retry_stop_reason:${String(retryResponse.stopReason)}` : "",
            ],
          );
          if (retryNormalized.ok) {
            return {
              plan: retryNormalized.plan,
              warnings: mergeWarnings(warnings, ["reasoner_max_tokens_retry_success"], retryNormalized.warnings),
              timeout: false,
              reasonerStage: retryNormalized.reasonerStage,
              reasonerPlanSource: retryNormalized.reasonerPlanSource,
              reasonerStageLatencyMs: retryNormalized.reasonerStageLatencyMs,
            };
          }
          return {
            warnings: mergeWarnings(
              warnings,
              ["reasoner_max_tokens_retry_failed"],
              retryNormalized.warnings,
            ),
            timeout: false,
            error: retryNormalized.error,
          };
        }

        if (input.target === "sketch") {
          const recoveredRetry = recoverSketchFromLoosePayload(retryText);
          if (recoveredRetry) {
            const recoveredRetryNormalized = normalizeToPlan(
              recoveredRetry,
              typeof retryResponse.metrics?.latencyMs === "number" ? retryResponse.metrics.latencyMs : undefined,
              [
                "reasoner_max_tokens_retry_failed",
                "reasoner_loose_json_salvaged",
                retryResponse.stopReason ? `reasoner_retry_stop_reason:${String(retryResponse.stopReason)}` : "",
              ],
            );
            if (recoveredRetryNormalized.ok) {
              return {
                plan: recoveredRetryNormalized.plan,
                warnings: mergeWarnings(
                  warnings,
                  ["reasoner_max_tokens_retry_salvaged"],
                  recoveredRetryNormalized.warnings,
                ),
                timeout: false,
                reasonerStage: recoveredRetryNormalized.reasonerStage,
                reasonerPlanSource: recoveredRetryNormalized.reasonerPlanSource,
                reasonerStageLatencyMs: recoveredRetryNormalized.reasonerStageLatencyMs,
              };
            }
          }
        }

        const retryPreview = previewForTelemetry(retryText);
        return {
          warnings: mergeWarnings(warnings, [
            "reasoner_max_tokens_retry_failed",
            "reasoner returned non-JSON payload",
            retryPreview ? `reasoner_raw_preview:${retryPreview}` : "reasoner_raw_preview:empty",
            retryResponse.stopReason ? `reasoner_retry_stop_reason:${String(retryResponse.stopReason)}` : "",
          ]),
          timeout: false,
          error: retryPreview ? `reasoner_unparseable_json:${retryPreview}` : "reasoner_unparseable_json",
        };
      }
      const preview = previewForTelemetry(text);
      return {
        warnings: mergeWarnings(warnings, [
          "reasoner returned non-JSON payload",
          preview ? `reasoner_raw_preview:${preview}` : "reasoner_raw_preview:empty",
          response.stopReason ? `reasoner_stop_reason:${String(response.stopReason)}` : "",
        ]),
        timeout: false,
        error: preview ? `reasoner_unparseable_json:${preview}` : "reasoner_unparseable_json",
      };
    }

    const normalized = normalizeToPlan(
      parsed,
      typeof response.metrics?.latencyMs === "number" ? response.metrics.latencyMs : undefined,
      [response.stopReason ? `reasoner_stop_reason:${String(response.stopReason)}` : ""],
    );
    if (!normalized.ok) {
      return {
        warnings: mergeWarnings(warnings, normalized.warnings),
        timeout: false,
        error: normalized.error,
      };
    }
    return {
      plan: normalized.plan,
      warnings: mergeWarnings(warnings, normalized.warnings),
      timeout: false,
      reasonerStage: normalized.reasonerStage,
      reasonerPlanSource: normalized.reasonerPlanSource,
      reasonerStageLatencyMs: normalized.reasonerStageLatencyMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (error instanceof Error && (/abort/i.test(error.name) || /request aborted|timed out|timeout|aborted/i.test(message))) {
      return {
        warnings: ["reasoner timeout"],
        timeout: true,
        error: "reasoner_timeout",
      };
    }

    return {
      warnings: [],
      timeout: false,
      error: error instanceof Error ? error.message : "reasoner_error",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function runOpusReasoner(input: {
  mode?: ReasonerMode;
  query: string;
  cleanedQuery: string;
  context: ContextProfile;
  requestCallIndex: number;
  basePlan?: ReasonerPlan;
  snippets?: string[];
}): Promise<ReasonerExecution> {
  const mode = input.mode ?? "pass1";
  const fingerprint = buildQueryFingerprint(input.cleanedQuery, input.context);
  const forcePass1Attempt = FORCE_PASS1_ATTEMPT && mode === "pass1";

  const complexityScore =
    (input.context.statutesOrSections.length >= 2 ? 1 : 0) +
    (input.context.issues.some((issue) => /\binteraction|interplay|read with|requires under\b/i.test(issue)) ? 1 : 0) +
    (input.context.procedures.length >= 2 ? 1 : 0) +
    (input.cleanedQuery.length > 180 ? 1 : 0) +
    (input.mode === "pass2" ? 1 : 0);
  const adaptiveBumpMs = complexityScore >= 3 ? 800 : complexityScore >= 1 ? 400 : 0;
  const timeoutMsUsed = Math.min(MAX_TIMEOUT_MS, TIMEOUT_MS + adaptiveBumpMs);
  const adaptiveTimeoutApplied = timeoutMsUsed > TIMEOUT_MS;

  if (mode === "pass2" && !input.basePlan) {
    return telemetryDeterministic(fingerprint, "reasoner_pass2_missing_base_plan", {
      timeoutMsUsed,
      adaptiveTimeoutApplied,
    });
  }

  if (MODE === "off" || MODE === "deterministic" || MODE === "deterministic_only") {
    return telemetryDeterministic(fingerprint, "reasoner_mode_disabled", {
      timeoutMsUsed,
      adaptiveTimeoutApplied,
    });
  }

  if (input.requestCallIndex >= MAX_CALLS_PER_REQUEST) {
    return telemetryDeterministic(fingerprint, "reasoner_call_budget_exhausted", {
      timeoutMsUsed,
      adaptiveTimeoutApplied,
    });
  }

  const modelConfig = getBedrockModelConfig({
    envKey: "LLM_REASONER_MODEL_ID",
    fallbackEnvKey: "BEDROCK_INFERENCE_PROFILE_ARN",
  });

  if (!modelConfig.ok) {
    return telemetryDeterministic(fingerprint, modelConfig.error, {
      modelId: modelConfig.debugModelId,
      timeoutMsUsed,
      adaptiveTimeoutApplied,
    });
  }
  const fallbackModelConfig = (() => {
    if (!FALLBACK_MODEL_ID) return undefined;
    const config = getBedrockModelConfig({ envKey: "LLM_REASONER_FALLBACK_MODEL_ID" });
    if (!config.ok) return undefined;
    if (config.modelId === modelConfig.modelId) return undefined;
    return config;
  })();

  const pass2SeedHash = mode === "pass2" ? buildPass2SeedHash(input.basePlan, input.snippets) : "";
  const cacheKey =
    mode === "pass2" ? `reasoner:v2:pass2:${fingerprint}:${pass2SeedHash}` : `reasoner:v2:pass1:${fingerprint}`;
  const lockKey =
    mode === "pass2" ? `lock:reasoner:pass2:${fingerprint}:${pass2SeedHash}` : `lock:reasoner:pass1:${fingerprint}`;

  const cached = await sharedCache.getJson<ReasonerCachePayload>(cacheKey);
  if (cached?.plan) {
    return {
      fingerprint,
      plan: cached.plan,
      telemetry: {
        mode: "opus",
        cacheHit: true,
        degraded: false,
        timeout: false,
        timeoutMsUsed,
        adaptiveTimeoutApplied,
        modelId: cached.modelId,
        reasonerStage: mode === "pass2" ? "pass2" : "expand",
        reasonerPlanSource: "llm_sketch+deterministic_expand",
      },
    };
  }

  const circuit = await getCircuitState();
  if (CIRCUIT_ENABLED && circuit.openUntil > Date.now() && !forcePass1Attempt) {
    return telemetryDeterministic(fingerprint, "reasoner_circuit_open", {
      modelId: modelConfig.debugModelId,
      timeoutMsUsed,
      adaptiveTimeoutApplied,
    });
  }

  if (!(await withinGlobalRateBudget())) {
    return telemetryDeterministic(fingerprint, "reasoner_global_rate_limited", {
      modelId: modelConfig.debugModelId,
      timeoutMsUsed,
      adaptiveTimeoutApplied,
    });
  }

  const lockOwner = randomUUID();
  const lockAcquired = await sharedCache.acquireLock(lockKey, lockOwner, LOCK_TTL_SEC);

  if (!lockAcquired) {
    const startedWait = Date.now();
    while (Date.now() - startedWait < LOCK_WAIT_MS) {
      await sleep(90);
      const waitingCached = await sharedCache.getJson<ReasonerCachePayload>(cacheKey);
      if (waitingCached?.plan) {
        return {
          fingerprint,
          plan: waitingCached.plan,
          telemetry: {
            mode: "opus",
            cacheHit: true,
            degraded: false,
            timeout: false,
            timeoutMsUsed,
            adaptiveTimeoutApplied,
            modelId: waitingCached.modelId,
          },
        };
      }
    }

    return telemetryDeterministic(fingerprint, "reasoner_inflight_lock_wait_timeout", {
      modelId: modelConfig.debugModelId,
      timeoutMsUsed,
      adaptiveTimeoutApplied,
    });
  }

  if (inflightReasonerCalls >= LOCAL_MAX_INFLIGHT) {
    await sharedCache.releaseLock(lockKey, lockOwner);
    return telemetryDeterministic(fingerprint, "reasoner_local_semaphore_saturated", {
      modelId: modelConfig.debugModelId,
      timeoutMsUsed,
      adaptiveTimeoutApplied,
    });
  }

  inflightReasonerCalls += 1;
  const startedAt = Date.now();

  try {
    const passCompactPrompt = mode === "pass2" ? true : PASS1_COMPACT_PROMPT;
    let effectiveTimeoutMs = timeoutMsUsed;
    let effectiveModelDebugId = modelConfig.debugModelId;
    let modelResult = await invokeReasonerModel({
      mode,
      target: mode === "pass1" ? "sketch" : "plan",
      query: input.query,
      context: input.context,
      modelId: modelConfig.modelId,
      timeoutMs: timeoutMsUsed,
      basePlan: input.basePlan,
      snippets: input.snippets,
      compactPrompt: passCompactPrompt,
    });

    if (
      !modelResult.plan &&
      mode === "pass1" &&
      !modelResult.timeout &&
      FALLBACK_ON_NON_TIMEOUT_ERROR_ENABLED &&
      fallbackModelConfig
    ) {
      const fallbackTimeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(3_000, timeoutMsUsed + Math.min(FALLBACK_TIMEOUT_BONUS_MS, 1_200)),
      );
      const fallbackResult = await invokeReasonerModel({
        mode,
        target: "sketch",
        query: input.query,
        context: input.context,
        modelId: fallbackModelConfig.modelId,
        timeoutMs: fallbackTimeoutMs,
        basePlan: input.basePlan,
        snippets: input.snippets,
        compactPrompt: true,
      });
      effectiveTimeoutMs = fallbackTimeoutMs;
      if (fallbackResult.plan) {
        effectiveModelDebugId = fallbackModelConfig.debugModelId;
        modelResult = {
          ...fallbackResult,
          warnings: mergeWarnings(
            modelResult.warnings,
            [`reasoner_primary_non_timeout_error:${modelConfig.debugModelId}`],
            [`reasoner_fallback_timeout_ms:${effectiveTimeoutMs}`],
            ["reasoner_fallback_model_success"],
            fallbackResult.warnings,
          ),
        };
      } else {
        modelResult = {
          ...fallbackResult,
          warnings: mergeWarnings(
            modelResult.warnings,
            [`reasoner_primary_non_timeout_error:${modelConfig.debugModelId}`],
            [`reasoner_fallback_timeout_ms:${effectiveTimeoutMs}`],
            [`reasoner_fallback_model_failed:${fallbackModelConfig.debugModelId}`],
            fallbackResult.warnings,
          ),
        };
      }
    }

    const latencyMs = Date.now() - startedAt;

    if (!modelResult.plan) {
      await onCircuitFailure();
      return {
        fingerprint,
        telemetry: {
          mode: "deterministic",
          cacheHit: false,
          degraded: true,
          timeout: modelResult.timeout,
          timeoutMsUsed: effectiveTimeoutMs,
          adaptiveTimeoutApplied,
          latencyMs,
          error: modelResult.error ?? "reasoner_plan_empty",
          modelId: effectiveModelDebugId,
          warnings: modelResult.warnings,
          reasonerStage: "skipped",
          reasonerPlanSource: "deterministic_only",
          reasonerStageLatencyMs: modelResult.reasonerStageLatencyMs,
        },
      };
    }

    await sharedCache.setJson(
      cacheKey,
      {
        plan: modelResult.plan,
        modelId: effectiveModelDebugId,
        createdAt: Date.now(),
      } satisfies ReasonerCachePayload,
      mode === "pass2" ? PASS2_CACHE_TTL_SEC : CACHE_TTL_SEC,
    );

    await onCircuitSuccess();

    return {
      fingerprint,
      plan: modelResult.plan,
      telemetry: {
        mode: "opus",
        cacheHit: false,
        degraded: false,
        timeout: false,
        timeoutMsUsed: effectiveTimeoutMs,
        adaptiveTimeoutApplied,
        latencyMs,
        modelId: effectiveModelDebugId,
        warnings: modelResult.warnings,
        reasonerStage: modelResult.reasonerStage ?? (mode === "pass2" ? "pass2" : "expand"),
        reasonerPlanSource: modelResult.reasonerPlanSource ?? "llm_sketch+deterministic_expand",
        reasonerStageLatencyMs: modelResult.reasonerStageLatencyMs,
      },
    };
  } catch (error) {
    await onCircuitFailure();
    return {
      fingerprint,
      telemetry: {
        mode: "deterministic",
        cacheHit: false,
        degraded: true,
        timeout: false,
        timeoutMsUsed: timeoutMsUsed,
        adaptiveTimeoutApplied,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "reasoner_unexpected_error",
        modelId: modelConfig.debugModelId,
      },
    };
  } finally {
    inflightReasonerCalls = Math.max(0, inflightReasonerCalls - 1);
    await sharedCache.releaseLock(lockKey, lockOwner);
  }
}
