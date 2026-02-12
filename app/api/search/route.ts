import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { runPipelineSearch } from "@/lib/pipeline/engine";
import { runLegacySearch } from "@/lib/legacy/engine";
import { sharedCache } from "@/lib/cache/shared-cache";
import { SearchResponse } from "@/lib/types";

const DEFAULT_MAX_RESULTS = 20;
const DEBUG_BY_DEFAULT = process.env.PRECEDENT_DEBUG === "1";
const PIPELINE_V2_ENABLED = process.env.PIPELINE_V2 !== "0";
const SEARCH_RESULT_CACHE_TTL_SEC = Math.max(0, Number(process.env.SEARCH_RESULT_CACHE_TTL_SEC ?? "300"));
const SEARCH_RUNTIME_PROFILE = process.env.SEARCH_RUNTIME_PROFILE ?? "fast_balanced";
const SEARCH_CACHE_SCHEMA_VERSION = process.env.SEARCH_CACHE_SCHEMA_VERSION ?? "v6";
const SEARCH_IP_RATE_LIMIT = Math.max(0, Number(process.env.SEARCH_IP_RATE_LIMIT ?? "40"));
const SEARCH_IP_RATE_WINDOW_SEC = Math.max(10, Number(process.env.SEARCH_IP_RATE_WINDOW_SEC ?? "60"));
const SEARCH_INFLIGHT_WAIT_MS = Math.max(400, Number(process.env.SEARCH_INFLIGHT_WAIT_MS ?? "1400"));
const SEARCH_INFLIGHT_LOCK_TTL_SEC = Math.max(4, Number(process.env.SEARCH_INFLIGHT_LOCK_TTL_SEC ?? "20"));

function normalizedQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function searchCacheKey(query: string, maxResults: number): string {
  const policySeed = [
    SEARCH_CACHE_SCHEMA_VERSION,
    process.env.PROPOSITION_V3 ?? "1",
    process.env.PROPOSITION_V41 ?? "1",
    process.env.PROPOSITION_V5 ?? "1",
    process.env.STRICT_HIGH_CONFIDENCE_ONLY ?? "1",
    process.env.STRICT_INTERSECTION_REQUIRED_WHEN_MULTIHOOK ?? "1",
    process.env.PROVISIONAL_CONFIDENCE_CAP ?? "0.70",
    process.env.NEARMISS_CONFIDENCE_CAP ?? "0.50",
    SEARCH_RUNTIME_PROFILE,
  ].join("|");
  const digest = createHash("sha256")
    .update(`${normalizedQuery(query)}|${maxResults}|${policySeed}`)
    .digest("hex")
    .slice(0, 32);
  return `search:${SEARCH_CACHE_SCHEMA_VERSION}:${digest}`;
}

function successfulAttemptCount(response: SearchResponse): number {
  const phaseSuccesses = response.pipelineTrace?.retrieval.phaseSuccesses;
  if (!phaseSuccesses) return 0;
  return Object.values(phaseSuccesses).reduce((sum, value) => sum + value, 0);
}

function clientIpHash(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const firstForwarded = forwarded.split(",")[0]?.trim();
  const realIp = req.headers.get("x-real-ip")?.trim();
  const fallback = "unknown";
  const ip = firstForwarded || realIp || fallback;
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

async function enforceIpRateLimit(ipHash: string): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  if (SEARCH_IP_RATE_LIMIT <= 0) return { allowed: true };

  const bucket = Math.floor(Date.now() / (SEARCH_IP_RATE_WINDOW_SEC * 1000));
  const key = `search:rl:${bucket}:${ipHash}`;
  const count = await sharedCache.increment(key, SEARCH_IP_RATE_WINDOW_SEC + 2);
  if (count > SEARCH_IP_RATE_LIMIT) {
    return {
      allowed: false,
      retryAfterMs: SEARCH_IP_RATE_WINDOW_SEC * 1000,
    };
  }
  return { allowed: true };
}

async function waitForInflightCache(
  cacheKey: string,
  timeoutMs: number,
): Promise<{ response: SearchResponse } | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const cached = await sharedCache.getJson<{ response: SearchResponse }>(cacheKey);
    if (cached?.response) return cached;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

