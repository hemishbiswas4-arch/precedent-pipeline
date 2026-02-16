import assert from "node:assert/strict";
import test from "node:test";
import { buildPropositionChecklist, splitByProposition } from "@/lib/proposition-gate";
import type { ContextProfile, ScoredCase } from "@/lib/types";

function scored(input: Partial<ScoredCase> & Pick<ScoredCase, "url" | "title" | "snippet">): ScoredCase {
  return {
    source: "indiankanoon",
    court: "SC",
    score: 0.58,
    reasons: ["test"],
    selectionSummary: "test candidate",
    verification: {
      anchorsMatched: 1,
      issuesMatched: 1,
      proceduresMatched: 1,
      detailChecked: true,
      hasRelationSentence: true,
      hasPolaritySentence: true,
      hasHookIntersectionSentence: true,
      hasRoleSentence: true,
      hasChainSentence: true,
    },
    ...input,
  };
}

const context: ContextProfile = {
  domains: ["criminal"],
  issues: ["sanction required"],
  statutesOrSections: ["section 197 crpc", "section 19 prevention of corruption act"],
  procedures: ["criminal appeal"],
  actors: ["state"],
  anchors: ["sanction", "appeal", "section 197"],
};

test("splitByProposition keeps contradiction cases out of strict and related lanes", () => {
  const checklist = buildPropositionChecklist({
    context,
    cleanedQuery:
      "state criminal appeal whether sanction required under section 197 crpc read with section 19 pc act",
  });

  const contradiction = scored({
    url: "https://indiankanoon.org/doc/9001/",
    title: "State v. Accused",
    snippet:
      "criminal appeal under section 197 crpc where court held sanction not required for prosecution",
    detailText:
      "In this case, the Court held sanction not required and previous sanction was unnecessary.",
  });

  const split = splitByProposition([contradiction], checklist);
  assert.equal(split.exactStrict.length, 0);
  assert.equal(split.exactProvisional.length, 0);
  assert.equal(split.nearMiss.length, 0);
});

test("splitByProposition keeps context-aware related lane available when strict criteria are missed", () => {
  const checklist = buildPropositionChecklist({
    context,
    cleanedQuery:
      "state criminal appeal whether sanction required under section 197 crpc read with section 19 pc act",
  });

  const relatedCandidate = scored({
    url: "https://indiankanoon.org/doc/9002/",
    title: "State v. Public Servant",
    snippet:
      "criminal appeal discusses section 197 crpc sanction required for prosecution of a public servant",
    detailText:
      "The Court examined whether section 197 CrPC sanction required in prosecution appeals and the role of official duty nexus.",
    verification: {
      anchorsMatched: 2,
      issuesMatched: 1,
      proceduresMatched: 2,
      detailChecked: false,
      hasRelationSentence: false,
      hasPolaritySentence: false,
      hasHookIntersectionSentence: false,
      hasRoleSentence: false,
      hasChainSentence: false,
    },
  });

  const split = splitByProposition([relatedCandidate], checklist);
  assert.equal(split.exactStrict.length, 0);
  assert.ok(split.exactProvisional.length + split.nearMiss.length >= 1);
});

test("relaxed consumer gate can promote structurally strong but polarity-implicit candidates to provisional exact", () => {
  const checklist = buildPropositionChecklist({
    context,
    cleanedQuery:
      "state criminal appeal whether sanction required under section 197 crpc read with section 19 pc act",
  });

  const structurallyStrong = scored({
    url: "https://indiankanoon.org/doc/9010/",
    title: "State v Public Servant",
    snippet:
      "criminal appeal discussing section 197 crpc and section 19 prevention of corruption act in prosecution of public servant",
    detailText:
      "The Court examined the interplay between section 197 CrPC and section 19 of the Prevention of Corruption Act in a prosecution appeal.",
    verification: {
      anchorsMatched: 2,
      issuesMatched: 1,
      proceduresMatched: 2,
      detailChecked: true,
      hasRelationSentence: true,
      hasPolaritySentence: false,
      hasHookIntersectionSentence: true,
      hasRoleSentence: true,
      hasChainSentence: true,
    },
  });

  const split = splitByProposition([structurallyStrong], checklist);
  assert.equal(split.exactStrict.length, 0);
  assert.ok(split.exactProvisional.length >= 1);
});

