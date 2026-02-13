import assert from "node:assert/strict";
import test from "node:test";
import { scoreCases } from "@/lib/scoring";
import type { ContextProfile } from "@/lib/types";

const context: ContextProfile = {
  domains: ["criminal", "appellate"],
  issues: ["delay condonation refused"],
  statutesOrSections: ["section 5 limitation act", "section 378 crpc"],
  procedures: ["criminal appeal"],
  actors: ["state"],
  anchors: ["delay", "condonation", "appeal", "limitation"],
};

const candidates = [
  {
    source: "indiankanoon" as const,
    title: "State v. Accused on 12 March 2021",
    url: "https://indiankanoon.org/doc/1001/",
    snippet: "criminal appeal filed by state dismissed as time barred; delay condonation refused",
    court: "SC" as const,
  },
  {
    source: "indiankanoon" as const,
    title: "Unrelated civil decree order",
    url: "https://indiankanoon.org/doc/1002/",
    snippet: "civil suit decree execution and injunction dispute",
    court: "HC" as const,
  },
];

const canonicalLexicalProfile = {
  mustIncludeTokens: ["state", "criminal appeal", "delay condonation refused", "section 5 limitation act"],
  strictVariantTokens: ["state criminal appeal delay condonation refused limitation"],
  checklistTokens: ["state", "criminal", "appeal", "delay", "condonation", "limitation"],
  contradictionTokens: ["delay condoned", "appeal allowed"],
};

test("paraphrase-equivalent queries preserve top-ranked case", () => {
  const q1 = "state criminal appeal dismissed as time barred after delay condonation refused";
  const q2 = "appeal by state rejected for limitation because condonation of delay was denied";

  const r1 = scoreCases(q1, context, candidates, { canonicalLexicalProfile });
  const r2 = scoreCases(q2, context, candidates, { canonicalLexicalProfile });

  assert.equal(r1[0]?.url, "https://indiankanoon.org/doc/1001/");
  assert.equal(r2[0]?.url, "https://indiankanoon.org/doc/1001/");
});
