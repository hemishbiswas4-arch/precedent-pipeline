"use client";
//just to commit
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

type DebugPayload = {
  requestId: string;
  cleanedQuery?: string;
  planner?: {
    source: "bedrock" | "fallback";
    modelId?: string;
    error?: string;
    reasonerMode?: "opus" | "deterministic";
    reasonerDegraded?: boolean;
    reasonerAttempted?: boolean;
    reasonerStatus?:
      | "ok"
      | "timeout"
      | "circuit_open"
      | "config_error"
      | "rate_limited"
      | "lock_timeout"
      | "semaphore_saturated"
      | "disabled"
      | "error";
    reasonerSkipReason?: string;
    reasonerError?: string;
    reasonerWarnings?: string[];
    reasonerTimeoutMsUsed?: number;
    reasonerLatencyMs?: number;
  };
  phrases: string[];
  source: Array<{
    phrase: string;
    searchQuery?: string;
    status: number;
    ok: boolean;
    phase?: string;
    parserMode?: string;
    challengeDetected?: boolean;
    blockedType?: "local_cooldown" | "cloudflare_challenge" | "rate_limit";
    parsedCount: number;
    error: string | null;
    htmlPreview?: string;
  }>;
};

type BedrockHealthResponse = {
  ok: boolean;
  region: string;
  modelId: string | null;
  latencyMs?: number;
  preview?: string;
  timeoutMs?: number;
  aborted?: boolean;
  errorName?: string;
  httpStatusCode?: number;
  hint?: string;
  error?: string;
};

const INITIAL_QUERY =
  "State as appellant filed criminal appeal and delay condonation application was refused; find SC/HC cases where the appeal was dismissed as time-barred.";
const REQUEST_TIMEOUT_MS = Math.max(
  45_000,
  Number(process.env.NEXT_PUBLIC_SEARCH_TIMEOUT_MS ?? "90000"),
);

function executionPathLabel(path: SearchResponse["executionPath"] | undefined): string {
  switch (path) {
    case "server_fallback":
      return "Server (fallback)";
    case "server_only":
      return "Server";
    default:
      return "Server";
  }
}

function ScoreMeter({ score }: { score: number }) {
  return (
    <div className="score-meter" aria-hidden="true">
      <div className="score-fill" style={{ width: `${Math.round(score * 100)}%` }} />
    </div>
  );
}

function CaseCard({ item }: { item: ScoredCase }) {
  const confidence = item.confidenceScore ?? item.score;
  const confidenceBand = item.confidenceBand ?? "LOW";
  const strictHigh =
    item.exactnessType === "strict" && (confidenceBand === "HIGH" || confidenceBand === "VERY_HIGH");
  return (
    <article className="case-card">
      <div className="case-header">
        <span className={`court-tag court-${item.court.toLowerCase()}`}>{item.court}</span>
        <span className={`score-number confidence-${confidenceBand.toLowerCase()}`}>
          Confidence {confidenceBand.replace("_", " ")}
        </span>
      </div>
      {item.exactnessType === "provisional" && <p className="provisional-badge">Exact (Provisional)</p>}
      {item.exactnessType === "provisional" && (
        <p className="provisional-warning">Provisional matches are capped at MEDIUM confidence by policy.</p>
      )}
      {strictHigh && <p className="strict-high-indicator">Strict doctrinal confidence</p>}
      <h3>{item.title}</h3>
      <p className="selection-summary">{item.selectionSummary}</p>
      <p>{item.snippet || "No snippet extracted from source."}</p>
      <ScoreMeter score={confidence} />
      <details className="case-details">
        <summary>View evidence</summary>
        {item.matchEvidence && item.matchEvidence.length > 0 && (
          <p className="stats">matchEvidence: {item.matchEvidence.join(" | ")}</p>
        )}
        {item.missingCoreElements && item.missingCoreElements.length > 0 && (
          <p className="stats">missingCore: {item.missingCoreElements.join(", ")}</p>
        )}
        {item.missingMandatorySteps && item.missingMandatorySteps.length > 0 && (
          <p className="stats">missingMandatorySteps: {item.missingMandatorySteps.join(", ")}</p>
        )}
        <p className="reasons">{item.reasons.join(" • ")}</p>
        <p className="stats">
          confidence={Math.round(confidence * 100)}% | ranking={(item.rankingScore ?? item.score).toFixed(3)}
        </p>
      </details>
      <a href={item.url} target="_blank" rel="noopener noreferrer">
        Open case
      </a>
    </article>
  );
}

