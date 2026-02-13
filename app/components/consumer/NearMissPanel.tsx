"use client";

import { NearMissCase } from "@/lib/types";

export function NearMissPanel(props: {
  items: NearMissCase[];
  openByDefault?: boolean;
}) {
  const { items, openByDefault = false } = props;
  if (items.length === 0) return null;

  return (
    <section className="surface-panel near-miss-panel reveal-up">
      <details open={openByDefault}>
        <summary>Closest matches ({items.length})</summary>
        <p className="near-miss-note">
          These are contextually close but failed one or more mandatory proposition requirements.
        </p>
        <div className="result-list">
          {items.map((item) => (
            <article key={`near-${item.url}`} className="result-card near-card">
              <header className="result-card-header">
                <span className={`court-tag court-${item.court.toLowerCase()}`}>{item.court}</span>
                <div className="badge-row">
                  <span className={`confidence-pill confidence-${(item.confidenceBand ?? "LOW").toLowerCase()}`}>
                    Near miss
                  </span>
                  <span className={`verify-pill ${item.verification.detailChecked ? "verified" : "snippet"}`}>
                    {item.verification.detailChecked ? "Detail verified" : "Snippet-backed"}
                  </span>
                </div>
              </header>
              <h3>{item.title}</h3>
              <p className="selection-summary">{item.selectionSummary}</p>
              <p className="snippet-text">{item.snippet || "No snippet extracted from source."}</p>
              <p className="inline-detail">Missing elements: {item.missingElements.join(", ")}</p>
              <a className="case-link" href={item.url} target="_blank" rel="noopener noreferrer">
                Open case
              </a>
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}
