"use client";

import { ResearchSummaryStats } from "@/app/components/consumer/types";

type ExecutionPath = "server_fallback" | "server_only" | undefined;

function executionPathLabel(path: ExecutionPath): string {
  if (path === "server_fallback") return "Server fallback";
  return "Server";
}

export function ResearchSummary(props: {
  exactCount: number;
  stats: ResearchSummaryStats;
  executionPath: ExecutionPath;
}) {
  const { exactCount, stats, executionPath } = props;
  return (
    <section className="surface-panel reveal-up" aria-label="Research summary">
      <h2>Research summary</h2>
      <div className="summary-grid">
        <article className="summary-card">
          <h3>Matches ranked</h3>
          <p>{exactCount}</p>
        </article>
        <article className="summary-card">
          <h3>SC / HC</h3>
          <p>
            {stats.scCount} / {stats.hcCount}
          </p>
        </article>
        <article className="summary-card">
          <h3>Average confidence</h3>
          <p>{Math.round(stats.avgConfidence * 100)}%</p>
        </article>
        <article className="summary-card">
          <h3>Detail verified</h3>
          <p>{Math.round(stats.detailCoverage * 100)}%</p>
        </article>
        <article className="summary-card">
          <h3>Execution path</h3>
          <p>{executionPathLabel(executionPath)}</p>
        </article>
        <article className="summary-card">
          <h3>Elapsed</h3>
          <p>{Math.max(0, Math.round(stats.elapsedMs / 1000))}s</p>
        </article>
      </div>
    </section>
  );
}
