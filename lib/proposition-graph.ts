import { ContextProfile } from "@/lib/types";
import { ReasonerOutcomePolarity } from "@/lib/reasoner-schema";
import {
  PropositionChainConstraint,
  PropositionGraph,
  PropositionRoleConstraint,
  PropositionRoleTarget,
  PropositionStepConstraint,
} from "@/lib/proposition-chain";

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[`"'[\]{}]/g, " ")
    .replace(/[^a-z0-9\s()./:-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function outcomeTermsFromPolarity(polarity: ReasonerOutcomePolarity): string[] {
  if (polarity === "required") return ["required", "mandatory", "necessary", "sanction required", "prior sanction"];
  if (polarity === "not_required")
    return ["not required", "no sanction required", "without sanction", "sanction not required"];
  if (polarity === "refused")
    return ["refused", "rejected", "not condoned", "condonation refused", "delay not condoned"];
  if (polarity === "dismissed")
    return ["dismissed", "time barred", "barred by limitation", "appeal dismissed"];
  if (polarity === "allowed") return ["allowed", "granted", "condoned", "restored"];
  if (polarity === "quashed") return ["quashed", "set aside", "proceedings quashed"];
  return [];
}

function deriveRoleTarget(cleanedQuery: string, context: ContextProfile): PropositionRoleTarget {
  const q = normalizeText(cleanedQuery);
  if (/\brespondent\b/.test(q)) return "respondent";
  if (/\bprosecution\b/.test(q) && !/\bappeal\b/.test(q)) return "prosecution";
  if (/\bappellant\b/.test(q)) return "appellant";
  if (context.procedures.some((item) => /\bappeal\b/i.test(item)) && context.actors.length > 0) return "appellant";
  return "none";
}

function actorLexemes(actor: string): string[] {
  const normalized = normalizeText(actor);
  if (!normalized) return [];
  if (normalized === "state") return ["state", "state of", "government", "union of india"];
  if (normalized === "prosecution") return ["prosecution", "state", "state counsel"];
  if (normalized === "department") return ["department", "authority", "government"];
  if (normalized === "public servant") return ["public servant", "officer"];
  return [normalized];
}

function procedureLexemes(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  const output = [normalized];
  if (normalized.includes("criminal appeal")) output.push("criminal appeal", "appeal against acquittal");
  if (normalized.includes("appeal")) output.push("appeal", "appellant");
  if (normalized.includes("delay condonation")) {
    output.push("delay condonation", "condonation of delay", "application for condonation", "section 5 limitation");
  }
  if (normalized.includes("sanction for prosecution")) {
    output.push(
      "sanction",
      "sanction required",
      "prior sanction",
      "previous sanction",
      "prosecution sanction",
      "sanction under section 197",
      "sanction under section 19",
    );
  }
  return unique(output);
}

function issueLexemes(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  const output = [normalized];
  if (normalized.includes("delay condonation refused")) {
    output.push(
      "delay not condoned",
      "condonation refused",
      "condonation rejected",
      "not been condoned",
      "application dismissed",
    );
  }
  if (normalized.includes("appeal dismissed as time barred")) {
    output.push("time barred", "barred by limitation", "dismissed");
  }
  if (normalized.includes("sanction required")) output.push("sanction required", "prior sanction");
  if (normalized.includes("sanction not required")) output.push("sanction not required", "without sanction");
  return unique(output);
}

function step(
  id: string,
  label: string,
  kind: PropositionStepConstraint["kind"],
  key: PropositionStepConstraint["key"],
  terms: string[],
  required: boolean,
  minMatch = 1,
): PropositionStepConstraint {
  return {
    id,
    label,
    kind,
    key,
    terms: unique(terms.map((term) => normalizeText(term)).filter((term) => term.length > 1)),
    required,
    minMatch,
  };
}

export function compilePropositionGraph(input: {
  cleanedQuery: string;
  context: ContextProfile;
  actorTerms: string[];
  proceedingTerms: string[];
  outcomeTerms: string[];
  outcomePolarity: ReasonerOutcomePolarity;
  hookGroupCount: number;
}): PropositionGraph {
  const q = normalizeText(input.cleanedQuery);
  const roleTarget = deriveRoleTarget(input.cleanedQuery, input.context);
  const actorTokens = unique(
    (input.actorTerms.length > 0 ? input.actorTerms : input.context.actors).flatMap((actor) => actorLexemes(actor)),
  );
  const proceedingTokens = unique(
    (input.proceedingTerms.length > 0 ? input.proceedingTerms : input.context.procedures).flatMap((value) =>
      procedureLexemes(value),
    ),
  );
  const outcomePolarityTerms = outcomeTermsFromPolarity(input.outcomePolarity);
  const outcomeTokens = unique([
    ...input.outcomeTerms.flatMap((value) => issueLexemes(value)),
    ...input.context.issues.flatMap((value) => issueLexemes(value)),
    ...outcomePolarityTerms,
  ]);

  const noHookMode = input.hookGroupCount === 0;
  const roleConstraintRequired = noHookMode && roleTarget !== "none" && actorTokens.length > 0;
  const roleConstraints: PropositionRoleConstraint[] = roleConstraintRequired
    ? [
        {
          id: `role:${roleTarget}`,
          label: `actor as ${roleTarget}`,
          actorTokens,
          target: roleTarget,
          required: true,
        },
      ]
    : [];

  const mandatorySteps: PropositionStepConstraint[] = [];
  const peripheralSteps: PropositionStepConstraint[] = [];
  const chainConstraints: PropositionChainConstraint[] = [];

  if (roleConstraintRequired) {
    mandatorySteps.push(
      step(
        "role:actor",
        `actor role ${roleTarget}`,
        "role",
        "actor",
        [...actorTokens, roleTarget],
        true,
      ),
    );
  }

  if (proceedingTokens.length > 0) {
    mandatorySteps.push(
      step("proceeding:primary", "proceeding posture", "proceeding", "proceeding", proceedingTokens, true),
    );
  }

  if (outcomeTokens.length > 0) {
    mandatorySteps.push(
      step(
        "outcome:primary",
        `outcome polarity ${input.outcomePolarity}`,
        "outcome",
        "outcome",
        outcomeTokens,
        true,
      ),
    );
  }

  const hasCondonation = /condonation|delay condonation|section 5 limitation/.test(q) || proceedingTokens.some((token) => /condonation/.test(token));
  const refusalPolarity = input.outcomePolarity === "refused" || input.outcomePolarity === "dismissed";
  if (noHookMode && hasCondonation && refusalPolarity) {
    const leftTerms = unique(
      [
        "condonation of delay",
        "delay condonation",
        "application for condonation",
        "section 5 limitation",
      ].concat(proceedingTokens.filter((token) => /condonation|delay/.test(token))),
    );
    const rightTerms = unique(
      [
        "not condoned",
        "condonation refused",
        "condonation rejected",
        "time barred",
        "appeal dismissed",
        "barred by limitation",
      ].concat(outcomeTokens),
    );
    chainConstraints.push({
      id: "chain:condonation_refusal",
      label: "condonation refusal chain",
      leftTerms,
      rightTerms,
      windowChars: 260,
      required: true,
    });
    mandatorySteps.push(
      step(
        "chain:condonation_refusal",
        "condonation application linked to refusal/time-bar outcome",
        "chain",
        "chain",
        unique([...leftTerms, ...rightTerms]),
        true,
      ),
    );
  }

  for (const actor of actorTokens.slice(0, 2)) {
    peripheralSteps.push(step(`peripheral:actor:${actor}`, `actor mention: ${actor}`, "role", "actor", [actor], false));
  }
  for (const item of input.context.domains.slice(0, 2)) {
    const normalized = normalizeText(item);
    if (!normalized) continue;
    peripheralSteps.push(
      step(`peripheral:domain:${normalized}`, `domain anchor: ${normalized}`, "proceeding", "proceeding", [normalized], false),
    );
  }

  return {
    mandatorySteps: unique(mandatorySteps.map((item) => item.id)).map(
      (id) => mandatorySteps.find((item) => item.id === id)!,
    ),
    peripheralSteps: unique(peripheralSteps.map((item) => item.id)).map(
      (id) => peripheralSteps.find((item) => item.id === id)!,
    ),
    roleConstraints,
    chainConstraints,
    enforceNoHookRoleChain: noHookMode && mandatorySteps.length > 0,
  };
}
