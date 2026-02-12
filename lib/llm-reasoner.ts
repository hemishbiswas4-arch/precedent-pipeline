import { randomUUID, createHash } from "crypto";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { getBedrockClient, getBedrockModelConfig } from "@/lib/bedrock-client";
import { sharedCache } from "@/lib/cache/shared-cache";
import { ContextProfile } from "@/lib/types";
import { isUsableReasonerPlan, ReasonerPlan, validateReasonerPlan } from "@/lib/reasoner-schema";

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
};

export type ReasonerExecution = {
  plan?: ReasonerPlan;
  telemetry: ReasonerTelemetry;
  fingerprint: string;
};

export type ReasonerMode = "pass1" | "pass2";

let inflightReasonerCalls = 0;

const MODE = (process.env.LLM_REASONER_MODE ?? "initial").toLowerCase();
const TIMEOUT_MS = Math.max(200, Number(process.env.LLM_REASONER_TIMEOUT_MS ?? "1500"));
const MAX_TIMEOUT_MS = Math.max(TIMEOUT_MS, Number(process.env.LLM_REASONER_MAX_TIMEOUT_MS ?? "2400"));
const MAX_TOKENS = Math.max(100, Number(process.env.LLM_REASONER_MAX_TOKENS ?? "450"));
const MAX_CALLS_PER_REQUEST = Math.max(0, Number(process.env.LLM_REASONER_MAX_CALLS_PER_REQUEST ?? "2"));
const CACHE_TTL_SEC = Math.max(60, Number(process.env.LLM_REASONER_CACHE_TTL_SEC ?? "21600"));
const PASS2_CACHE_TTL_SEC = Math.max(60, Number(process.env.LLM_REASONER_PASS2_CACHE_TTL_SEC ?? "900"));
const CIRCUIT_ENABLED = (process.env.LLM_CIRCUIT_BREAKER_ENABLED ?? "1") !== "0";
const CIRCUIT_FAIL_THRESHOLD = Math.max(1, Number(process.env.LLM_CIRCUIT_FAIL_THRESHOLD ?? "5"));
const CIRCUIT_COOLDOWN_MS = Math.max(1_000, Number(process.env.LLM_CIRCUIT_COOLDOWN_MS ?? "30000"));
const LOCAL_MAX_INFLIGHT = Math.max(1, Number(process.env.LLM_REASONER_MAX_INFLIGHT ?? "4"));
const GLOBAL_RATE_LIMIT = Math.max(0, Number(process.env.LLM_REASONER_GLOBAL_RATE_LIMIT ?? "0"));
const GLOBAL_RATE_WINDOW_SEC = Math.max(5, Number(process.env.LLM_REASONER_GLOBAL_RATE_WINDOW_SEC ?? "60"));
const LOCK_TTL_SEC = Math.max(2, Math.ceil(TIMEOUT_MS / 1000) + 2);
const LOCK_WAIT_MS = Math.max(100, Number(process.env.LLM_REASONER_LOCK_WAIT_MS ?? "250"));
const FORCE_PASS1_ATTEMPT = (process.env.LLM_REASONER_FORCE_PASS1_ATTEMPT ?? "1") !== "0";
const RETRY_ON_TIMEOUT_ENABLED = (process.env.LLM_REASONER_RETRY_ON_TIMEOUT ?? "1") !== "0";
const RETRY_TIMEOUT_BONUS_MS = Math.max(200, Number(process.env.LLM_REASONER_RETRY_TIMEOUT_BONUS_MS ?? "800"));

const CIRCUIT_KEY = "reasoner:circuit:v1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
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

function promptForReasoner(query: string, context: ContextProfile): string {
  return JSON.stringify({
    query,
    context,
    output_schema: {
      proposition: {
        actors: ["..."],
        proceeding: ["..."],
        legal_hooks: ["..."],
        outcome_required: ["..."],
        outcome_negative: ["..."],
        jurisdiction_hint: "SC|HC|ANY",
        hook_groups: [
          {
            group_id: "hook_group_1",
            terms: ["..."],
            min_match: 1,
            required: true,
          },
        ],
        relations: [
          {
            type: "requires|applies_to|interacts_with|excluded_by",
            left_group_id: "hook_group_1",
            right_group_id: "hook_group_2",
            required: true,
          },
        ],
        outcome_constraint: {
          polarity: "required|not_required|allowed|refused|dismissed|quashed|unknown",
          modality: "mandatory|optional",
          terms: ["..."],
          contradiction_terms: ["..."],
        },
        interaction_required: false,
      },
      must_have_terms: ["..."],
      must_not_have_terms: ["..."],
      query_variants_strict: ["..."],
      query_variants_broad: ["..."],
      case_anchors: ["..."],
    },
    constraints: [
      "Return strict JSON only. No markdown.",
      "No search operators like doctypes:, sortby:, fromdate:, todate:.",
      "No conversational wrappers like 'cases where' or 'find cases'.",
      "Strict variants must keep actor + proceeding + required outcome.",
      "If legal hooks exist (sections/statutes/articles), include them in strict variants.",
      "When multiple legal hooks interact doctrinally, emit hook_groups and mark interaction_required=true.",
      "Do not collapse distinct hook groups into generic terms (for example 'crpc' alone).",
      "Set outcome_constraint polarity explicitly. Do not use generic outcome tokens only.",
      "Broad variants should still be legal-contextual and concise.",
      "Keep each variant under 14 tokens.",
    ],
  });
}

