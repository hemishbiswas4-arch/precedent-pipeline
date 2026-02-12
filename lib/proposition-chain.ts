export type PropositionElementKey = "actor" | "proceeding" | "legal_hook" | "outcome";

export type PropositionRoleTarget = "appellant" | "respondent" | "prosecution" | "none";

export type PropositionRoleConstraint = {
  id: string;
  label: string;
  actorTokens: string[];
  target: PropositionRoleTarget;
  required: boolean;
};

export type PropositionStepKind = "role" | "proceeding" | "outcome" | "chain";

export type PropositionStepConstraint = {
  id: string;
  label: string;
  key: PropositionElementKey | "chain";
  kind: PropositionStepKind;
  terms: string[];
  required: boolean;
  minMatch: number;
};

export type PropositionChainConstraint = {
  id: string;
  label: string;
  leftTerms: string[];
  rightTerms: string[];
  windowChars: number;
  required: boolean;
};

export type PropositionGraph = {
  mandatorySteps: PropositionStepConstraint[];
  peripheralSteps: PropositionStepConstraint[];
  roleConstraints: PropositionRoleConstraint[];
  chainConstraints: PropositionChainConstraint[];
  enforceNoHookRoleChain: boolean;
};

export type PropositionGraphSignal = {
  mandatoryStepResults: Array<{ id: string; label: string; ok: boolean }>;
  peripheralStepResults: Array<{ id: string; label: string; ok: boolean }>;
  actorRoleSatisfied: boolean;
  proceedingRoleSatisfied: boolean;
  outcomeRoleSatisfied: boolean;
  chainSatisfied: boolean;
  matchedMandatorySteps: string[];
  missingMandatorySteps: string[];
  matchedPeripheralSteps: string[];
  missingPeripheralSteps: string[];
  evidence: string[];
};

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[`"'[\]{}]/g, " ")
    .replace(/[^a-z0-9\s()./:-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(text: string, term: string): boolean {
  if (!term) return false;
  if (term.includes(" ")) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function containsOutcomeContradictionTerm(text: string, term: string): boolean {
  if (!term) return false;
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  if (!containsTerm(text, normalizedTerm)) return false;

  if (normalizedTerm === "condoned" || normalizedTerm === "allowed" || normalizedTerm === "granted") {
    const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const negated = new RegExp(`\\b(?:not|no|without)\\s+(?:been\\s+)?${escaped}\\b`, "i");
    if (negated.test(text)) return false;
  }
  return true;
}

function findTermPositions(text: string, term: string): number[] {
  if (!term) return [];
  const positions: number[] = [];
  if (term.includes(" ")) {
    let index = text.indexOf(term);
    while (index >= 0) {
      positions.push(index);
      index = text.indexOf(term, index + term.length);
    }
    return positions;
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b${escaped}\\b`, "gi");
  let match = regex.exec(text);
  while (match) {
    positions.push(match.index);
    match = regex.exec(text);
  }
  return positions;
}

function relationSatisfiedByProximity(input: {
  text: string;
  leftTerms: string[];
  rightTerms: string[];
  windowChars: number;
}): boolean {
  const leftPositions = input.leftTerms.flatMap((term) => findTermPositions(input.text, term)).slice(0, 36);
  const rightPositions = input.rightTerms.flatMap((term) => findTermPositions(input.text, term)).slice(0, 36);
  if (leftPositions.length === 0 || rightPositions.length === 0) return false;
  for (const left of leftPositions) {
    for (const right of rightPositions) {
      if (Math.abs(left - right) <= input.windowChars) return true;
    }
  }
  return false;
}

function termMatches(text: string, terms: string[], minMatch: number): { ok: boolean; matched: string[] } {
  const matched = terms.filter((term) => containsTerm(text, normalizeText(term))).slice(0, 8);
  return {
    ok: matched.length >= Math.max(1, minMatch),
    matched,
  };
}

function roleSatisfied(text: string, role: PropositionRoleConstraint): { ok: boolean; evidence?: string } {
  if (role.target === "none" || role.actorTokens.length === 0) {
    return { ok: !role.required };
  }

  const actorAlternation = role.actorTokens
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!actorAlternation) return { ok: !role.required };

  const actorBlock = `(?:${actorAlternation})`;
  const patterns: Array<{ regex: RegExp; label: string }> = [];

  if (role.target === "appellant") {
    patterns.push(
      {
        regex: new RegExp(`${actorBlock}.{0,90}(?:filed|preferred|presented|instituted|moved).{0,90}appeal`, "i"),
        label: "actor-filed-appeal",
      },
      {
        regex: new RegExp(`(?:appellant|appellants)\\s*[:\\-]?\\s*(?:the\\s+)?${actorBlock}`, "i"),
        label: "actor-as-appellant",
      },
      {
        regex: new RegExp(`^\\s*(?:the\\s+)?${actorBlock}.{0,70}\\bvs\\b`, "i"),
        label: "actor-first-party-vs",
      },
    );
  } else if (role.target === "respondent") {
    patterns.push(
      {
        regex: new RegExp(`(?:respondent|respondents)\\s*[:\\-]?\\s*(?:the\\s+)?${actorBlock}`, "i"),
        label: "actor-as-respondent",
      },
      {
        regex: new RegExp(`\\bvs\\b.{0,90}(?:the\\s+)?${actorBlock}`, "i"),
        label: "actor-second-party-vs",
      },
    );
  } else if (role.target === "prosecution") {
    patterns.push(
      {
        regex: new RegExp(`${actorBlock}.{0,70}(?:prosecution|prosecutor|investigation)`, "i"),
        label: "actor-prosecution-link",
      },
      {
        regex: new RegExp(`(?:prosecution|prosecutor).{0,70}${actorBlock}`, "i"),
        label: "prosecution-actor-link",
      },
    );
  }

  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      return { ok: true, evidence: `${role.label}:${pattern.label}` };
    }
  }
  return { ok: false };
}

