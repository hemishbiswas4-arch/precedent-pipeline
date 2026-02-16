import assert from "node:assert/strict";
import test from "node:test";
import { runHybridSearch } from "@/lib/retrieval/hybrid";
import type { RetrievalProvider } from "@/lib/retrieval/providers/types";

const lexicalProvider: RetrievalProvider = {
  id: "indiankanoon_api",
  supportsDetailFetch: true,
  async search() {
    return {
      cases: [
        {
          source: "indiankanoon",
          title: "State v Accused",
          url: "https://indiankanoon.org/doc/123/",
          snippet: "criminal appeal dismissed",
          court: "SC",
        },
      ],
      debug: {
        searchQuery: "criminal appeal",
        status: 200,
        ok: true,
        parsedCount: 1,
        parserMode: "ik_api",
        cloudflareDetected: false,
        challengeDetected: false,
      },
    };
  },
};

test("runHybridSearch degrades to lexical output when semantic path is unavailable", async () => {
  const result = await runHybridSearch({
    searchInput: {
      phrase: "criminal appeal",
      courtScope: "SC",
      maxResultsPerPhrase: 8,
      maxPages: 1,
      crawlMaxElapsedMs: 2000,
      fetchTimeoutMs: 1200,
      max429Retries: 0,
    },
    lexicalProvider,
  });

  assert.equal(result.cases.length, 1);
  assert.equal(result.debug.lexicalCandidateCount, 1);
  assert.equal(result.debug.semanticCandidateCount, 0);
});
