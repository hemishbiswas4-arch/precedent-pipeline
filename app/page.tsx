"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  clearSessionRuns,
  loadSessionRuns,
  saveSessionRun,
  summarizeSessionRuns,
  type SessionRunMetric,
} from "@/lib/client-analytics";
import { evaluateQueryCoach } from "@/lib/query-coach";
import { NearMissCase, ScoredCase, SearchResponse } from "@/lib/types";
import { HeroHeader } from "@/app/components/consumer/HeroHeader";
import { SearchComposer } from "@/app/components/consumer/SearchComposer";
import { QueryCoachDropdown } from "@/app/components/consumer/QueryCoachDropdown";
import { ResearchSummary } from "@/app/components/consumer/ResearchSummary";
import { ResultModeBanner } from "@/app/components/consumer/ResultModeBanner";
import { CaseResultCard } from "@/app/components/consumer/CaseResultCard";
import { NearMissPanel } from "@/app/components/consumer/NearMissPanel";
import { AdvancedDrawer } from "@/app/components/consumer/AdvancedDrawer";
import {
  BedrockHealthResponse,
  DebugPayload,
  ResearchSummaryStats,
  ResultMode,
} from "@/app/components/consumer/types";

const INITIAL_QUERY =
  "";
const REQUEST_TIMEOUT_MS = Math.max(
  45_000,
  Number(process.env.NEXT_PUBLIC_SEARCH_TIMEOUT_MS ?? "90000"),
);

type ThemeMode = "light" | "dark";

function LoadingSkeleton() {
  return (
    <section className="surface-panel reveal-up" aria-live="polite">
      <h2>Running retrieval pipeline...</h2>
      <div className="skeleton-grid">
        <div className="skeleton-card" />
        <div className="skeleton-card" />
        <div className="skeleton-card" />
      </div>
    </section>
  );
}