export function evaluatePropositionGraph(input: {
  text: string;
  graph?: PropositionGraph;
  contradictionTerms?: string[];
}): PropositionGraphSignal {
  const graph = input.graph;
  if (!graph) {
    return {
      mandatoryStepResults: [],
      peripheralStepResults: [],
      actorRoleSatisfied: true,
      proceedingRoleSatisfied: true,
      outcomeRoleSatisfied: true,
      chainSatisfied: true,
      matchedMandatorySteps: [],
      missingMandatorySteps: [],
      matchedPeripheralSteps: [],
      missingPeripheralSteps: [],
      evidence: [],
    };
  }

  const text = normalizeText(input.text);
  const evidence: string[] = [];

  const roleResult = graph.roleConstraints
    .filter((role) => role.required)
    .map((role) => roleSatisfied(text, role))
    .every((result) => {
      if (result.ok && result.evidence) evidence.push(result.evidence);
      return result.ok;
    });

  const mandatoryStepResults = graph.mandatorySteps.map((step) => {
    if (step.kind === "role") {
      return {
        id: step.id,
        label: step.label,
        ok: roleResult,
      };
    }
    if (step.kind === "chain") {
      const constraint = graph.chainConstraints.find((item) => item.id === step.id);
      if (!constraint) {
        return {
          id: step.id,
          label: step.label,
          ok: false,
        };
      }
      const ok = relationSatisfiedByProximity({
        text,
        leftTerms: constraint.leftTerms.map((term) => normalizeText(term)),
        rightTerms: constraint.rightTerms.map((term) => normalizeText(term)),
        windowChars: constraint.windowChars,
      });
      if (ok) evidence.push(`chain:${constraint.label}`);
      return {
        id: step.id,
        label: step.label,
        ok,
      };
    }
    const match = termMatches(
      text,
      step.terms.map((term) => normalizeText(term)),
      step.minMatch,
    );
    if (match.ok && match.matched.length > 0) {
      evidence.push(`${step.kind}:${step.label}:${match.matched.slice(0, 2).join(", ")}`);
    }
    return {
      id: step.id,
      label: step.label,
      ok: match.ok,
    };
  });

  const peripheralStepResults = graph.peripheralSteps.map((step) => {
    const match = termMatches(
      text,
      step.terms.map((term) => normalizeText(term)),
      step.minMatch,
    );
    return {
      id: step.id,
      label: step.label,
      ok: match.ok,
    };
  });

  const matchedMandatorySteps = mandatoryStepResults.filter((step) => step.ok).map((step) => step.id);
  const missingMandatorySteps = mandatoryStepResults.filter((step) => !step.ok).map((step) => step.id);
  const matchedPeripheralSteps = peripheralStepResults.filter((step) => step.ok).map((step) => step.id);
  const missingPeripheralSteps = peripheralStepResults.filter((step) => !step.ok).map((step) => step.id);

  const proceedingRoleSatisfied = mandatoryStepResults
    .filter((step) => step.id.startsWith("proceeding:"))
    .every((step) => step.ok);
  const outcomeRoleSatisfied = mandatoryStepResults
    .filter((step) => step.id.startsWith("outcome:"))
    .every((step) => step.ok);
  const chainSatisfied = mandatoryStepResults
    .filter((step) => step.id.startsWith("chain:"))
    .every((step) => step.ok);

  const contradiction = (input.contradictionTerms ?? []).some((term) =>
    containsOutcomeContradictionTerm(text, term),
  );
  if (contradiction) {
    evidence.push("graph:contradiction-term");
  }

  return {
    mandatoryStepResults,
    peripheralStepResults,
    actorRoleSatisfied: roleResult,
    proceedingRoleSatisfied,
    outcomeRoleSatisfied,
    chainSatisfied,
    matchedMandatorySteps,
    missingMandatorySteps,
    matchedPeripheralSteps,
    missingPeripheralSteps,
    evidence,
  };
}