function NearMissCard({ item }: { item: NearMissCase }) {
  const confidenceBand = item.confidenceBand ?? "LOW";
  return (
    <article className="case-card near-miss-card">
      <div className="case-header">
        <span className={`court-tag court-${item.court.toLowerCase()}`}>{item.court}</span>
        <span className={`score-number confidence-${confidenceBand.toLowerCase()}`}>
          Near miss {confidenceBand.replace("_", " ")}
        </span>
      </div>
      <h3>{item.title}</h3>
      <p className="selection-summary">{item.selectionSummary}</p>
      <p>{item.snippet || "No snippet extracted from source."}</p>
      <p className="stats">Missing elements: {item.missingElements.join(", ")}</p>
      {item.missingMandatorySteps && item.missingMandatorySteps.length > 0 && (
        <p className="stats">Missing mandatory steps: {item.missingMandatorySteps.join(", ")}</p>
      )}
      <a href={item.url} target="_blank" rel="noopener noreferrer">
        Open case
      </a>
    </article>
  );
}

function LoadingSkeleton() {
  return (
    <section className="panel" aria-live="polite">
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

export default function Home() {
  const [query, setQuery] = useState(INITIAL_QUERY);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [debugData, setDebugData] = useState<DebugPayload | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestStatus, setRequestStatus] = useState<string>("");
  const [sessionRuns, setSessionRuns] = useState<SessionRunMetric[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [enableDebugDiagnostics, setEnableDebugDiagnostics] = useState(false);
  const [bedrockHealth, setBedrockHealth] = useState<BedrockHealthResponse | null>(null);
  const [bedrockChecking, setBedrockChecking] = useState(false);

  useEffect(() => {
    setSessionRuns(loadSessionRuns());
  }, []);

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
        error: isAbort ? "bedrock_health_client_timeout:11500" : err instanceof Error ? err.message : "bedrock_health_failed",
        hint: isAbort
          ? "Browser-side timeout while waiting for Bedrock health response. Try again or increase timeout."
          : undefined,
      });
    } finally {
      setBedrockChecking(false);
    }
  }

  const sessionSummary = useMemo(() => summarizeSessionRuns(sessionRuns), [sessionRuns]);
  const queryCoach = useMemo(() => evaluateQueryCoach(query), [query]);

  const exactCases = useMemo(() => {
    if (!data) return [];
    return data.casesExact ?? data.cases;
  }, [data]);

  const nearMissCases = useMemo(() => {
    if (!data) return [];
    return data.casesNearMiss ?? [];
  }, [data]);

  const runStats = useMemo(() => {
    if (!data) return null;
    const scCount = exactCases.filter((item) => item.court === "SC").length;
    const hcCount = exactCases.filter((item) => item.court === "HC").length;
    const avgConfidence =
      exactCases.length > 0
        ? exactCases.reduce((sum, item) => sum + (item.confidenceScore ?? item.score), 0) / exactCases.length
        : 0;
    const detailCoverage =
      exactCases.length > 0
        ? exactCases.filter((item) => item.verification.detailChecked).length / exactCases.length
        : 0;
    const retrievalEfficiency = data.totalFetched > 0 ? data.filteredCount / data.totalFetched : 0;
    const bandBreakdown = exactCases.reduce<Record<string, number>>((acc, item) => {
      const band = item.confidenceBand ?? "LOW";
      acc[band] = (acc[band] ?? 0) + 1;
      return acc;
    }, {});

    return {
      scCount,
      hcCount,
      avgConfidence,
      detailCoverage,
      retrievalEfficiency,
      bandBreakdown,
      partialRun: Boolean(data.pipelineTrace?.scheduler.partialDueToLatency || data.partialRun),
      elapsedMs: data.pipelineTrace?.scheduler.elapsedMs ?? 0,
    };
  }, [data, exactCases]);

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
      const blockedRun = responsePayload.status === "blocked";
      const partialRun = Boolean(responsePayload.pipelineTrace?.scheduler.partialDueToLatency || responsePayload.partialRun);
      const retryAfterMs = responsePayload.retryAfterMs ?? responsePayload.pipelineTrace?.scheduler.retryAfterMs;

      const avgConfidence =
        exactCasesForRun.length > 0
          ? exactCasesForRun.reduce((sum, item) => sum + (item.confidenceScore ?? item.score), 0) /
            exactCasesForRun.length
          : 0;
      const scCount = exactCasesForRun.filter((item) => item.court === "SC").length;
      const hcCount = exactCasesForRun.filter((item) => item.court === "HC").length;

      const nextRuns = saveSessionRun({
        timestamp: Date.now(),
        requestId: responsePayload.requestId,
        totalFetched: responsePayload.totalFetched,
        filteredCount: responsePayload.filteredCount,
        casesCount: exactCasesForRun.length,
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
        setRequestStatus("No exact proposition matches were verified; near misses are shown below.");
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

  return (
    <main className="shell consumer-shell">
      <section className="hero">
        <p className="eyebrow">Precedent Finder</p>
        <h1>Find Supreme Court and High Court precedents from plain-language facts</h1>
        <p>
          Describe your fact pattern clearly. The system compiles legal proposition constraints, retrieves candidates,
          and verifies exact doctrinal matches first.
        </p>
      </section>

      <section className="panel search-panel">
        <div className="panel-header-row">
          <h2>Fact scenario</h2>
          <button className="button-ghost" type="button" onClick={() => setShowAdvanced((prev) => !prev)}>
            {showAdvanced ? "Hide advanced" : "Advanced"}
          </button>
        </div>
        <form onSubmit={onSubmit}>
          <textarea
            id="query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={8}
            placeholder="Include actor role, proceeding posture, legal hooks (if known), and required outcome."
          />
          <div className="example-row" aria-label="Query examples">
            {queryCoach.examples.map((example, index) => (
              <button
                key={example}
                type="button"
                className="example-chip"
                onClick={() => setQuery(example)}
                title={example}
              >
                Example {index + 1}
              </button>
            ))}
          </div>
          <div className="form-actions">
            <button type="submit" disabled={isLoading}>
              {isLoading ? "Running search..." : "Run automated search"}
            </button>
            {queryCoach.stricterRewrite && (
              <button
                type="button"
                className="button-secondary"
                onClick={() => setQuery(queryCoach.stricterRewrite ?? query)}
              >
                Make query stricter
              </button>
            )}
          </div>
        </form>
        <p className="compliance-note">
          Compliance mode: no CAPTCHA/Cloudflare bypass techniques are used.
        </p>
        <p className={`status ${data?.status === "blocked" ? "status-blocked" : ""}`} aria-live="polite">
          {requestStatus}
        </p>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel coach-panel">
        <h2>Query coach</h2>
        <p className="stats">
          Query quality: <strong>{queryCoach.grade}</strong> ({Math.round(queryCoach.score * 100)}%)
        </p>
        <div className="coach-grid">
          {queryCoach.checklist.map((item) => (
            <article key={item.id} className={`coach-item ${item.satisfied ? "coach-ok" : "coach-miss"}`}>
              <h3>{item.label}</h3>
              <p>{item.detail}</p>
            </article>
          ))}
        </div>
        {queryCoach.warnings.length > 0 && (
          <div className="coach-warnings">
            {queryCoach.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        )}
        {queryCoach.suggestions.length > 0 && (
          <ul className="phrase-list">
            {queryCoach.suggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </ul>
        )}
      </section>

      {showAdvanced && (
        <section className="panel advanced-panel">
          <h2>Advanced settings</h2>
          <div className="advanced-block">
            <h3>Reasoner (Bedrock)</h3>
            <button
              type="button"
              className="button-secondary"
              onClick={() => void runBedrockHealthCheck()}
              disabled={bedrockChecking}
            >
              {bedrockChecking ? "Testing..." : "Test Bedrock connection"}
            </button>
            {bedrockHealth && (
              <>
                <p className="stats">
                  {bedrockHealth.ok
                    ? `OK (${bedrockHealth.region}, ${bedrockHealth.modelId ?? "unknown model"}, ${bedrockHealth.latencyMs ?? 0}ms)`
                    : `Error (${bedrockHealth.error ?? "unknown"}${
                        typeof bedrockHealth.httpStatusCode === "number"
                          ? `, HTTP ${bedrockHealth.httpStatusCode}`
                          : ""
                      }${
                        typeof bedrockHealth.timeoutMs === "number"
                          ? `, timeout ${bedrockHealth.timeoutMs}ms`
                          : ""
                      })`}
                </p>
                {!bedrockHealth.ok && bedrockHealth.hint && <p className="stats">{bedrockHealth.hint}</p>}
              </>
            )}
            {!bedrockHealth && (
              <p className="stats">
                Use this to confirm AWS credentials/region/model config on Vercel. If it fails, reasoner planning will
                fall back to deterministic mode.
              </p>
            )}
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={enableDebugDiagnostics}
              onChange={(event) => setEnableDebugDiagnostics(event.target.checked)}
            />
            Enable developer diagnostics for this run
          </label>
          <p className="stats">Debug output is hidden from default user view and shown only in this drawer.</p>
        </section>
      )}

      {isLoading && <LoadingSkeleton />}

      {data && !isLoading && (
        <>
          <section className="panel">
            <h2>Research summary</h2>
            <div className="analytics-grid">
              <article className="analytics-card">
                <h3>Cases ranked</h3>
                <p>{exactCases.length}</p>
              </article>
              <article className="analytics-card">
                <h3>SC / HC</h3>
                <p>
                  {runStats?.scCount ?? 0} / {runStats?.hcCount ?? 0}
                </p>
              </article>
              <article className="analytics-card">
                <h3>Average confidence</h3>
                <p>{((runStats?.avgConfidence ?? 0) * 100).toFixed(0)}%</p>
              </article>
              <article className="analytics-card">
                <h3>Detail verified</h3>
                <p>{((runStats?.detailCoverage ?? 0) * 100).toFixed(0)}%</p>
              </article>
              <article className="analytics-card">
                <h3>Retrieval efficiency</h3>
                <p>{((runStats?.retrievalEfficiency ?? 0) * 100).toFixed(0)}%</p>
              </article>
              <article className="analytics-card">
                <h3>Execution path</h3>
                <p>{executionPathLabel(data.executionPath)}</p>
              </article>
              <article className="analytics-card">
                <h3>Partial run</h3>
                <p>{runStats?.partialRun ? "yes" : "no"}</p>
              </article>
              <article className="analytics-card">
                <h3>Elapsed</h3>
                <p>{Math.max(0, Math.round((runStats?.elapsedMs ?? 0) / 1000))}s</p>
              </article>
            </div>
            <p className="stats">
              Request ID: {data.requestId ?? "n/a"} | Fetched {data.totalFetched} candidates, filtered to {" "}
              {data.filteredCount} HC/SC decisions.
            </p>
          </section>

          <section className="panel">
            <div className="panel-header-row">
              <h2>Session trend (this browser session)</h2>
              <button className="button-ghost" onClick={resetSessionTrend}>
                Clear history
              </button>
            </div>
            <p className="stats">
              runs={sessionSummary.totalRuns} | successRate={(sessionSummary.successRate * 100).toFixed(0)}% |
              avgCases/run= {sessionSummary.avgCasesPerRun.toFixed(1)} | avgConfidence=
              {(sessionSummary.avgScore * 100).toFixed(0)}% | blockedRuns= {sessionSummary.blockedRuns}
            </p>
          </section>

          <section className="panel">
            <h2>Why these were chosen</h2>
            <p>{data.insights?.summary ?? "Top-ranked cases were selected based on proposition matching signals."}</p>
            <div className="token-grid">
              {(data.insights?.topSignals.issues ?? []).map((signal) => (
                <span key={`issue-${signal}`} className="token">
                  {signal}
                </span>
              ))}
              {(data.insights?.topSignals.procedures ?? []).map((signal) => (
                <span key={`procedure-${signal}`} className="token token-alt">
                  {signal}
                </span>
              ))}
              {(data.insights?.topSignals.statutes ?? []).map((signal) => (
                <span key={`statute-${signal}`} className="token token-muted">
                  {signal}
                </span>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>Ranked precedents</h2>
            <div className="cases">
              {exactCases.length === 0 && (
                <p>
                  {data.status === "blocked"
                    ? "Source access is temporarily blocked/throttled. Retry after cooldown to continue retrieval."
                    : data.status === "partial"
                      ? "Run ended early due to runtime budget before exact matches were verified. Retry to continue."
                      : nearMissCases.length > 0
                        ? "No exact proposition matches were found. Near misses are expanded below."
                      : "No court-filtered exact matches found. Refine facts or add legal sections in the query."}
                </p>
              )}
              {exactCases.map((item) => (
                <CaseCard key={item.url} item={item} />
              ))}
            </div>
            {nearMissCases.length > 0 && (
              <details className="case-details" open={exactCases.length === 0}>
                <summary>Near misses ({nearMissCases.length})</summary>
                <p className="stats">
                  These are contextually similar but failed one or more mandatory proposition elements.
                </p>
                <div className="cases">
                  {nearMissCases.map((item) => (
                    <NearMissCard key={`near-${item.url}`} item={item} />
                  ))}
                </div>
              </details>
            )}
            <div className="notes">
              {data.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          </section>

          {showAdvanced && (
            <section className="panel">
              <h2>Advanced run data</h2>
              <p className="stats">executionPath: {data.executionPath ?? "server_only"}</p>
              <p className="stats">
                routingReason: {data.pipelineTrace?.routing?.reason ?? "n/a"}
                {data.pipelineTrace?.routing?.clientProbe
                  ? ` | clientProbe=${data.pipelineTrace.routing.clientProbe}`
                  : ""}
              </p>
              <p className="stats">
                stopReason: {data.pipelineTrace?.scheduler.stopReason ?? "n/a"}
                {data.pipelineTrace?.scheduler.blockedReason
                  ? ` | blockedReason=${data.pipelineTrace.scheduler.blockedReason}`
                  : ""}
                {data.pipelineTrace?.scheduler.blockedKind
                  ? ` | blockedKind=${data.pipelineTrace.scheduler.blockedKind}`
                  : ""}
              </p>
              <p className="stats">
                attemptsUsed: {data.pipelineTrace?.scheduler.attemptsUsed ?? 0}/
                {data.pipelineTrace?.scheduler.globalBudget ?? 0} | challengeCount:{" "}
                {data.pipelineTrace?.retrieval.challengeCount ?? 0} | rateLimitCount:{" "}
                {data.pipelineTrace?.retrieval.rateLimitCount ?? 0}
              </p>
              {typeof data.retryAfterMs === "number" && data.retryAfterMs > 0 && (
                <p className="stats">retryAfter: {Math.max(1, Math.ceil(data.retryAfterMs / 1000))}s</p>
              )}
              <p className="stats">domains: {data.context.domains.join(", ") || "none"}</p>
              <p className="stats">issues: {data.context.issues.join(", ") || "none"}</p>
              <p className="stats">statutes/sections: {data.context.statutesOrSections.join(", ") || "none"}</p>
              <p className="stats">procedures: {data.context.procedures.join(", ") || "none"}</p>
              <p className="stats">actors: {data.context.actors.join(", ") || "none"}</p>
              <h3>Generated keyword pack</h3>
              <div className="token-grid">
                {data.keywordPack.primary.map((token) => (
                  <span key={token} className="token">
                    {token}
                  </span>
                ))}
              </div>
              <h3>Search phrases</h3>
              <ul className="phrase-list">
                {data.keywordPack.searchPhrases.map((phrase) => (
                  <li key={phrase}>{phrase}</li>
                ))}
              </ul>

              {enableDebugDiagnostics && debugData && (
                <details className="debug-section">
                  <summary>Developer diagnostics</summary>
                  <p className="stats">Request ID: {debugData.requestId}</p>
                  {debugData.cleanedQuery && <p className="stats">Cleaned query: {debugData.cleanedQuery}</p>}
                  {debugData.planner && (
                    <>
                      <p className="stats">
                        Planner: {debugData.planner.source}
                        {debugData.planner.modelId ? ` | model=${debugData.planner.modelId}` : ""}
                        {debugData.planner.error ? ` | plannerError=${debugData.planner.error}` : ""}
                      </p>
                      <p className="stats">
                        Reasoner: {debugData.planner.reasonerMode ?? "unknown"}
                        {typeof debugData.planner.reasonerAttempted === "boolean"
                          ? ` | attempted=${String(debugData.planner.reasonerAttempted)}`
                          : ""}
                        {debugData.planner.reasonerStatus ? ` | status=${debugData.planner.reasonerStatus}` : ""}
                        {typeof debugData.planner.reasonerTimeoutMsUsed === "number"
                          ? ` | timeoutMs=${debugData.planner.reasonerTimeoutMsUsed}`
                          : ""}
                        {typeof debugData.planner.reasonerLatencyMs === "number"
                          ? ` | latencyMs=${debugData.planner.reasonerLatencyMs}`
                          : ""}
                        {debugData.planner.reasonerSkipReason
                          ? ` | skipReason=${debugData.planner.reasonerSkipReason}`
                          : ""}
                        {!debugData.planner.reasonerSkipReason && debugData.planner.reasonerError
                          ? ` | error=${debugData.planner.reasonerError}`
                          : ""}
                      </p>
                      {debugData.planner.reasonerWarnings && debugData.planner.reasonerWarnings.length > 0 && (
                        <p className="stats">
                          Reasoner warnings: {debugData.planner.reasonerWarnings.join(" | ")}
                        </p>
                      )}
                    </>
                  )}
                  <div className="cases">
                    {debugData.source.map((entry, idx) => (
                      <article className="case-card" key={`${entry.phrase}-${idx}`}>
                        <h3>{entry.phrase}</h3>
                        <p>
                          HTTP {entry.status} | ok={String(entry.ok)} | parsed={entry.parsedCount}
                        </p>
                        <p>
                          phase={entry.phase ?? "unknown"} | parser={entry.parserMode ?? "unknown"}
                          {entry.challengeDetected ? " | challenge=true" : ""}
                          {entry.blockedType ? ` | blockedType=${entry.blockedType}` : ""}
                        </p>
                        {entry.searchQuery && <p className="stats">searchQuery: {entry.searchQuery}</p>}
                        {entry.htmlPreview && <p className="stats">preview: {entry.htmlPreview}</p>}
                        {entry.error && <p className="error">{entry.error}</p>}
                      </article>
                    ))}
                  </div>
                </details>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
