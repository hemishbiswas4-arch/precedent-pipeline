"use client";

import { ResultMode } from "@/app/components/consumer/types";

function modeText(mode: ResultMode, nearMissCount: number): string {
  if (mode === "exact") {
    return "Exact or high-quality proposition matches were verified and ranked below.";
  }
  if (mode === "best_available") {
    return nearMissCount > 0
      ? `No exact verified match yet. Showing ${nearMissCount} exploratory best-available matches with explicit gaps.`
      : "No exact verified match yet. Try refining actor, proceeding, or outcome details.";
  }
  if (mode === "blocked") {
    return "Search was blocked by source throttling. Retry after cooldown to continue.";
  }
  if (mode === "partial") {
    return "Run ended due to runtime budget. Best available verified results are shown.";
  }
  return "No court-filtered matches were returned for this run.";
}

export function ResultModeBanner(props: {
  mode: ResultMode;
  nearMissCount: number;
}) {
  const { mode, nearMissCount } = props;
  return (
    <section className={`surface-panel result-banner mode-${mode}`} aria-live="polite">
      <h2>{mode === "exact" ? "Verified results" : "Best available results"}</h2>
      <p>{modeText(mode, nearMissCount)}</p>
    </section>
  );
}
