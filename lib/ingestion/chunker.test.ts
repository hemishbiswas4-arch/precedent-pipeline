import assert from "node:assert/strict";
import test from "node:test";
import { chunkLegalDocument } from "@/lib/ingestion/chunker";

test("chunkLegalDocument keeps citation and section tokens while splitting", () => {
  const document = {
    docId: "1234",
    title: "Sample Judgment",
    court: "SC" as const,
    decisionDate: "2022-01-10",
    url: "https://indiankanoon.org/doc/1234/",
    citations: ["AIR 2020 SC 100"],
    statuteTokens: ["section 197 crpc", "section 19 pc act"],
    text: [
      "Section 197 CrPC requires prior sanction for prosecution of public servants.",
      "Read with Section 19 of the Prevention of Corruption Act, the Court evaluated statutory interaction.",
      "AIR 2020 SC 100 was cited to reject delay condonation arguments.",
      "The appeal was dismissed as time barred.",
      "The prosecution argued that the sanction requirement is procedural and can be addressed later.",
      "The defence argued that absence of sanction vitiated the cognizance order from inception.",
      "The court reviewed precedent discussing when sanction defects are curable and when they are fatal.",
      "Ultimately the bench held that statutory safeguards protect both institutional function and fair trial rights.",
    ].join(" "),
    sourceVersion: "ik_api_v1",
  };

  const chunks = chunkLegalDocument({
    document,
    minChunkChars: 80,
    maxChunkChars: 120,
  });

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.some((chunk) => chunk.text.toLowerCase().includes("section 197 crpc")));
  assert.ok(chunks.some((chunk) => chunk.text.toLowerCase().includes("air 2020 sc 100")));
  assert.equal(chunks[0].docId, "1234");
});
