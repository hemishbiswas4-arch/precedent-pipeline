import { buildIntentProfile } from "@/lib/pipeline/intent";

export type QueryCoachItem = {
  id: "actor" | "proceeding" | "outcome" | "hooks" | "exclusions";
  label: string;
  priority: "critical" | "optional";
  satisfied: boolean;
  detail: string;
};

export type QueryCoachResult = {
  score: number;
  grade: "STRONG" | "FAIR" | "WEAK";
  readiness: "NOT_READY" | "NEEDS_SPECIFICITY" | "READY_FOR_EXACT";
  readinessMessage: string;
  checklist: QueryCoachItem[];
  nextActions: string[];
  recommendedPattern?: string;
  stricterRewrite?: string;
};

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s()]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function hasExclusionCue(query: string): boolean {
  const q = query.toLowerCase();
  return /(not|without|except|rather than|instead of|not condoned|not required|no sanction)/.test(q);
}

function inferOutcomePhrase(query: string): string {
  const q = query.toLowerCase();
  if (/not\s+(?:been\s+)?condon(?:ed|able)|condonation\s+(?:was\s+)?(?:refused|rejected|denied)/.test(q)) {
    return "delay was not condoned and appeal was dismissed as time-barred";
  }
  if (/sanction\s+not\s+required|without\s+sanction|no\s+sanction\s+required/.test(q)) {
    return "sanction under the cited provision was held not required";
  }
  if (/sanction\s+required|prior\s+sanction|previous\s+sanction/.test(q)) {
    return "court held prior sanction was mandatory";
  }
  if (/quash|quashed/.test(q)) {
    return "criminal proceedings were quashed";
  }
  return "court outcome you want to find (for example refused, dismissed, allowed, quashed)";
}

function inferProceedingPhrase(query: string, procedures: string[]): string {
  const q = query.toLowerCase();
  if (/appeal\s+against\s+acquittal|section\s*378/.test(q)) return "criminal appeal against acquittal";
  if (q.includes("criminal appeal")) return "criminal appeal";
  if (procedures.length > 0) return procedures[0];
  return "proceeding posture (for example criminal appeal, revision, writ petition)";
}

function buildStricterRewrite(input: {
  cleanedQuery: string;
  actors: string[];
  procedures: string[];
  statutes: string[];
  issues: string[];
}): string | undefined {
  const actor = input.actors[0] ?? "the appellant";
  const proceeding = inferProceedingPhrase(input.cleanedQuery, input.procedures);
  const outcome = inferOutcomePhrase(input.cleanedQuery);
  const hookPhrase = input.statutes.length > 0 ? ` under ${input.statutes.slice(0, 2).join(" and ")}` : "";
  const issuePhrase = input.issues.length > 0 ? ` focusing on ${input.issues.slice(0, 2).join(" and ")}` : "";
  const rewrite = `${actor} in ${proceeding}${hookPhrase}; find SC/HC cases where the court held that ${outcome}${issuePhrase}.`;
  if (tokenize(rewrite).length < 8) return undefined;
  return rewrite;
}

function capGrade(
  grade: QueryCoachResult["grade"],
  ceiling: QueryCoachResult["grade"],
): QueryCoachResult["grade"] {
  const order: QueryCoachResult["grade"][] = ["WEAK", "FAIR", "STRONG"];
  return order.indexOf(grade) > order.indexOf(ceiling) ? ceiling : grade;
}

function buildRecommendedPattern(input: {
  actorSatisfied: boolean;
  proceedingSatisfied: boolean;
  outcomeSatisfied: boolean;
  hooksSatisfied: boolean;
  actorSample?: string;
  proceedingSample?: string;
  outcomeSample?: string;
  hookSample?: string;
}): string {
  const actor = input.actorSatisfied ? input.actorSample ?? "State as appellant" : "State as appellant";
  const proceeding = input.proceedingSatisfied
    ? input.proceedingSample ?? "criminal appeal"
    : "criminal appeal";
  const outcome = input.outcomeSatisfied
    ? input.outcomeSample ?? "appeal dismissed as time-barred"
    : "dismissed/refused/allowed/not required";
  const hooks = input.hooksSatisfied ? ` under ${input.hookSample ?? "relevant section/statute"}` : "";
  return `${actor} in ${proceeding}${hooks}; find SC/HC judgments where the court held ${outcome}.`;
}

