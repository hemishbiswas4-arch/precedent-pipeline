import { ContextProfile } from "@/lib/types";
import { QueryPhase } from "@/lib/pipeline/types";

export const PHASE_ORDER: QueryPhase[] = [
  "primary",
  "fallback",
  "rescue",
  "micro",
  "revolving",
  "browse",
];

export const PHASE_LIMITS: Record<QueryPhase, number> = {
  primary: 2,
  fallback: 2,
  rescue: 1,
  micro: 1,
  revolving: 1,
  browse: 1,
};

export const DEFAULT_GLOBAL_BUDGET = 8;
export const DEFAULT_BLOCKED_THRESHOLD = 4;
export const DEFAULT_VERIFY_LIMIT = 8;
export const DEFAULT_MAX_ELAPSED_MS = 22_000;

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isCriminalOnlyAppellate(context: ContextProfile): boolean {
  return context.domains.includes("criminal") && !context.domains.includes("civil");
}

export function microTemplatesForContext(context: ContextProfile): string[] {
  const phrases: string[] = [];
  const criminalOnlyAppellate = isCriminalOnlyAppellate(context);
  const refusalCondonation = context.issues.includes("refusal of delay condonation");
  const sanctionInteraction =
    context.issues.includes("section 197 sanction for pc act prosecution") ||
    context.issues.includes("section 197 and section 19 sanction interaction") ||
    (context.statutesOrSections.some((v) => /\bsection\s*197\b/i.test(v)) &&
      context.statutesOrSections.some((v) => /\bprevention of corruption\b|\bpc act\b|\bsection\s*13\b/i.test(v)));
  if (context.domains.includes("anti-corruption")) {
    phrases.push(
      "disproportionate assets check period",
      "section 13 1 e pc act",
      "known sources income disproportionate assets",
    );
  }
  if (context.issues.some((v) => /quash/i.test(v))) {
    phrases.push("quashing criminal proceedings", "section 482 crpc quashing");
  }
  if (context.issues.some((v) => /breach of trust/i.test(v))) {
    phrases.push("criminal breach trust section 406 ipc", "cheating section 420 ipc");
  }
  if (context.procedures.some((v) => /\bappeal\b/i.test(v))) {
    if (criminalOnlyAppellate) {
      phrases.push(
        "criminal appeal delay condonation",
        "delay not condoned criminal appeal",
        "state criminal appeal delay condonation",
        "section 378 crpc delay condonation",
        "state appeal against acquittal delay condonation",
      );
    } else {
      phrases.push(
        "condonation of delay in appeal",
        "limitation act section 5 appeal",
        "delay not condoned appeal",
        "collector anantnag katiji delay condonation",
        "n balakrishnan krishnamurthy delay",
        "e sha bhattacharjee condonation delay",
      );
    }
    if (context.domains.includes("criminal")) {
      phrases.push(
        "criminal appeal delay condonation",
        "delay not condoned criminal appeal",
        "state criminal appeal delay condonation",
      );
    }
  }
  if (refusalCondonation) {
    phrases.push(
      "delay not condoned appeal dismissed",
      "condonation of delay refused",
      "application for condonation rejected appeal",
      "appeal dismissed as time barred",
      "barred by limitation condonation refused",
    );
  }
  if (sanctionInteraction) {
    phrases.push(
      "section 197 crpc sanction prevention of corruption act",
      "section 19 prevention of corruption act sanction",
      "section 13 1 e pc act sanction for prosecution",
      "sanction under section 197 crpc for disproportionate assets case",
      "public servant official duty section 197 sanction pc act",
    );
  }
  if (context.domains.includes("criminal")) {
    phrases.push("criminal prosecution", "criminal appeal");
  }
  if (context.domains.includes("civil") && context.domains.includes("criminal")) {
    phrases.push("civil criminal proceedings");
  }
  if (phrases.length === 0 && context.procedures.length > 0) {
    phrases.push(...context.procedures.slice(0, 2));
  }
  return [...new Set(phrases.map(normalizeSpaces))];
}

