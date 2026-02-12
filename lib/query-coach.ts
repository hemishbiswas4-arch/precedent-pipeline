import { buildIntentProfile } from "@/lib/pipeline/intent";

export type QueryCoachItem = {
  id: "actor" | "proceeding" | "outcome" | "hooks" | "exclusions";
  label: string;
  satisfied: boolean;
  detail: string;
};

export type QueryCoachResult = {
  score: number;
  grade: "STRONG" | "FAIR" | "WEAK";
  checklist: QueryCoachItem[];
  warnings: string[];
  suggestions: string[];
  stricterRewrite?: string;
  examples: string[];
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
  const actor = input.actors[0] ?? "state";
  const proceeding = inferProceedingPhrase(input.cleanedQuery, input.procedures);
  const outcome = inferOutcomePhrase(input.cleanedQuery);
  const hookPhrase = input.statutes.length > 0 ? ` under ${input.statutes.slice(0, 2).join(" and ")}` : "";
  const issuePhrase = input.issues.length > 0 ? ` focusing on ${input.issues.slice(0, 2).join(" and ")}` : "";
  const rewrite = `${actor} as appellant filed ${proceeding}${hookPhrase}; find cases where ${outcome}${issuePhrase}.`;
  if (tokenize(rewrite).length < 8) return undefined;
  return rewrite;
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
      satisfied: actorSatisfied,
      detail: actorSatisfied
        ? `Detected: ${intent.actors.slice(0, 3).join(", ")}`
        : "Add who is acting (State, accused, department, director, etc.).",
    },
    {
      id: "proceeding",
      label: "Proceeding/posture",
      satisfied: proceedingSatisfied,
      detail: proceedingSatisfied
        ? `Detected: ${intent.procedures.slice(0, 3).join(", ")}`
        : "Add posture (criminal appeal, revision, writ, quashing, trial stage).",
    },
    {
      id: "outcome",
      label: "Outcome polarity",
      satisfied: outcomeSatisfied,
      detail: outcomeSatisfied
        ? `Detected: ${intent.issues.slice(0, 3).join(", ") || "negative/positive outcome cues"}`
        : "Specify the exact outcome (refused, dismissed, allowed, quashed, required/not required).",
    },
    {
      id: "hooks",
      label: "Legal hooks (optional but strong)",
      satisfied: hooksSatisfied,
      detail: hooksSatisfied
        ? `Detected: ${intent.statutes.slice(0, 3).join(", ")}`
        : "Add sections/statutes when known to improve doctrinal precision.",
    },
    {
      id: "exclusions",
      label: "Exclusion cues",
      satisfied: exclusionsSatisfied,
      detail: exclusionsSatisfied
        ? "Detected exclusion/negation cues."
        : "Optional: add 'not/without/except' style cues to prevent adjacent doctrine drift.",
    },
  ];

  const mandatorySatisfied = checklist.filter((item) => item.id !== "hooks" && item.id !== "exclusions" && item.satisfied).length;
  const score = Math.max(
    0,
    Math.min(
      1,
      mandatorySatisfied * 0.23 +
        (hooksSatisfied ? 0.18 : 0) +
        (exclusionsSatisfied ? 0.13 : 0) +
        (intent.cleanedQuery.length >= 35 ? 0.12 : 0),
    ),
  );

  const grade = score >= 0.75 ? "STRONG" : score >= 0.5 ? "FAIR" : "WEAK";

  const warnings: string[] = [];
  if (!actorSatisfied) warnings.push("Missing actor role; results may drift to generic doctrine.");
  if (!proceedingSatisfied) warnings.push("Missing proceeding posture; add appeal/revision/writ stage.");
  if (!outcomeSatisfied) warnings.push("Missing outcome polarity; add refused/dismissed/allowed/not required, etc.");
  if (!hooksSatisfied) warnings.push("No section/statute provided; doctrinal precision may reduce.");
  if (intent.cleanedQuery.length < 24) warnings.push("Very short query; add factual and procedural detail.");

  const suggestions = unique([
    !actorSatisfied ? "Add party-role direction (for example: 'State as appellant')." : "",
    !proceedingSatisfied ? "Add proceeding type (for example: 'criminal appeal against acquittal')." : "",
    !outcomeSatisfied
      ? "Add desired outcome text (for example: 'delay not condoned and appeal dismissed as time-barred')."
      : "",
    !hooksSatisfied ? "Include section/statute hooks if known (for example Section 197 CrPC, Section 13(1)(e) PC Act)." : "",
    !exclusionsSatisfied ? "Optional: add exclusion cues ('not required', 'without sanction', 'not condoned') to reduce near misses." : "",
  ]);

  const examples = [
    "State as appellant filed criminal appeal; delay condonation application was refused and appeal dismissed as time-barred.",
    "Prosecution under Section 13(1)(e) PC Act: whether Section 197 CrPC sanction is required in addition to Section 19 PC Act.",
    "Directors accused under Sections 406/420 IPC after refund delay; identify cases distinguishing civil breach from criminal intent at inception.",
  ];

  return {
    score: Number(score.toFixed(3)),
    grade,
    checklist,
    warnings,
    suggestions,
    stricterRewrite: buildStricterRewrite({
      cleanedQuery: intent.cleanedQuery,
      actors: intent.actors,
      procedures: intent.procedures,
      statutes: intent.statutes,
      issues: intent.issues,
    }),
    examples,
  };
}