function promptForPass2Reasoner(input: {
  query: string;
  context: ContextProfile;
  basePlan: ReasonerPlan;
  snippets: string[];
}): string {
  return JSON.stringify({
    query: input.query,
    context: input.context,
    base_plan: input.basePlan,
    snippets: input.snippets.slice(0, 10),
    task: "Refine proposition constraints and retrieval variants using snippet evidence.",
    output_schema: {
      proposition: {
        actors: ["..."],
        proceeding: ["..."],
        legal_hooks: ["..."],
        outcome_required: ["..."],
        outcome_negative: ["..."],
        jurisdiction_hint: "SC|HC|ANY",
        hook_groups: [
          {
            group_id: "hook_group_1",
            terms: ["..."],
            min_match: 1,
            required: true,
          },
        ],
        relations: [
          {
            type: "requires|applies_to|interacts_with|excluded_by",
            left_group_id: "hook_group_1",
            right_group_id: "hook_group_2",
            required: true,
          },
        ],
        outcome_constraint: {
          polarity: "required|not_required|allowed|refused|dismissed|quashed|unknown",
          modality: "mandatory|optional",
          terms: ["..."],
          contradiction_terms: ["..."],
        },
        interaction_required: false,
      },
      must_have_terms: ["..."],
      must_not_have_terms: ["..."],
      query_variants_strict: ["..."],
      query_variants_broad: ["..."],
      case_anchors: ["..."],
    },
    constraints: [
      "Return strict JSON only. No markdown.",
      "Do not weaken the required legal proposition. Tighten it when snippets show drift.",
      "Strict variants must include proposition axes: actor, proceeding/posture, required outcome, and legal hooks when present.",
      "If the proposition requires legal-hook intersection, preserve all required hook groups in strict variants.",
      "Add contradictions to outcome_negative (for example allowed/condoned/restored when query requires refusal).",
      "Set outcome_constraint polarity and contradictions explicitly.",
      "Keep each query variant under 14 tokens.",
    ],
  });
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
  query: string;
  context: ContextProfile;
  modelId: string;
  timeoutMs: number;
  basePlan?: ReasonerPlan;
  snippets?: string[];
}): Promise<{ plan?: ReasonerPlan; warnings: string[]; timeout: boolean; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const command = new ConverseCommand({
      modelId: input.modelId,
      system: [
        {
          text: [
            "You are a legal proposition planner for Indian case retrieval.",
            "Return strict JSON only with the required schema.",
            "Do not return explanations or markdown.",
          ].join(" "),
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              text:
                input.mode === "pass2" && input.basePlan
                  ? promptForPass2Reasoner({
                      query: input.query,
                      context: input.context,
                      basePlan: input.basePlan,
                      snippets: input.snippets ?? [],
                    })
                  : promptForReasoner(input.query, input.context),
            },
          ],
        },
      ],
      inferenceConfig: {
        temperature: 0,
        maxTokens: MAX_TOKENS,
      },
    });

    const response = await getBedrockClient().send(command, {
      abortSignal: controller.signal,
    });

    const text = (response.output?.message?.content ?? [])
      .flatMap((block) => ("text" in block && typeof block.text === "string" ? [block.text] : []))
      .join("\n")
      .trim();

    if (!text) {
      return {
        warnings: ["reasoner returned empty response"],
        timeout: false,
        error: "reasoner_empty_response",
      };
    }

    const parsed = safeJsonParse(text);
    if (!parsed) {
      return {
        warnings: ["reasoner returned non-JSON payload"],
        timeout: false,
        error: "reasoner_unparseable_json",
      };
    }

    const validated = validateReasonerPlan(parsed);
    if (!isUsableReasonerPlan(validated.plan)) {
      return {
        warnings: validated.warnings,
        timeout: false,
        error: "reasoner_plan_not_usable",
      };
    }
    return {
      plan: validated.plan,
      warnings: validated.warnings,
      timeout: false,
    };
  } catch (error) {
    if (error instanceof Error && /abort/i.test(error.name)) {
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
    let effectiveTimeoutMs = timeoutMsUsed;
    let modelResult = await invokeReasonerModel({
      mode,
      query: input.query,
      context: input.context,
      modelId: modelConfig.modelId,
      timeoutMs: timeoutMsUsed,
      basePlan: input.basePlan,
      snippets: input.snippets,
    });

    if (
      !modelResult.plan &&
      modelResult.timeout &&
      mode === "pass1" &&
      RETRY_ON_TIMEOUT_ENABLED &&
      timeoutMsUsed < MAX_TIMEOUT_MS
    ) {
      const retryTimeoutMs = Math.min(MAX_TIMEOUT_MS, timeoutMsUsed + RETRY_TIMEOUT_BONUS_MS);
      const retryResult = await invokeReasonerModel({
        mode,
        query: input.query,
        context: input.context,
        modelId: modelConfig.modelId,
        timeoutMs: retryTimeoutMs,
        basePlan: input.basePlan,
        snippets: input.snippets,
      });
      effectiveTimeoutMs = retryTimeoutMs;
      if (retryResult.plan) {
        modelResult = {
          ...retryResult,
          warnings: mergeWarnings(modelResult.warnings, ["reasoner_timeout_retry_success"], retryResult.warnings),
        };
      } else {
        modelResult = {
          ...retryResult,
          warnings: mergeWarnings(modelResult.warnings, ["reasoner_timeout_retry_failed"], retryResult.warnings),
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
          modelId: modelConfig.debugModelId,
          warnings: modelResult.warnings,
        },
      };
    }

    await sharedCache.setJson(
      cacheKey,
      {
        plan: modelResult.plan,
        modelId: modelConfig.debugModelId,
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
        modelId: modelConfig.debugModelId,
        warnings: modelResult.warnings,
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
