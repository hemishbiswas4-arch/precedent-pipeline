import assert from "node:assert/strict";
import test from "node:test";
import { hybridTestUtils } from "@/lib/retrieval/hybrid";
import { CaseCandidate } from "@/lib/types";

function candidate(input: {
  id: number;
  title: string;
  snippet: string;
  court?: "SC" | "HC";
  lexicalRank?: number;
  semanticRank?: number;
}): CaseCandidate {
  return {
    source: "indiankanoon",
    title: input.title,
    url: `https://indiankanoon.org/doc/${input.id}/`,
    snippet: input.snippet,
    court: input.court ?? "SC",
    retrieval: {
      lexicalRank: input.lexicalRank,
      semanticRank: input.semanticRank,
      sourceTags: [],
    },
  };
}

test("fuseCandidates merges lexical and semantic hits with fused scores", () => {
  const lexical = [
    candidate({ id: 1, title: "State v A", snippet: "section 197 crpc", lexicalRank: 1 }),
    candidate({ id: 2, title: "State v B", snippet: "section 19 pc act", lexicalRank: 2 }),
  ];
  const semantic = [
    candidate({ id: 2, title: "State v B", snippet: "section 19 pc act", semanticRank: 1 }),
    candidate({ id: 3, title: "State v C", snippet: "limitation appeal", semanticRank: 2 }),
  ];

  const fused = hybridTestUtils.fuseCandidates({
    lexical,
    semantic,
    limit: 3,
  });

  assert.equal(fused.length, 3);
  assert.ok(fused.some((item) => item.url.endsWith("/2/")));
  const combined = fused.find((item) => item.url.endsWith("/2/"));
  assert.ok((combined?.retrieval?.fusionScore ?? 0) > 0);
  assert.ok(combined?.retrieval?.sourceTags?.includes("fused"));
});