async function postJsonWithTimeout<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const json = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(json.error || `Request failed (${response.status})`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function getJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    const json = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(json.error || `Request failed (${response.status})`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function deriveResultMode(data: SearchResponse | null, exactCases: ScoredCase[], nearMissCases: NearMissCase[]): ResultMode {
  if (!data) return "empty";
  if (data.status === "blocked") return "blocked";
  if (data.status === "partial" || data.partialRun || data.pipelineTrace?.scheduler.partialDueToLatency) {
    return "partial";
  }
  if (exactCases.length > 0) return "exact";
  if (nearMissCases.length > 0) return "best_available";
  return "empty";
}

function emptyStateMessage(data: SearchResponse, nearMissCount: number): string {
  if (data.status === "blocked") {
    return "Source access is temporarily blocked or throttled. Retry after cooldown to continue retrieval.";
  }
  if (data.status === "partial") {
    return "Run ended due to runtime budget before all exact matches were verified. Retry to continue.";
  }
  if (nearMissCount > 0) {
    return "No exact proposition matches were verified yet. Closest matches are listed below with missing elements.";
  }
  return "No court-filtered matches were found. Add clearer actor, proceeding, and outcome cues to improve precision.";
}

export default function Home() {
  const [query, setQuery] = useState(INITIAL_QUERY);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [debugData, setDebugData] = useState<DebugPayload | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestStatus, setRequestStatus] = useState("");
  const [sessionRuns, setSessionRuns] = useState<SessionRunMetric[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [enableDebugDiagnostics, setEnableDebugDiagnostics] = useState(false);
  const [bedrockHealth, setBedrockHealth] = useState<BedrockHealthResponse | null>(null);
  const [bedrockChecking, setBedrockChecking] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("light");

  useEffect(() => {
    setSessionRuns(loadSessionRuns());
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const stored = localStorage.getItem("pf_theme");
    const nextTheme: ThemeMode =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    root.dataset.theme = nextTheme;
    setTheme(nextTheme);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pf_theme", theme);
  }, [theme]);

  async function runBedrockHealthCheck() {
    setBedrockChecking(true);
    try {
      const requestedTimeoutMs = 9000;
      const result = await getJsonWithTimeout<BedrockHealthResponse>(
        `/api/health/bedrock?timeoutMs=${requestedTimeoutMs}`,
        requestedTimeoutMs + 2500,
      );
      setBedrockHealth(result);
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      setBedrockHealth({
        ok: false,
        region: "unknown",
        modelId: null,
        error: isAbort
          ? "bedrock_health_client_timeout:11500"
          : err instanceof Error
            ? err.message
            : "bedrock_health_failed",
        hint: isAbort
          ? "Browser-side timeout while waiting for Bedrock health response. Try again or increase timeout."
          : undefined,
      });
    } finally {
      setBedrockChecking(false);
    }
  }

  async function runSearch() {
    setIsLoading(true);
    setError(null);
    setData(null);
    setDebugData(null);
    setRequestStatus("Running search...");
    try {
      const responsePayload = await postJsonWithTimeout<SearchResponse & { debug?: DebugPayload }>(
        "/api/search",
        { query, maxResults: 20, debug: enableDebugDiagnostics },
        REQUEST_TIMEOUT_MS,
      );

      setData(responsePayload);
      setDebugData(enableDebugDiagnostics ? responsePayload.debug ?? null : null);

      const exactCasesForRun = responsePayload.casesExact ?? responsePayload.cases;
      const exploratoryForRun = responsePayload.casesExploratory ?? responsePayload.casesNearMiss ?? [];
      const summaryCasesForRun = exactCasesForRun.length > 0 ? exactCasesForRun : exploratoryForRun;
      const blockedRun = responsePayload.status === "blocked";
      const partialRun = Boolean(responsePayload.pipelineTrace?.scheduler.partialDueToLatency || responsePayload.partialRun);
      const retryAfterMs = responsePayload.retryAfterMs ?? responsePayload.pipelineTrace?.scheduler.retryAfterMs;

      const avgConfidence =
        summaryCasesForRun.length > 0
          ? summaryCasesForRun.reduce((sum, item) => sum + (item.confidenceScore ?? item.score), 0) /
            summaryCasesForRun.length
          : 0;
      const scCount = summaryCasesForRun.filter((item) => item.court === "SC").length;
      const hcCount = summaryCasesForRun.filter((item) => item.court === "HC").length;

      const nextRuns = saveSessionRun({
        timestamp: Date.now(),
        requestId: responsePayload.requestId,
        totalFetched: responsePayload.totalFetched,
        filteredCount: responsePayload.filteredCount,
        casesCount: summaryCasesForRun.length,
        averageScore: avgConfidence,
        scCount,
        hcCount,
        blocked: blockedRun,
      });
      setSessionRuns(nextRuns);

      if (blockedRun) {
        setRequestStatus(
          retryAfterMs
            ? `Search blocked by source throttling. Retry in ~${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`
            : "Search blocked by source throttling. Please retry shortly.",
        );
      } else if (responsePayload.status === "partial" || partialRun) {
        setRequestStatus("Search completed with partial results due to runtime budget.");
      } else if (responsePayload.status === "no_match" && (responsePayload.casesNearMiss?.length ?? 0) > 0) {
        setRequestStatus("No exact proposition matches were verified; showing best available matches below.");
      } else if (exactCasesForRun.length === 0 && exploratoryForRun.length > 0) {
        setRequestStatus("No exact proposition matches were verified; showing exploratory best-available matches.");
      } else if (responsePayload.status === "no_match") {
        setRequestStatus("No exact proposition matches were verified for this run.");
      } else {
        setRequestStatus("Search completed.");
      }
    } catch (err) {
      const timeoutSeconds = Math.max(1, Math.round(REQUEST_TIMEOUT_MS / 1000));
      const errorMessage =
        err instanceof DOMException && err.name === "AbortError"
          ? `Search exceeded the UI timeout (${timeoutSeconds}s) before the server completed. Please retry; if this repeats, increase NEXT_PUBLIC_SEARCH_TIMEOUT_MS.`
          : err instanceof Error
            ? err.message
            : "Unexpected error";
      setError(errorMessage);
      setData(null);
      setDebugData(null);
      setRequestStatus("Search failed.");
    } finally {
      setIsLoading(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isLoading) return;
    void runSearch();
  }

  function resetSessionTrend() {
    clearSessionRuns();
    setSessionRuns([]);
  }

  const sessionSummary = useMemo(() => summarizeSessionRuns(sessionRuns), [sessionRuns]);
  const queryCoach = useMemo(() => evaluateQueryCoach(query), [query]);

  const exactCases = useMemo(() => {
    if (!data) return [];
    return data.casesExact ?? data.cases;
  }, [data]);

  const nearMissCases = useMemo(() => {
    if (!data) return [];
    return data.casesExploratory ?? data.casesNearMiss ?? [];
  }, [data]);

  const summaryCases = useMemo(() => {
    if (exactCases.length > 0) return exactCases;
    return nearMissCases;
  }, [exactCases, nearMissCases]);

  const runStats = useMemo<ResearchSummaryStats | null>(() => {
    if (!data) return null;
    const scCount = summaryCases.filter((item) => item.court === "SC").length;
    const hcCount = summaryCases.filter((item) => item.court === "HC").length;
    const avgConfidence =
      summaryCases.length > 0
        ? summaryCases.reduce((sum, item) => sum + (item.confidenceScore ?? item.score), 0) / summaryCases.length
        : 0;
    const detailCoverage =
      summaryCases.length > 0
        ? summaryCases.filter((item) => item.verification.detailChecked).length / summaryCases.length
        : 0;
    const retrievalEfficiency = data.totalFetched > 0 ? data.filteredCount / data.totalFetched : 0;

    return {
      scCount,
      hcCount,
      avgConfidence,
      detailCoverage,
      retrievalEfficiency,
      partialRun: Boolean(data.pipelineTrace?.scheduler.partialDueToLatency || data.partialRun),
      elapsedMs: data.pipelineTrace?.scheduler.elapsedMs ?? 0,
    };
  }, [data, summaryCases]);

  const resultMode = useMemo(
    () => deriveResultMode(data, exactCases, nearMissCases),
    [data, exactCases, nearMissCases],
  );

  return (
    <main className="app-shell">
      <HeroHeader
        showAdvanced={showAdvanced}
        onToggleAdvanced={() => setShowAdvanced((prev) => !prev)}
        theme={theme}
        onToggleTheme={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
      />

      <SearchComposer
        query={query}
        onQueryChange={setQuery}
        onSubmit={onSubmit}
        isLoading={isLoading}
        queryCoach={queryCoach}
        statusText={requestStatus}
        status={data?.status}
        error={error}
        stricterRewrite={queryCoach.stricterRewrite}
      />

      <QueryCoachDropdown coach={queryCoach} />

      {isLoading && <LoadingSkeleton />}

      {data && !isLoading && runStats && (
        <>
          <ResearchSummary exactCount={summaryCases.length} stats={runStats} executionPath={data.executionPath} />

          <ResultModeBanner mode={resultMode} nearMissCount={nearMissCases.length} />

          <section className="surface-panel reveal-up">
            <h2>Ranked precedents</h2>
            {exactCases.length === 0 && <p className="empty-state-text">{emptyStateMessage(data, nearMissCases.length)}</p>}
            <div className="result-list">
              {exactCases.map((item) => (
                <CaseResultCard key={item.url} item={item} />
              ))}
            </div>
          </section>

          <NearMissPanel items={nearMissCases} openByDefault={exactCases.length === 0} />
        </>
      )}

      {showAdvanced && (
        <AdvancedDrawer
          data={data}
          debugData={debugData}
          bedrockHealth={bedrockHealth}
          bedrockChecking={bedrockChecking}
          onRunBedrockHealthCheck={() => void runBedrockHealthCheck()}
          enableDebugDiagnostics={enableDebugDiagnostics}
          onToggleDebugDiagnostics={setEnableDebugDiagnostics}
          sessionSummary={sessionSummary}
          onClearSessionTrend={resetSessionTrend}
        />
      )}
    </main>
  );
}
