import { ContextProfile } from "@/lib/types";

export const NOISE_TOKENS = new Set([
  "case",
  "cases",
  "precedent",
  "precedents",
  "judgment",
  "judgments",
  "find",
  "show",
  "where",
  "anything",
  "found",
  "once",
  "cannot",
  "associated",
  "with",
  "without",
]);

export const ISSUE_TEMPLATES: Record<string, string[]> = {
  "quashing of criminal proceedings": [
    "quashing criminal proceedings",
    "section 482 crpc quashing",
  ],
  "effect of exoneration": [
    "exoneration on merits criminal prosecution",
    "civil adjudication exoneration prosecution",
  ],
  "parallel civil and criminal liability": [
    "civil and criminal proceedings simultaneously",
    "civil dispute and criminal offence",
  ],
  "departmental adjudication impact on prosecution": [
    "departmental adjudication criminal prosecution",
  ],
  "condonation of delay in appeal": [
    "condonation of delay in filing appeal",
    "limitation act section 5 appeal delay",
    "delay not condoned appeal dismissed",
    "criminal appeal delay condonation by state",
    "section 378 crpc delay condonation",
    "state appeal against acquittal delay condonation",
    "collector land acquisition anantnag katiji delay condonation",
    "n balakrishnan krishnamurthy delay condonation",
    "e sha bhattacharjee delay condonation principles",
    "basawaraj special land acquisition officer delay",
    "state of nagaland lipok ao delay condonation",
    "postmaster general living media india delay",
  ],
  "refusal of delay condonation": [
    "delay not condoned appeal dismissed",
    "application for condonation of delay rejected",
    "appeal dismissed as time barred",
    "appeal barred by limitation delay condonation refused",
    "state criminal appeal delay condonation refused",
    "state appeal against acquittal dismissed as time barred",
    "state of mp bherulal condonation delay refused",
    "postmaster general living media condonation delay refused",
  ],
  "criminal breach of trust ingredients": [
    "criminal breach of trust section 406 ipc",
    "dishonest intention at inception",
  ],
  "vicarious liability of directors": [
    "vicarious liability director criminal case",
    "director criminal prosecution liability",
  ],
  "disproportionate assets and check period assessment": [
    "disproportionate assets check period",
    "known sources of income check period",
    "section 13 1 e pc act disproportionate assets",
  ],
  "section 197 sanction for pc act prosecution": [
    "section 197 crpc sanction prevention of corruption act",
    "section 13 1 e pc act sanction requirement",
    "section 19 pc act and section 197 crpc",
    "previous sanction public servant disproportionate assets prosecution",
    "section 197 crpc required for prosecution under pc act",
  ],
  "section 197 and section 19 sanction interaction": [
    "section 197 crpc versus section 19 pc act sanction",
    "section 19 prevention of corruption act sanction override section 197",
    "sanction for prosecution section 197 and section 19",
  ],
  "criminal liability for delayed refund": [
    "delayed refund cheating breach of trust",
    "refund delay criminal prosecution",
  ],
};

export const DOMAIN_TEMPLATES: Record<string, string[]> = {
  criminal: ["criminal prosecution", "criminal proceedings", "criminal appeal"],
  civil: ["civil liability", "civil dispute"],
  tax: ["tax adjudication", "assessment order"],
  corporate: ["director liability", "company prosecution"],
  "anti-corruption": [
    "prevention of corruption act",
    "disproportionate assets",
    "known sources of income",
    "section 197 crpc sanction",
    "section 19 prevention of corruption act",
  ],
  appellate: [
    "delay condonation appeal",
    "limitation act section 5",
    "appeal filed beyond limitation",
  ],
};

export function ontologyTemplatesForContext(context: ContextProfile): string[] {
  const values: string[] = [];
  for (const issue of context.issues) {
    values.push(...(ISSUE_TEMPLATES[issue] ?? []));
  }
  for (const domain of context.domains) {
    values.push(...(DOMAIN_TEMPLATES[domain] ?? []));
  }
  return [...new Set(values)];
}
