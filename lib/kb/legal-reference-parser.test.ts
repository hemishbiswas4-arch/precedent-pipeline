import assert from "node:assert/strict";
import test from "node:test";
import {
  expandMinimalTransitionAliases,
  isLikelyLegalDisjunction,
  parseLegalReferences,
} from "@/lib/kb/legal-reference-parser";

test("CrPC and BNSS transition references are canonicalized and expanded", () => {
  const refs = parseLegalReferences(
    "References to the Code of Criminal Procedure in existing laws or proceedings must be construed as references to the BNSS",
  );

  assert.ok(refs.statutes.some((term) => term.includes("code of criminal procedure")));
  assert.ok(refs.statutes.some((term) => term.includes("bnss")));
  assert.ok(refs.transitionAliases.some((term) => term.includes("crpc")));
  assert.ok(refs.transitionAliases.some((term) => term.includes("bnss")));

  const aliases = expandMinimalTransitionAliases(refs.statutes);
  assert.ok(aliases.some((term) => term.includes("crpc")));
  assert.ok(aliases.some((term) => term.includes("bnss")));
});

test("Notification identifiers are extracted without being misparsed as sections", () => {
  const refs = parseLegalReferences(
    "Ministry of Law and Justice Notification dated 16 July 2024 (S.O. 2790(E)) issued under Section 8 of the General Clauses Act",
  );

  assert.ok(refs.notificationIds.includes("s.o. 2790(e)"));
  assert.ok(refs.notificationDates.includes("16 july 2024"));
  assert.equal(refs.sections.some((term) => term.includes("2790(e)")), false);
  assert.ok(refs.sections.some((term) => term.includes("section 8")));
});

test("Bare subsection references in legal context are preserved", () => {
  const refs = parseLegalReferences("prosecution under 13(1)(e) pc act and section 197 crpc");
  assert.ok(refs.sections.some((term) => term.includes("section 13(1)(e)")));
  assert.ok(refs.sections.some((term) => term.includes("section 197")));
});

test("Disjunction detection ignores generic phrasing but catches legal alternatives", () => {
  const generic = parseLegalReferences(
    "references to the code of criminal procedure in existing laws or proceedings must be construed as references to bnss",
  );
  assert.equal(
    isLikelyLegalDisjunction(
      "references to the code of criminal procedure in existing laws or proceedings must be construed as references to bnss",
      generic,
    ),
    false,
  );

  const legal = parseLegalReferences("whether section 302 ipc or section 304 ipc applies");
  assert.equal(isLikelyLegalDisjunction("whether section 302 ipc or section 304 ipc applies", legal), true);
});