test("disjunctive query alternatives do not force all factual hook groups as required", () => {
  const disjunctiveContext: ContextProfile = {
    domains: ["criminal"],
    issues: ["discharge", "framing of charge"],
    statutesOrSections: ["section 304 ipc"],
    procedures: ["revision", "appeal"],
    actors: ["state"],
    anchors: ["section 304 ipc", "road accident", "rash driving", "knowledge", "negligence"],
  };

  const checklist = buildPropositionChecklist({
    context: disjunctiveContext,
    cleanedQuery:
      "state revision or appeal against discharge or framing of charge under section 304 ipc in road accidents rash or drunken driving knowledge versus negligence",
    reasonerPlan: {
      proposition: {
        actors: ["state"],
        proceeding: ["revision", "appeal"],
        legal_hooks: ["section 304 ipc", "road accident", "rash driving", "knowledge", "negligence"],
        outcome_required: ["discharge", "framing of charge"],
        outcome_negative: [],
        jurisdiction_hint: "ANY",
        hook_groups: [
          { group_id: "sec_304", terms: ["section 304 ipc"], min_match: 1, required: true },
          { group_id: "road", terms: ["road accident"], min_match: 1, required: true },
          { group_id: "rash", terms: ["rash driving"], min_match: 1, required: true },
          { group_id: "knowledge", terms: ["knowledge"], min_match: 1, required: true },
        ],
        relations: [
          { type: "interacts_with", left_group_id: "sec_304", right_group_id: "road", required: true },
        ],
        outcome_constraint: {
          polarity: "unknown",
          terms: ["discharge", "framing of charge"],
          contradiction_terms: [],
        },
        interaction_required: true,
      },
      must_have_terms: ["section 304 ipc", "road accident"],
      must_not_have_terms: [],
      query_variants_strict: ["section 304 ipc road accident discharge framing of charge"],
      query_variants_broad: ["section 304 ipc road accident"],
      case_anchors: ["section 304 ipc"],
    },
  });

  const requiredHooks = checklist.hookGroups.filter((group) => group.required);
  assert.ok(requiredHooks.length >= 1);
  assert.ok(requiredHooks.length <= 2);
  assert.ok(
    checklist.hookGroups.some(
      (group) => group.terms.some((term) => term.includes("road accident")) && !group.required,
    ),
  );
  assert.equal(checklist.interactionRequired, false);
});

test("section-family aliases are deduplicated for limitation section 5 hooks", () => {
  const checklist = buildPropositionChecklist({
    context: {
      domains: ["criminal", "appellate"],
      issues: [],
      statutesOrSections: ["section 5", "limitation act"],
      procedures: ["appeal", "criminal appeal", "appeal against acquittal"],
      actors: ["state"],
      anchors: ["section 5", "limitation act", "appeal against acquittal"],
    },
    cleanedQuery:
      "can delay in filing a criminal appeal by the state be condoned under section 5 of the limitation act when appeal against acquittal is filed late",
  });

  const required = checklist.hookGroups.filter((group) => group.required);
  assert.ok(required.length >= 1);
  assert.ok(required.length <= 2);
  assert.equal(checklist.interactionRequired, false);
  assert.equal(checklist.relations.filter((relation) => relation.required).length, 0);
});

test("statutory-only proceeding terms are not forced when legal hook axis is already required", () => {
  const checklist = buildPropositionChecklist({
    context: {
      domains: ["criminal"],
      issues: ["civil nature allegations"],
      statutesOrSections: ["section 482 crpc", "crpc"],
      procedures: ["section 482 crpc"],
      actors: [],
      anchors: ["section 482 crpc", "quashing"],
    },
    cleanedQuery:
      "under section 482 crpc when can a high court quash fir where allegations are civil in nature",
  });

  const proceedingAxis = checklist.axes.find((axis) => axis.key === "proceeding");
  assert.ok(proceedingAxis);
  assert.equal(proceedingAxis?.required, false);
  assert.equal(checklist.hookGroups.filter((group) => group.required).length >= 1, true);
});

test("single-hook contextual statutory queries can pass as exact provisional", () => {
  const checklist = buildPropositionChecklist({
    context: {
      domains: ["criminal"],
      issues: ["civil nature allegations"],
      statutesOrSections: ["section 482 crpc"],
      procedures: ["section 482 crpc"],
      actors: [],
      anchors: ["section 482 crpc", "quashing", "civil nature"],
    },
    cleanedQuery:
      "under section 482 crpc when can a high court quash fir where allegations are civil in nature",
  });

  const candidate = scored({
    url: "https://indiankanoon.org/doc/12345678/",
    title: "ABC vs State",
    snippet:
      "High Court considered section 482 crpc for quashing FIR where allegations disclosed a civil dispute.",
    detailText:
      "The High Court held that under section 482 CrPC, proceedings may be quashed where allegations are predominantly civil in nature and continuation would be abuse of process.",
    verification: {
      anchorsMatched: 2,
      issuesMatched: 1,
      proceduresMatched: 1,
      detailChecked: true,
      hasRelationSentence: false,
      hasPolaritySentence: false,
      hasHookIntersectionSentence: true,
      hasRoleSentence: false,
      hasChainSentence: false,
    },
  });

  const split = splitByProposition([candidate], checklist);
  assert.ok(split.exactProvisional.length >= 1 || split.exactStrict.length >= 1);
});
