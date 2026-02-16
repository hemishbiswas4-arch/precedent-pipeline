import assert from "node:assert/strict";
import test from "node:test";
import { scoreCases } from "@/lib/scoring";
import type { ContextProfile } from "@/lib/types";

const context: ContextProfile = {
  domains: ["criminal"],
  issues: ["sanction required"],
  statutesOrSections: ["section 197 crpc"],
  procedures: ["criminal appeal"],
  actors: ["state"],
  anchors: ["sanction", "appeal", "criminal"],
};

test("rerank signal influences final score ordering when lexical ties are close", () => {
  const query = "whether sanction under section 197 crpc is required";

  const cases = [
    {
      source: "indiankanoon" as const,
      title: "Case A",
      url: "https://indiankanoon.org/doc/1/",
      snippet: "sanction under section 197 crpc considered",
      court: "SC" as const,
      retrieval: {
        rerankScore: 0.92,
        fusionScore: 0.14,
      },
    },
    {
      source: "indiankanoon" as const,
      title: "Case B",
      url: "https://indiankanoon.org/doc/2/",
      snippet: "sanction under section 197 crpc considered",
      court: "SC" as const,
      retrieval: {
        rerankScore: 0.2,
        fusionScore: 0.14,
      },
    },
  ];

  const ranked = scoreCases(query, context, cases);
  assert.equal(ranked[0].url, "https://indiankanoon.org/doc/1/");
});
