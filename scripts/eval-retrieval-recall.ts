import { readFileSync } from "node:fs";
import path from "node:path";
import { buildIntentProfile } from "@/lib/pipeline/intent";
import { planDeterministicQueryVariants } from "@/lib/pipeline/planner";
import { buildCanonicalIntent, synthesizeRetrievalQueries } from "@/lib/pipeline/query-rewrite";
import { ontologyTemplatesForContext } from "@/lib/kb/legal-ontology";

type BenchmarkFixture = {
  id: string;
  query: string;
  expected: {
    requiredHooks?: string[];
  };
};

type Baseline = {
  coverageAt50?: number;
  noMatchRate?: number;
};

type FixtureResult = {
  id: string;
  generatedCount: number;
  strictCount: number;
  requiredHookCoverage: number;
  noMatchProxy: boolean;
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hookCovered(hook: string, generated: string[]): boolean {
  const normalizedHook = normalize(hook);
  if (!normalizedHook) return false;
  const tokens = normalizedHook.split(/\s+/).filter((token) => token.length > 1);
  if (tokens.length === 0) return false;

  return generated.some((candidate) => {
    const value = normalize(candidate);
    return tokens.every((token) => value.includes(token));
  });
}

function parseBaseline(filepath?: string): Baseline {
  if (!filepath) return {};
  try {
    const raw = readFileSync(filepath, "utf8");
    const parsed = JSON.parse(raw) as Baseline;
    return parsed;
  } catch {
    return {};
  }
}

async function runFixture(fixture: BenchmarkFixture): Promise<FixtureResult> {
  const intent = buildIntentProfile(fixture.query);
  const deterministic = await planDeterministicQueryVariants(intent);
  const canonicalIntent = buildCanonicalIntent(intent);
  const rewriteVariants = synthesizeRetrievalQueries({
    canonicalIntent,
    deterministicPlanner: deterministic,
    reasonerVariants: [],
  });

  const generated = [
    ...rewriteVariants.map((variant) => variant.phrase),
    ...deterministic.variants.map((variant) => variant.phrase),
    ...deterministic.keywordPack.searchPhrases,
    ...ontologyTemplatesForContext(intent.context),
  ]
    .map((value) => normalize(value))
    .filter((value) => value.length > 0)
    .slice(0, 50);

  const strictCount = rewriteVariants.filter((variant) => variant.strictness === "strict").length;
  const hooks = fixture.expected.requiredHooks ?? [];
  let coveredHooks = 0;
  for (const hook of hooks) {
    if (hookCovered(hook, generated)) coveredHooks += 1;
  }

  return {
    id: fixture.id,
    generatedCount: generated.length,
    strictCount,
    requiredHookCoverage: hooks.length > 0 ? coveredHooks / hooks.length : 1,
    noMatchProxy: strictCount === 0 || generated.length < 5,
  };
}

async function main(): Promise<void> {
  const fixturePathArg = process.argv[2] || "evals/query_benchmark.json";
  const baselinePathArg = process.argv[3];
  const fixturePath = path.isAbsolute(fixturePathArg)
    ? fixturePathArg
    : path.join(process.cwd(), fixturePathArg);

  const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as BenchmarkFixture[];
  const baseline = parseBaseline(baselinePathArg);

  const results: FixtureResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runFixture(fixture));
  }

  const coverageAt50 =
    results.reduce((sum, row) => sum + row.requiredHookCoverage, 0) / Math.max(1, results.length);
  const noMatchRate =
    results.filter((row) => row.noMatchProxy).length / Math.max(1, results.length);

  const baselineCoverage = baseline.coverageAt50 ?? coverageAt50;
  const baselineNoMatch = baseline.noMatchRate ?? noMatchRate;

  const coverageDeltaPct = baselineCoverage > 0 ? ((coverageAt50 - baselineCoverage) / baselineCoverage) * 100 : 0;
  const noMatchReductionPct =
    baselineNoMatch > 0 ? ((baselineNoMatch - noMatchRate) / baselineNoMatch) * 100 : 0;

  const passCoverage = coverageDeltaPct >= 30 || baseline.coverageAt50 === undefined;
  const passNoMatch = noMatchReductionPct >= 35 || baseline.noMatchRate === undefined;

  const output = {
    fixtureCount: fixtures.length,
    coverageAt50: Number((coverageAt50 * 100).toFixed(2)),
    noMatchRate: Number((noMatchRate * 100).toFixed(2)),
    baseline: {
      coverageAt50: Number((baselineCoverage * 100).toFixed(2)),
      noMatchRate: Number((baselineNoMatch * 100).toFixed(2)),
    },
    deltas: {
      coverageImprovementPct: Number(coverageDeltaPct.toFixed(2)),
      noMatchReductionPct: Number(noMatchReductionPct.toFixed(2)),
    },
    thresholds: {
      coverageImprovementPct: 30,
      noMatchReductionPct: 35,
    },
    pass: passCoverage && passNoMatch,
    fixtures: results,
    notes: [
      "This evaluator focuses on recall proxies from retrieval generation layers.",
      "For production acceptance, pair with shadow traffic metrics for precision@5 and p95 latency.",
    ],
  };

  console.log(JSON.stringify(output, null, 2));
  if (!output.pass) process.exitCode = 1;
}

void main();