function withRoutingAndTiming(response: SearchResponse, input: {
  decision: "client_first" | "server_fallback" | "server_only";
  reason: string;
  stageMs: Record<string, number>;
}): SearchResponse {
  return {
    ...response,
    executionPath: input.decision,
    clientDirectAttempted: response.clientDirectAttempted ?? false,
    clientDirectSucceeded: response.clientDirectSucceeded ?? false,
    partialRun: response.partialRun ?? Boolean(response.pipelineTrace?.scheduler.partialDueToLatency),
    pipelineTrace: response.pipelineTrace
      ? {
          ...response.pipelineTrace,
          routing: {
            decision: input.decision,
            reason: input.reason,
            clientProbe: response.pipelineTrace.routing?.clientProbe,
          },
          timing: {
            stageMs: {
              ...(response.pipelineTrace.timing?.stageMs ?? {}),
              ...input.stageMs,
            },
          },
        }
      : response.pipelineTrace,
  };
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let lockKey: string | null = null;
  let lockOwner: string | null = null;
  let lockAcquired = false;

  try {
    const body = (await req.json()) as {
      query?: string;
      maxResults?: number;
      debug?: boolean;
    };

    const query = body.query?.trim() ?? "";
    const maxResults = Math.min(Math.max(body.maxResults ?? DEFAULT_MAX_RESULTS, 5), 40);
    const debugEnabled = body.debug ?? DEBUG_BY_DEFAULT;
    const ipHash = clientIpHash(req);

    if (!query || query.length < 12) {
      return NextResponse.json(
        { error: "Please enter a fuller fact scenario (minimum ~12 characters)." },
        { status: 400 },
      );
    }

    if (!debugEnabled) {
      const rate = await enforceIpRateLimit(ipHash);
      if (!rate.allowed) {
        return NextResponse.json(
          {
            error: "Too many requests from this client. Please retry shortly.",
            retryAfterMs: rate.retryAfterMs,
          },
          { status: 429 },
        );
      }
    }

    const cacheKey = searchCacheKey(query, maxResults);
    if (PIPELINE_V2_ENABLED && !debugEnabled && SEARCH_RESULT_CACHE_TTL_SEC > 0) {
      const cached = await sharedCache.getJson<{ response: SearchResponse }>(cacheKey);
      if (cached?.response) {
        const cachedNotes = [
          ...(cached.response.notes ?? []),
          `Served from response cache (${SEARCH_CACHE_SCHEMA_VERSION}).`,
        ];
        const cachedResponse = withRoutingAndTiming(
          {
            ...cached.response,
            requestId,
            notes: cachedNotes,
            pipelineTrace: cached.response.pipelineTrace
              ? {
                  ...cached.response.pipelineTrace,
                  classification: {
                    ...cached.response.pipelineTrace.classification,
                    cacheReplayGuardApplied: true,
                  },
                }
              : cached.response.pipelineTrace,
          },
          {
            decision: "server_only",
            reason: "cache_hit",
            stageMs: { total: Math.max(1, Date.now() - startedAt) },
          },
        );
        return NextResponse.json(cachedResponse);
      }

      lockKey = `lock:${cacheKey}`;
      lockOwner = requestId;
      lockAcquired = await sharedCache.acquireLock(lockKey, lockOwner, SEARCH_INFLIGHT_LOCK_TTL_SEC);

      if (!lockAcquired) {
        const inflightCached = await waitForInflightCache(cacheKey, SEARCH_INFLIGHT_WAIT_MS);
        if (inflightCached?.response) {
          const notes = [
            ...(inflightCached.response.notes ?? []),
            "Served from in-flight coalesced cache.",
          ];
          const inflightResponse = withRoutingAndTiming(
            {
              ...inflightCached.response,
              requestId,
              notes,
              pipelineTrace: inflightCached.response.pipelineTrace
                ? {
                    ...inflightCached.response.pipelineTrace,
                    classification: {
                      ...inflightCached.response.pipelineTrace.classification,
                      cacheReplayGuardApplied: true,
                    },
                  }
                : inflightCached.response.pipelineTrace,
            },
            {
              decision: "server_only",
              reason: "inflight_cache_wait",
              stageMs: { total: Math.max(1, Date.now() - startedAt) },
            },
          );
          return NextResponse.json(inflightResponse);
        }
      }
    }

    const runStartedAt = Date.now();
    const result = PIPELINE_V2_ENABLED
      ? await runPipelineSearch({
          query,
          maxResults,
          requestId,
          debugEnabled,
          cooldownScope: `ip:${ipHash}`,
        })
      : await runLegacySearch({
          query,
          maxResults,
          requestId,
          debugEnabled,
        });

    const isBlockedRun = result.response.pipelineTrace?.scheduler.stopReason === "blocked";
    const sourceSuccessCount = successfulAttemptCount(result.response);
    const canWriteCache = !isBlockedRun && sourceSuccessCount > 0;
    if (isBlockedRun) {
      console.warn(
        `[search:${requestId}] blocked ip=${ipHash} reason=${result.response.pipelineTrace?.scheduler.blockedReason ?? "unknown"} kind=${
          result.response.pipelineTrace?.scheduler.blockedKind ?? "unknown"
        } retryAfterMs=${result.response.pipelineTrace?.scheduler.retryAfterMs ?? 0}`,
      );
    } else {
      console.info(
        `[search:${requestId}] completed ip=${ipHash} stop=${result.response.pipelineTrace?.scheduler.stopReason ?? "completed"} fetched=${
          result.response.totalFetched
        } exact=${(result.response.casesExact ?? result.response.cases).length}`,
      );
    }

    const responsePayload = withRoutingAndTiming(
      {
        requestId: result.response.requestId ?? requestId,
        ...result.response,
        notes: result.response.notes,
      },
      {
        decision: "server_only",
        reason: "server_pipeline",
        stageMs: {
          pipeline: Math.max(1, Date.now() - runStartedAt),
          total: Math.max(1, Date.now() - startedAt),
        },
      },
    );

    if (PIPELINE_V2_ENABLED && !debugEnabled && SEARCH_RESULT_CACHE_TTL_SEC > 0 && canWriteCache) {
      const cachePayload = {
        response: {
          ...responsePayload,
          requestId,
        },
      };
      await sharedCache.setJson(cacheKey, cachePayload, SEARCH_RESULT_CACHE_TTL_SEC);
    }

    return NextResponse.json({
      ...responsePayload,
      debug: debugEnabled ? result.debug : undefined,
    });
  } catch (error) {
    console.error(`[search:${requestId}] fatal`, error);
    return NextResponse.json(
      {
        error: "Search failed. Source may be unavailable or blocked.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  } finally {
    if (lockKey && lockOwner && lockAcquired) {
      await sharedCache.releaseLock(lockKey, lockOwner);
    }
  }
}
