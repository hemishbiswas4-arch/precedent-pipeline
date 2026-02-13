"use client";

import { DebugPayload, BedrockHealthResponse, SessionSummary } from "@/app/components/consumer/types";
import { SearchResponse } from "@/lib/types";

export function AdvancedDrawer(props: {
  data: SearchResponse | null;
  debugData: DebugPayload | null;
  bedrockHealth: BedrockHealthResponse | null;
  bedrockChecking: boolean;
  onRunBedrockHealthCheck: () => void;
  enableDebugDiagnostics: boolean;
  onToggleDebugDiagnostics: (next: boolean) => void;
  sessionSummary: SessionSummary;
  onClearSessionTrend: () => void;
}) {
  const {
    data,
    debugData,
    bedrockHealth,
    bedrockChecking,
    onRunBedrockHealthCheck,
    enableDebugDiagnostics,
    onToggleDebugDiagnostics,
    sessionSummary,
    onClearSessionTrend,
  } = props;

  return (
    <section className="surface-panel advanced-drawer reveal-up">
      <h2>Advanced</h2>

      <div className="advanced-block">
        <h3>Reasoner (Bedrock)</h3>
        <button type="button" className="secondary-btn" onClick={onRunBedrockHealthCheck} disabled={bedrockChecking}>
          {bedrockChecking ? "Testing..." : "Test Bedrock connection"}
        </button>
        {bedrockHealth ? (
          <p className="stats-line">
            {bedrockHealth.ok
              ? `OK (${bedrockHealth.region}, ${bedrockHealth.modelId ?? "unknown model"}, ${bedrockHealth.latencyMs ?? 0}ms)`
              : `Error (${bedrockHealth.error ?? "unknown"}${
                  typeof bedrockHealth.httpStatusCode === "number"
                    ? `, HTTP ${bedrockHealth.httpStatusCode}`
                    : ""
                }${typeof bedrockHealth.timeoutMs === "number" ? `, timeout ${bedrockHealth.timeoutMs}ms` : ""})`}
          </p>
        ) : (
          <p className="stats-line">Use this to validate AWS credentials, region, and model connectivity.</p>
        )}
      </div>

      <label className="checkbox-row" htmlFor="debug-toggle">
        <input
          id="debug-toggle"
          type="checkbox"
          checked={enableDebugDiagnostics}
          onChange={(event) => onToggleDebugDiagnostics(event.target.checked)}
        />
        Enable developer diagnostics for this run
      </label>

      <div className="advanced-block">
        <div className="panel-header-row">
          <h3>Session trend</h3>
          <button className="ghost-btn" type="button" onClick={onClearSessionTrend}>
            Clear history
          </button>
        </div>
        <p className="stats-line">
          runs={sessionSummary.totalRuns} | successRate={(sessionSummary.successRate * 100).toFixed(0)}% |
          avgCases/run={sessionSummary.avgCasesPerRun.toFixed(1)} | avgConfidence={(sessionSummary.avgScore * 100).toFixed(0)}% |
          blockedRuns={sessionSummary.blockedRuns}
        </p>
      </div>

      {data && (
        <div className="advanced-block">
          <h3>Run internals</h3>
          <p className="stats-line">
            Request ID: {data.requestId ?? "n/a"} | Fetched {data.totalFetched} candidates, filtered to {data.filteredCount} HC/SC decisions.
          </p>
          <p className="stats-line">executionPath: {data.executionPath ?? "server_only"}</p>
          <p className="stats-line">stopReason: {data.pipelineTrace?.scheduler.stopReason ?? "n/a"}</p>
          <p className="stats-line">domains: {data.context.domains.join(", ") || "none"}</p>
          <p className="stats-line">issues: {data.context.issues.join(", ") || "none"}</p>
          <p className="stats-line">statutes/sections: {data.context.statutesOrSections.join(", ") || "none"}</p>
          <p className="stats-line">procedures: {data.context.procedures.join(", ") || "none"}</p>
          <p className="stats-line">actors: {data.context.actors.join(", ") || "none"}</p>

          <h4>Generated keyword pack</h4>
          <div className="token-grid">
            {data.keywordPack.primary.map((token) => (
              <span key={token} className="token">
                {token}
              </span>
            ))}
          </div>

          <h4>Search phrases</h4>
          <ul className="phrase-list">
            {data.keywordPack.searchPhrases.map((phrase) => (
              <li key={phrase}>{phrase}</li>
            ))}
          </ul>

          <div className="notes-list">
            {data.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>

          {enableDebugDiagnostics && debugData && (
            <details className="debug-section">
              <summary>Developer diagnostics</summary>
              <p className="stats-line">Request ID: {debugData.requestId}</p>
              {debugData.cleanedQuery && <p className="stats-line">Cleaned query: {debugData.cleanedQuery}</p>}
              {debugData.planner && (
                <>
                  <p className="stats-line">
                    Planner: {debugData.planner.source}
                    {debugData.planner.modelId ? ` | model=${debugData.planner.modelId}` : ""}
                    {debugData.planner.error ? ` | plannerError=${debugData.planner.error}` : ""}
                  </p>
                  <p className="stats-line">
                    Reasoner: {debugData.planner.reasonerMode ?? "unknown"}
                    {typeof debugData.planner.reasonerAttempted === "boolean"
                      ? ` | attempted=${String(debugData.planner.reasonerAttempted)}`
                      : ""}
                    {debugData.planner.reasonerStatus ? ` | status=${debugData.planner.reasonerStatus}` : ""}
                  </p>
                </>
              )}

              <div className="result-list">
                {debugData.source.map((entry, idx) => (
                  <article className="result-card" key={`${entry.phrase}-${idx}`}>
                    <h4>{entry.phrase}</h4>
                    <p className="stats-line">
                      HTTP {entry.status} | ok={String(entry.ok)} | parsed={entry.parsedCount}
                    </p>
                    <p className="stats-line">
                      phase={entry.phase ?? "unknown"} | parser={entry.parserMode ?? "unknown"}
                      {entry.blockedType ? ` | blockedType=${entry.blockedType}` : ""}
                    </p>
                    {entry.searchQuery && <p className="stats-line">searchQuery: {entry.searchQuery}</p>}
                    {entry.htmlPreview && <p className="stats-line">preview: {entry.htmlPreview}</p>}
                    {entry.error && <p className="error-text">{entry.error}</p>}
                  </article>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
