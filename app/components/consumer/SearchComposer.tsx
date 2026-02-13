"use client";

import { FormEvent } from "react";
import { QueryCoachResult } from "@/lib/query-coach";
import { SearchStatus } from "@/app/components/consumer/types";

type PromptChip = {
  id: QueryCoachResult["checklist"][number]["id"];
  label: string;
  fragment: string;
};

function appendFragment(existing: string, fragment: string): string {
  const current = existing.trim();
  if (!current) return fragment;
  const currentLower = current.toLowerCase();
  const fragmentLower = fragment.toLowerCase();
  if (currentLower.includes(fragmentLower)) return existing;

  const tail = /[.;:]$/.test(current) ? "" : ";";
  const joined = `${current}${tail} ${fragment}`
    .replace(/\s+/g, " ")
    .replace(/;\s*;/g, ";")
    .trim();
  return joined;
}

function buildPromptChips(coach: QueryCoachResult): PromptChip[] {
  const hasCriticalGap = coach.checklist.some(
    (item) => item.priority === "critical" && !item.satisfied,
  );
  if (!hasCriticalGap) return [];

  const missing = new Set(coach.checklist.filter((item) => !item.satisfied).map((item) => item.id));
  const ordered: PromptChip[] = [
    { id: "actor", label: "Add actor role", fragment: "State as appellant" },
    { id: "proceeding", label: "Add proceeding", fragment: "in a criminal appeal" },
    {
      id: "outcome",
      label: "Add outcome",
      fragment: "where delay condonation was refused and appeal was dismissed as time-barred",
    },
    { id: "hooks", label: "Add statute hook", fragment: "under Section 197 CrPC" },
    { id: "exclusions", label: "Add exclusion cue", fragment: "sanction not required" },
  ];

  return ordered.filter((chip) => missing.has(chip.id)).slice(0, 4);
}

function statusClass(status: SearchStatus | undefined): string {
  if (status === "blocked") return "status-strip status-blocked";
  if (status === "partial") return "status-strip status-partial";
  if (status === "no_match") return "status-strip status-warning";
  if (status === "completed") return "status-strip status-success";
  return "status-strip";
}

export function SearchComposer(props: {
  query: string;
  onQueryChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isLoading: boolean;
  queryCoach: QueryCoachResult;
  statusText: string;
  status?: SearchStatus;
  error: string | null;
  stricterRewrite?: string;
}) {
  const {
    query,
    onQueryChange,
    onSubmit,
    isLoading,
    queryCoach,
    statusText,
    status,
    error,
    stricterRewrite,
  } = props;

  const chips = buildPromptChips(queryCoach);

  return (
    <section className="surface-panel search-panel reveal-up" aria-label="Search composer">
      <div className="composer-top">
        <h2>Describe your legal situation</h2>
        <p>
          Include who acted, what stage the matter was in, and what outcome you want to verify.
        </p>
      </div>
      <form onSubmit={onSubmit}>
        <label htmlFor="query" className="sr-only">
          Fact scenario query
        </label>
        <textarea
          id="query"
          className="query-input"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          rows={7}
          placeholder="Example: State as appellant filed a criminal appeal. Delay condonation was refused and the appeal was dismissed as time-barred. Find SC/HC precedents."
        />

        {chips.length > 0 && (
          <div className="prompt-block" aria-label="Smart prompts">
            <p className="prompt-label">Quick improvements</p>
            <div className="prompt-chip-row">
              {chips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  className="prompt-chip"
                  onClick={() => onQueryChange(appendFragment(query, chip.fragment))}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="action-row">
          <button className="primary-btn" type="submit" disabled={isLoading}>
            {isLoading ? "Searching precedents..." : "Run automated search"}
          </button>
          {stricterRewrite && (
            <button
              type="button"
              className="secondary-btn"
              onClick={() => onQueryChange(stricterRewrite)}
            >
              Make query stricter
            </button>
          )}
        </div>
      </form>

      <p className="compliance-note">
        Compliance mode: no CAPTCHA or Cloudflare bypass techniques are used.
      </p>
      <p className={statusClass(status)} aria-live="polite">
        {statusText}
      </p>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
