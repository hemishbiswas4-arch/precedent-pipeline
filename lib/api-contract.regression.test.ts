import assert from "node:assert/strict";
import test from "node:test";
import type { SearchResponse } from "@/lib/types";

test("SearchResponse remains backward-compatible without new trace fields", () => {
  const payload: SearchResponse = {
    query: "sample query",
    context: {
      domains: [],
      issues: [],
      statutesOrSections: [],
      procedures: [],
      actors: [],
      anchors: [],
    },
    keywordPack: {
      primary: [],
      legalSignals: [],
      searchPhrases: [],
    },
    totalFetched: 0,
    filteredCount: 0,
    cases: [],
    notes: [],
  };
  assert.equal(payload.query, "sample query");
  assert.ok(Array.isArray(payload.cases));
});
