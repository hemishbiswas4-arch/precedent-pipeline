import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { sharedCache } from "@/lib/cache/shared-cache";
import { finalizeFromCandidates } from "@/lib/pipeline/finalize";
import { CaseCandidate, CourtLevel } from "@/lib/types";

const MAX_RAW_CANDIDATES = 120;
const SEARCH_IP_RATE_LIMIT = Math.max(0, Number(process.env.SEARCH_IP_RATE_LIMIT ?? "40"));
const SEARCH_IP_RATE_WINDOW_SEC = Math.max(10, Number(process.env.SEARCH_IP_RATE_WINDOW_SEC ?? "60"));

function normalizeCourt(value: unknown): CourtLevel {
  if (value === "SC" || value === "HC" || value === "UNKNOWN") return value;
  return "UNKNOWN";
}

function safeString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function allowedIndianKanoonUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/^(https?):$/.test(parsed.protocol)) return false;
    if (!/(^|\.)indiankanoon\.org$/i.test(parsed.hostname)) return false;
    return /\/doc(?:fragment)?\/\d+\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function sanitizeRawCandidates(raw: unknown): CaseCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: CaseCandidate[] = [];

  for (const item of raw.slice(0, MAX_RAW_CANDIDATES)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const url = safeString(record.url, 600);
    if (!allowedIndianKanoonUrl(url)) continue;

    const title = safeString(record.title, 500);
    const snippet = safeString(record.snippet, 1800);

    if (!title && !snippet) continue;

    out.push({
      source: "indiankanoon",
      title: title || "Untitled case",
      url,
      snippet,
      court: normalizeCourt(record.court),
      courtText: safeString(record.courtText, 600) || undefined,
      citesCount:
        typeof record.citesCount === "number" && Number.isFinite(record.citesCount)
          ? Math.max(0, Math.floor(record.citesCount))
          : undefined,
      citedByCount:
        typeof record.citedByCount === "number" && Number.isFinite(record.citedByCount)
          ? Math.max(0, Math.floor(record.citedByCount))
          : undefined,
      author: safeString(record.author, 120) || undefined,
      fullDocumentUrl: safeString(record.fullDocumentUrl, 600) || url,
    });
  }

  return out;
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
  const key = `search:finalize:rl:${bucket}:${clientIpHash(req)}`;
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
      executionPath?: "client_first" | "server_fallback" | "server_only";
      clientDirectAttempted?: boolean;
      clientDirectSucceeded?: boolean;
      blockedKind?: "local_cooldown" | "cloudflare_challenge" | "rate_limit" | "cors";
      retryAfterMs?: number;
      routingReason?: string;
      clientProbe?: string;
      stageTimings?: Record<string, number>;
      rawCandidates?: unknown;
      debugDiagnostics?: {
        sourceAttempts?: Array<Record<string, unknown>>;
      };
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
            error: "Too many finalize requests from this client. Please retry shortly.",
            retryAfterMs: rate.retryAfterMs,
          },
          { status: 429 },
        );
      }
    }

    const candidates = sanitizeRawCandidates(body.rawCandidates);
    if (candidates.length === 0 && !body.blockedKind) {
      return NextResponse.json(
        {
          error: "No valid client candidates were provided for finalize.",
        },
        { status: 400 },
      );
    }

    const response = await finalizeFromCandidates({
      query,
      maxResults,
      requestId,
      candidates,
      executionPath: body.executionPath ?? "client_first",
      clientDirectAttempted: body.clientDirectAttempted,
      clientDirectSucceeded: body.clientDirectSucceeded,
      blockedKind: body.blockedKind,
      retryAfterMs: body.retryAfterMs,
      routingReason: body.routingReason ?? "client_finalize",
      clientProbe: body.clientProbe,
      stageTimings: body.stageTimings,
      debugDiagnostics: body.debugDiagnostics,
    });

    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to finalize candidate ranking.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
