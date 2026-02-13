"use client";

import { ScoredCase } from "@/lib/types";

function confidenceLabel(item: ScoredCase): string {
  const band = item.confidenceBand ?? "LOW";
  return band.replace(/_/g, " ");
}

export function CaseResultCard(props: { item: ScoredCase }) {
  const { item } = props;
  const confidence = item.confidenceScore ?? item.score;
  const detailVerified = item.verification.detailChecked;

  return (
    <article className="result-card">
      <header className="result-card-header">
        <span className={`court-tag court-${item.court.toLowerCase()}`}>{item.court}</span>
        <div className="badge-row">
          <span className={`confidence-pill confidence-${(item.confidenceBand ?? "LOW").toLowerCase()}`}>
            {confidenceLabel(item)}
          </span>
          <span className={`verify-pill ${detailVerified ? "verified" : "snippet"}`}>
            {detailVerified ? "Detail verified" : "Snippet-backed"}
          </span>
        </div>
      </header>

      <h3>{item.title}</h3>
      <p className="selection-summary">{item.selectionSummary}</p>
      <p className="snippet-text">{item.snippet || "No snippet extracted from source."}</p>

      <div className="confidence-track" aria-hidden="true">
        <div className="confidence-fill" style={{ width: `${Math.round(confidence * 100)}%` }} />
      </div>

      <details className="result-details">
        <summary>View reasoning details</summary>
        {item.matchEvidence && item.matchEvidence.length > 0 && (
          <p className="inline-detail">Evidence: {item.matchEvidence.join(" | ")}</p>
        )}
        {item.missingCoreElements && item.missingCoreElements.length > 0 && (
          <p className="inline-detail">Missing core: {item.missingCoreElements.join(", ")}</p>
        )}
        {item.missingMandatorySteps && item.missingMandatorySteps.length > 0 && (
          <p className="inline-detail">Missing mandatory: {item.missingMandatorySteps.join(", ")}</p>
        )}
      </details>

      <a className="case-link" href={item.url} target="_blank" rel="noopener noreferrer">
        Open case
      </a>
    </article>
  );
}