export function evaluateQueryCoach(query: string): QueryCoachResult {
  const intent = buildIntentProfile(query);
  const actorSatisfied = intent.actors.length > 0;
  const proceedingSatisfied = intent.procedures.length > 0;
  const hooksSatisfied = intent.statutes.length > 0;
  const outcomeSatisfied = intent.issues.length > 0 || hasExclusionCue(intent.cleanedQuery);
  const exclusionsSatisfied = hasExclusionCue(intent.cleanedQuery);

  const checklist: QueryCoachItem[] = [
    {
      id: "actor",
      label: "Actor role",
      priority: "critical",
      satisfied: actorSatisfied,
      detail: actorSatisfied
        ? `Detected: ${intent.actors.slice(0, 3).join(", ")}`
        : "Add who is acting (State, accused, department, director, etc.).",
    },
    {
      id: "proceeding",
      label: "Proceeding/posture",
      priority: "critical",
      satisfied: proceedingSatisfied,
      detail: proceedingSatisfied
        ? `Detected: ${intent.procedures.slice(0, 3).join(", ")}`
        : "Add posture (criminal appeal, revision, writ, quashing, trial stage).",
    },
    {
      id: "outcome",
      label: "Outcome polarity",
      priority: "critical",
      satisfied: outcomeSatisfied,
      detail: outcomeSatisfied
        ? `Detected: ${intent.issues.slice(0, 3).join(", ") || "negative/positive outcome cues"}`
        : "Specify the exact outcome (refused, dismissed, allowed, quashed, required/not required).",
    },
    {
      id: "hooks",
      label: "Legal hooks (optional but strong)",
      priority: "optional",
      satisfied: hooksSatisfied,
      detail: hooksSatisfied
        ? `Detected: ${intent.statutes.slice(0, 3).join(", ")}`
        : "Add sections/statutes when known to improve doctrinal precision.",
    },
    {
      id: "exclusions",
      label: "Exclusion cues",
      priority: "optional",
      satisfied: exclusionsSatisfied,
      detail: exclusionsSatisfied
        ? "Detected exclusion/negation cues."
        : "Optional: add 'not/without/except' style cues to prevent adjacent doctrine drift.",
    },
  ];

  const score = Math.max(
    0,
    Math.min(
      1,
      (proceedingSatisfied ? 0.32 : 0) +
        (outcomeSatisfied ? 0.28 : 0) +
        (actorSatisfied ? 0.22 : 0) +
        (hooksSatisfied ? 0.13 : 0) +
        (exclusionsSatisfied ? 0.05 : 0),
    ),
  );

  let grade: QueryCoachResult["grade"] = score >= 0.75 ? "STRONG" : score >= 0.5 ? "FAIR" : "WEAK";
  if (!proceedingSatisfied) {
    grade = capGrade(grade, "FAIR");
  }
  if (!outcomeSatisfied && !hooksSatisfied) {
    grade = capGrade(grade, "WEAK");
  }

  let readiness: QueryCoachResult["readiness"] = "NOT_READY";
  if (actorSatisfied && proceedingSatisfied) {
    readiness = outcomeSatisfied || hooksSatisfied ? "READY_FOR_EXACT" : "NEEDS_SPECIFICITY";
  }

  const readinessMessage =
    readiness === "READY_FOR_EXACT"
      ? "Your query has enough structure for strict proposition matching. Add one exclusion cue to reduce adjacent doctrine drift."
      : readiness === "NEEDS_SPECIFICITY"
        ? "The system can search this, but exact matches improve when you add the court outcome or known statute hooks."
        : "Add actor + proceeding first. Then include the exact court outcome you want verified.";

  const nextActions = unique([
    !proceedingSatisfied ? "Add proceeding posture first (criminal appeal, revision, writ, quashing)." : "",
    !outcomeSatisfied ? "Add the court outcome you want (dismissed/refused/allowed/not required)." : "",
    !actorSatisfied ? "Add actor-role direction (for example: State as appellant, accused as respondent)." : "",
    !hooksSatisfied ? "Add statute hooks only if known (for example Section 197 CrPC or Section 13(1)(e) PC Act)." : "",
    !exclusionsSatisfied ? "Add one exclusion cue (not required/without sanction/not condoned) to reduce drift." : "",
  ]).slice(0, 3);

  return {
    score: Number(score.toFixed(3)),
    grade,
    readiness,
    readinessMessage,
    checklist,
    nextActions,
    recommendedPattern: buildRecommendedPattern({
      actorSatisfied,
      proceedingSatisfied,
      outcomeSatisfied,
      hooksSatisfied,
      actorSample: intent.actors[0],
      proceedingSample: intent.procedures[0],
      outcomeSample: intent.issues[0],
      hookSample: intent.statutes[0],
    }),
    stricterRewrite: buildStricterRewrite({
      cleanedQuery: intent.cleanedQuery,
      actors: intent.actors,
      procedures: intent.procedures,
      statutes: intent.statutes,
      issues: intent.issues,
    }),
  };
}
