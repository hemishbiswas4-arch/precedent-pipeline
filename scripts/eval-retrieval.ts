import { readFileSync } from "node:fs";
import path from "node:path";
import { buildIntentProfile } from "@/lib/pipeline/intent";
import { planDeterministicQueryVariants } from "@/lib/pipeline/planner";
import { buildCanonicalIntent, synthesizeRetrievalQueries } from "@/lib/pipeline/query-rewrite";

type BenchmarkFixture = {
  id: string;
  query: string;
  expected: {
    polarity?: "required" | "not_required" | "allowed" | "refused" | "dismissed" | "quashed" | "unknown";
    requiredHooks?: string[];
  };
};

type EvalSummary = {
  fixtureCount: number;
  hookRetentionPct: number;
  polarityRetentionPct: number;
  thresholds: {
    hookRetentionPct: number;
    polarityRetentionPct: number;
  };
  pass: boolean;
  fixtures: Array<{
    id: string;
    hookCoveragePct: number;
    expectedPolarity?: string;
    inferredPolarity: string;
    strictVariantCount: number;
  }>;
  notes: string[];
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s()/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hookMatchedByVariants(hook: string, strictPhrases: string[]): boolean {
  const normalizedHook = normalizeText(hook);
  if (!normalizedHook) return false;
  const hookTokens = normalizedHook.split(/\s+/).filter((token) => token.length > 1);
  if (hookTokens.length === 0) return false;
  return strictPhrases.some((phrase) => {
    const normalizedPhrase = normalizeText(phrase);
    return hookTokens.every((token) => normalizedPhrase.includes(token));
  });
}

async function evaluate(fixtures: BenchmarkFixture[]): Promise<EvalSummary> {
  let totalHooks = 0;
  let matchedHooks = 0;
  let polarityChecks = 0;
  let polarityMatches = 0;
  const perFixture: EvalSummary["fixtures"] = [];

  for (const fixture of fixtures) {
    const intent = buildIntentProfile(fixture.query);
    const deterministic = await planDeterministicQueryVariants(intent);
    const canonicalIntent = buildCanonicalIntent(intent);
    const rewriteVariants = synthesizeRetrievalQueries({
      canonicalIntent,
      deterministicPlanner: deterministic,
      reasonerVariants: [],
    });
    const strictPhrases = rewriteVariants
      .filter((variant) => variant.strictness === "strict")
      .map((variant) => variant.phrase);

    const hooks = fixture.expected.requiredHooks ?? [];
    let hookHits = 0;
    for (const hook of hooks) {
      totalHooks += 1;
      const matched = hookMatchedByVariants(hook, strictPhrases);
      if (matched) {
        matchedHooks += 1;
        hookHits += 1;
      }
    }

    if (fixture.expected.polarity) {
      polarityChecks += 1;
      if (canonicalIntent.outcomePolarity === fixture.expected.polarity) {
        polarityMatches += 1;
      }
    }

    const hookCoveragePct = hooks.length > 0 ? (hookHits / hooks.length) * 100 : 100;
    perFixture.push({
      id: fixture.id,
      hookCoveragePct: Number(hookCoveragePct.toFixed(2)),
      expectedPolarity: fixture.expected.polarity,
      inferredPolarity: canonicalIntent.outcomePolarity,
      strictVariantCount: strictPhrases.length,
    });
  }

  const hookRetentionPct = totalHooks > 0 ? (matchedHooks / totalHooks) * 100 : 100;
  const polarityRetentionPct = polarityChecks > 0 ? (polarityMatches / polarityChecks) * 100 : 100;
  const thresholds = {
    hookRetentionPct: 95,
    polarityRetentionPct: 95,
  };
  const pass = hookRetentionPct >= thresholds.hookRetentionPct && polarityRetentionPct >= thresholds.polarityRetentionPct;

  return {
    fixtureCount: fixtures.length,
    hookRetentionPct: Number(hookRetentionPct.toFixed(2)),
    polarityRetentionPct: Number(polarityRetentionPct.toFixed(2)),
    thresholds,
    pass,
    fixtures: perFixture,
    notes: [
      "This harness evaluates rewrite-stage quality only (hook and polarity retention).",
      "Top-5 precision, no-match regression, and p95 latency should be measured from production shadow telemetry.",
    ],
  };
}

async function main(): Promise<void> {
  const fixturePathArg = process.argv[2] || "evals/query_benchmark.json";
  const fixturePath = path.isAbsolute(fixturePathArg)
    ? fixturePathArg
    : path.join(process.cwd(), fixturePathArg);
  const payload = JSON.parse(readFileSync(fixturePath, "utf8")) as BenchmarkFixture[];
  const result = await evaluate(payload);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) {
    process.exitCode = 1;
  }
}

void main();