export function fallbackTemplatesForContext(context: ContextProfile): string[] {
  const phrases: string[] = [];
  const criminalOnlyAppellate = isCriminalOnlyAppellate(context);
  const refusalCondonation = context.issues.includes("refusal of delay condonation");
  const sanctionInteraction =
    context.issues.includes("section 197 sanction for pc act prosecution") ||
    context.issues.includes("section 197 and section 19 sanction interaction") ||
    (context.statutesOrSections.some((v) => /\bsection\s*197\b/i.test(v)) &&
      context.statutesOrSections.some((v) => /\bprevention of corruption\b|\bpc act\b|\bsection\s*13\b/i.test(v)));
  const statuteTail = context.domains.includes("criminal")
    ? "criminal prosecution"
    : context.procedures.some((v) => /\bappeal\b/i.test(v))
      ? "appeal"
      : "judgment";
  if (context.statutesOrSections.length > 0) {
    for (const statute of context.statutesOrSections.slice(0, 3)) {
      phrases.push(`${statute} ${statuteTail}`);
    }
  }
  for (const issue of context.issues.slice(0, 3)) {
    phrases.push(issue);
  }
  for (const procedure of context.procedures.slice(0, 2)) {
    phrases.push(procedure);
  }
  if (context.procedures.some((v) => /\bappeal\b/i.test(v))) {
    if (criminalOnlyAppellate) {
      phrases.push(
        "criminal appeal delay condonation",
        "state criminal appeal filed beyond limitation",
        "delay condonation refused in criminal appeal",
        "section 378 crpc criminal appeal delay",
        "state appeal against acquittal delayed filing",
      );
    } else {
      phrases.push(
        "delay condonation appeal",
        "appeal delay limitation",
        "basawaraj special land acquisition limitation delay",
        "state of nagaland lipok ao condonation delay",
        "postmaster general living media limitation delay",
      );
    }
    if (context.domains.includes("criminal")) {
      phrases.push(
        "criminal appeal delay not condoned",
        "state appeal in criminal case delay condonation",
        "limitation in criminal appeal condonation",
      );
    }
  }
  if (refusalCondonation) {
    phrases.push(
      "delay not condoned in criminal appeal",
      "application for condonation of delay rejected",
      "state criminal appeal dismissed as time barred",
      "state appeal barred by limitation delay",
      "condonation refused state appeal",
    );
  }
  if (sanctionInteraction) {
    phrases.push(
      "section 197 crpc sanction required for pc act prosecution",
      "section 19 pc act and section 197 crpc interplay",
      "disproportionate assets prosecution sanction under section 197",
      "public servant prosecution sanction section 197 and section 19",
      "official duty nexus section 197 crpc pc act",
    );
  }
  return [...new Set(phrases.map(normalizeSpaces))];
}

export function revolvingTemplatesForContext(context: ContextProfile): string[] {
  const phrases: string[] = [];
  const criminalOnlyAppellate = isCriminalOnlyAppellate(context);
  const refusalCondonation = context.issues.includes("refusal of delay condonation");
  const sanctionInteraction =
    context.issues.includes("section 197 sanction for pc act prosecution") ||
    context.issues.includes("section 197 and section 19 sanction interaction") ||
    (context.statutesOrSections.some((v) => /\bsection\s*197\b/i.test(v)) &&
      context.statutesOrSections.some((v) => /\bprevention of corruption\b|\bpc act\b|\bsection\s*13\b/i.test(v)));
  for (const issue of context.issues.slice(0, 3)) {
    for (const actor of context.actors.slice(0, 2)) {
      phrases.push(`${issue} ${actor} prosecution`);
    }
  }
  if (context.domains.includes("anti-corruption")) {
    phrases.push("disproportionate assets criminal appeal");
  }
  if (context.procedures.some((v) => /\bappeal\b/i.test(v))) {
    if (criminalOnlyAppellate) {
      phrases.push(
        "state criminal appeal delay not condoned",
        "criminal appeal limitation condonation",
        "delay condonation in criminal appeal by state",
        "section 378 crpc appeal against acquittal delay",
        "state leave to appeal delay condonation criminal",
      );
    } else {
      phrases.push(
        "appeal filed beyond limitation",
        "delay condonation application in appeal",
        "state appeal delay condoned",
        "katiji delay condonation supreme court",
        "n balakrishnan condonation delay supreme court",
        "e sha bhattacharjee condonation delay supreme court",
      );
    }
    if (context.domains.includes("criminal")) {
      phrases.push(
        "criminal appeal filed with delay",
        "delay condonation in criminal appeal by state",
        "state criminal appeal dismissed on limitation",
      );
    }
  }
  if (refusalCondonation) {
    phrases.push(
      "criminal appeal dismissed for delay",
      "state appeal time barred limitation",
      "delay condonation denied in appeal",
      "application for condonation dismissed",
    );
  }
  if (sanctionInteraction) {
    phrases.push(
      "section 197 crpc sanction and section 19 pc act",
      "sanction for prosecution disproportionate assets section 13 1 e",
      "section 197 crpc required for public servant prosecution under pc act",
      "official duty reasonable nexus section 197 pc act prosecution",
    );
  }
  return [...new Set(phrases.map(normalizeSpaces))];
}
