"use client";

import { QueryCoachResult } from "@/lib/query-coach";

function readinessLabel(readiness: QueryCoachResult["readiness"]): string {
  return readiness.replace(/_/g, " ");
}

export function QueryCoachDropdown(props: { coach: QueryCoachResult }) {
  const { coach } = props;
  const critical = coach.checklist.filter((item) => item.priority === "critical");
  const optional = coach.checklist.filter((item) => item.priority === "optional");

  return (
    <section className="surface-panel coach-panel reveal-up" aria-label="Query coach">
      <details className="coach-dropdown">
        <summary>
          <span>Query coach</span>
          <span className="coach-summary-meta">
            {readinessLabel(coach.readiness)} • {coach.grade} ({Math.round(coach.score * 100)}%)
          </span>
        </summary>

        <div className="coach-dropdown-content">
          <div className={`readiness-card readiness-${coach.readiness.toLowerCase()}`}>
            <p className="readiness-label">Readiness</p>
            <p className="readiness-title">
              {readinessLabel(coach.readiness)} • {coach.grade} ({Math.round(coach.score * 100)}%)
            </p>
            <p>{coach.readinessMessage}</p>
          </div>

          <div className="coach-sections">
            <article>
              <h3>What matters most</h3>
              <div className="coach-grid">
                {critical.map((item) => (
                  <article key={item.id} className={`coach-item ${item.satisfied ? "coach-ok" : "coach-miss"}`}>
                    <h4>{item.label}</h4>
                    <p>{item.detail}</p>
                  </article>
                ))}
              </div>
            </article>
          </div>

          {coach.nextActions.length > 0 && (
            <div className="coach-next-actions">
              <h3>Top next improvements</h3>
              <ol>
                {coach.nextActions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ol>
            </div>
          )}

          {coach.recommendedPattern && (
            <div className="coach-pattern">
              <h3>Recommended pattern</h3>
              <p>{coach.recommendedPattern}</p>
            </div>
          )}

          {optional.length > 0 && (
            <div className="coach-optional">
              <h3>Optional precision</h3>
              <div className="coach-grid">
                {optional.map((item) => (
                  <article key={item.id} className={`coach-item ${item.satisfied ? "coach-ok" : "coach-miss"}`}>
                    <h4>{item.label}</h4>
                    <p>{item.detail}</p>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
