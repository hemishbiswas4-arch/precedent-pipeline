import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { sharedCache } from "@/lib/cache/shared-cache";
import { runOpusReasoner } from "@/lib/llm-reasoner";
import { buildIntentProfile } from "@/lib/pipeline/intent";
import { planDeterministicQueryVariants } from "@/lib/pipeline/planner";
import { buildPropositionChecklist } from "@/lib/proposition-gate";

const PIPELINE_MAX_ELAPSED_MS = Math.min(
  Math.max(Number(process.env.PIPELINE_MAX_ELAPSED_MS ?? "9000"), 5_000),
  60_000,
);
const DEFAULT_VERIFY_LIMIT = Math.max(4, Number(process.env.DEFAULT_VERIFY_LIMIT ?? "8"));
const DEFAULT_GLOBAL_BUDGET = Math.max(4, Number(process.env.DEFAULT_GLOBAL_BUDGET ?? "8"));
const IK_FETCH_TIMEOUT_MS = Math.max(1_200, Number(process.env.IK_FETCH_TIMEOUT_MS ?? "3000"));
const CLIENT_DIRECT_RETRIEVAL_ENABLED = (process.env.CLIENT_DIRECT_RETRIEVAL_ENABLED ?? "1") !== "0";
const CLIENT_DIRECT_STRICT_VARIANT_LIMIT = Math.max(
  1,
  Number(process.env.CLIENT_DIRECT_STRICT_VARIANT_LIMIT ?? "2"),
);
const CLIENT_DIRECT_PROBE_TTL_MS = Math.max(
  60_000,
  Number(process.env.CLIENT_DIRECT_PROBE_TTL_MS ?? process.env.NEXT_PUBLIC_CLIENT_DIRECT_PROBE_TTL_MS ?? "1800000"),
);
const SEARCH_IP_RATE_LIMIT = Math.max(0, Number(process.env.SEARCH_IP_RATE_LIMIT ?? "40"));
const SEARCH_IP_RATE_WINDOW_SEC = Math.max(10, Number(process.env.SEARCH_IP_RATE_WINDOW_SEC ?? "60"));

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return fallback;
}

function applyPropositionMode(checklist: ReturnType<typeof buildPropositionChecklist>) {
  const propositionV3Enabled = parseBooleanEnv(process.env.PROPOSITION_V3, true);
  const propositionV5Enabled = parseBooleanEnv(process.env.PROPOSITION_V5, true);

  if (propositionV3Enabled) {
    if (propositionV5Enabled) return checklist;
    return {
      ...checklist,
      graph: undefined,
    };
  }
  return {
    ...checklist,
    hookGroups: checklist.hookGroups.map((group) => ({
      ...group,
      required: false,
    })),
    relations: [],
    interactionRequired: false,
    graph: propositionV5Enabled ? checklist.graph : undefined,
  };
}

function clientIpHash(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const firstForwarded = forwarded.split(",")[0]?.trim();
  const realIp = req.headers.get("x-real-ip")?.trim();
  const ip = firstForwarded || realIp || "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

async function enforceIpRateLimit(req: NextRequest): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  if (SEARCH_IP_RATE_LIMIT <= 0) return { allowed: true };

  const bucket = Math.floor(Date.now() / (SEARCH_IP_RATE_WINDOW_SEC * 1000));
  const key = `search:plan:rl:${bucket}:${clientIpHash(req)}`;
  const count = await sharedCache.increment(key, SEARCH_IP_RATE_WINDOW_SEC + 2);
  if (count > SEARCH_IP_RATE_LIMIT) {
    return {
      allowed: false,
      retryAfterMs: SEARCH_IP_RATE_WINDOW_SEC * 1000,
    };
  }
  return { allowed: true };
}

export async function POST(req: NextRequest) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const body = (await req.json()) as {
      query?: string;
      maxResults?: number;
      debug?: boolean;
    };

    const query = body.query?.trim() ?? "";
    const maxResults = Math.min(Math.max(body.maxResults ?? 20, 5), 40);
    const debugEnabled = body.debug ?? false;
    if (!query || query.length < 12) {
      return NextResponse.json(
        { error: "Please enter a fuller fact scenario (minimum ~12 characters)." },
        { status: 400 },
      );
    }

    if (!debugEnabled) {
      const rate = await enforceIpRateLimit(req);
      if (!rate.allowed) {
        return NextResponse.json(
          {
            error: "Too many planning requests from this client. Please retry shortly.",
            retryAfterMs: rate.retryAfterMs,
          },
          { status: 429 },
        );
      }
    }

    const intent = buildIntentProfile(query);
    const reasoner = await runOpusReasoner({
      mode: "pass1",
      query,
      cleanedQuery: intent.cleanedQuery,
      context: intent.context,
      requestCallIndex: 0,
    });

    const planner = await planDeterministicQueryVariants(intent, reasoner.plan);
    const checklist = applyPropositionMode(
      buildPropositionChecklist({
        context: intent.context,
        cleanedQuery: intent.cleanedQuery,
        reasonerPlan: reasoner.plan,
      }),
    );

    const strictVariants = planner.variants
      .filter((variant) => variant.strictness === "strict")
      .slice(0, Math.max(CLIENT_DIRECT_STRICT_VARIANT_LIMIT + 2, 8));

    return NextResponse.json({
      requestId,
      query,
      cleanedQuery: intent.cleanedQuery,
      context: intent.context,
      proposition: {
        requiredElements: checklist.requiredElements,
        optionalElements: checklist.optionalElements,
        constraints: {
          hookGroups: checklist.hookGroups.map((group) => ({
            groupId: group.groupId,
            label: group.label,
            required: group.required,
            minMatch: group.minMatch,
          })),
          relations: checklist.relations.map((relation) => ({
            relationId: relation.relationId,
            type: relation.type,
            leftGroupId: relation.leftGroupId,
            rightGroupId: relation.rightGroupId,
            required: relation.required,
          })),
          outcomeConstraint: {
            polarity: checklist.outcomeConstraint.polarity,
            required: checklist.outcomeConstraint.required,
          },
          interactionRequired: checklist.interactionRequired,
        },
      },
      planner: {
        source: planner.plannerSource,
        modelId: planner.plannerModelId,
        error: planner.plannerError ?? reasoner.telemetry.error,
        reasonerMode: reasoner.telemetry.mode,
        reasonerDegraded: reasoner.telemetry.degraded,
      },
      queryPlan: {
        strictVariants,
        fallbackVariants: planner.variants.filter((variant) => variant.phase !== "primary").slice(0, 16),
      },
      keywordPack: planner.keywordPack,
      runtime: {
        profile: process.env.SEARCH_RUNTIME_PROFILE ?? "fast_balanced",
        maxElapsedMs: PIPELINE_MAX_ELAPSED_MS,
        verifyLimit: DEFAULT_VERIFY_LIMIT,
        globalBudget: DEFAULT_GLOBAL_BUDGET,
        fetchTimeoutMs: IK_FETCH_TIMEOUT_MS,
        maxResults,
      },
      clientRetrieval: {
        enabled: CLIENT_DIRECT_RETRIEVAL_ENABLED,
        strictVariantLimit: CLIENT_DIRECT_STRICT_VARIANT_LIMIT,
        probeTtlMs: CLIENT_DIRECT_PROBE_TTL_MS,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to generate search plan.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
