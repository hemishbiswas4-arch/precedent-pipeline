import { NextRequest, NextResponse } from "next/server";
import { IkApiClientError, IndianKanoonApiClient } from "@/lib/ingestion/ik-api-client";

export const runtime = "nodejs";

function parseTimeoutMs(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get("timeoutMs");
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return Math.max(1_500, Number(process.env.IK_HEALTH_TIMEOUT_MS ?? "6500"));
  }
  return Math.max(1_500, Math.min(Math.floor(parsed), 12_000));
}

function parseProbeQuery(req: NextRequest): string {
  const raw = req.nextUrl.searchParams.get("query")?.trim();
  if (raw) return raw.slice(0, 180);
  return "state petition against discharge rejected";
}

function inferHint(input: {
  status?: number;
  error?: string;
  detail?: string;
  endpoint?: string;
}): string | undefined {
  const error = `${input.error ?? ""} ${input.detail ?? ""}`.toLowerCase();
  if (input.status === 401 || input.status === 403) {
    return "IK API authentication/ACL failed. Verify IK_API_KEY entitlement and any source-IP restrictions.";
  }
  if (input.status === 429) {
    return "IK API rate limit hit. Retry after cooldown or reduce request rate.";
  }
  if (input.status === 503) {
    return "IK API is temporarily unavailable. Retry shortly.";
  }
  if (error.includes("ik_api_base_url missing")) {
    return "Set IK_API_BASE_URL in server environment.";
  }
  if (error.includes("ik_api_key missing")) {
    return "Set IK_API_KEY in server environment.";
  }
  if (error.includes("aborted") || error.includes("timeout")) {
    return "IK probe timed out. Increase IK_HEALTH_TIMEOUT_MS and retry.";
  }
  if (input.endpoint) {
    return `IK API ${input.endpoint} probe failed.`;
  }
  return undefined;
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const timeoutMs = parseTimeoutMs(req);
  const baseUrl = process.env.IK_API_BASE_URL?.trim() || "unknown";
  const query = parseProbeQuery(req);

  if (!IndianKanoonApiClient.isConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        baseUrl,
        timeoutMs,
        error: "ik_health_not_configured",
        hint: "Set IK_API_BASE_URL and IK_API_KEY in server environment.",
      },
      { status: 500 },
    );
  }

  let client: IndianKanoonApiClient;
  try {
    client = new IndianKanoonApiClient({
      timeoutMs,
      maxRetries: 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ik_health_client_init_failed";
    return NextResponse.json(
      {
        ok: false,
        baseUrl,
        timeoutMs,
        error: message,
        hint: inferHint({ error: message }),
      },
      { status: 500 },
    );
  }

  try {
    const result = await client.search({
      formInput: query,
      pagenum: 0,
      maxpages: 1,
      doctypes: "supremecourt,highcourts,tribunals",
      maxcites: 1,
    });

    return NextResponse.json({
      ok: true,
      baseUrl,
      status: result.status,
      latencyMs: Date.now() - startedAt,
      timeoutMs,
      rows: result.rows.length,
      found: result.found,
      query,
    });
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    if (error instanceof IkApiClientError) {
      const status = error.status > 0 ? error.status : 502;
      return NextResponse.json(
        {
          ok: false,
          baseUrl,
          status: error.status,
          latencyMs: elapsedMs,
          timeoutMs,
          endpoint: error.endpoint,
          retryAfterMs: error.retryAfterMs,
          detail: error.detail,
          error: error.message,
          hint: inferHint({
            status: error.status,
            error: error.message,
            detail: error.detail,
            endpoint: error.endpoint,
          }),
        },
        { status },
      );
    }

    const message = error instanceof Error ? error.message : "ik_health_failed";
    return NextResponse.json(
      {
        ok: false,
        baseUrl,
        status: 502,
        latencyMs: elapsedMs,
        timeoutMs,
        error: message,
        hint: inferHint({ error: message }),
      },
      { status: 502 },
    );
  }
}
