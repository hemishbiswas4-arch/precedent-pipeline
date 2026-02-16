import { loadEnvConfig } from "@next/env";
import { runIndexJob } from "@/scripts/index-ik-corpus";

loadEnvConfig(process.cwd());

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function toIsoDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10);
}

function hasEnv(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function runBackfillPreflight(): void {
  const required = [
    "IK_API_BASE_URL",
    "IK_API_KEY",
    "VECTOR_DB_URL",
    "VECTOR_DB_API_KEY",
    "VECTOR_COLLECTION",
  ];
  const optional = ["EMBEDDING_MODEL_ID", "RERANK_MODEL_ID"];
  const missingRequired = required.filter((name) => !hasEnv(name));
  const missingOptional = optional.filter((name) => !hasEnv(name));

  if (missingRequired.length > 0) {
    throw new Error(
      `backfill:ik preflight failed. Missing required env vars: ${missingRequired.join(", ")}.`,
    );
  }
  if (missingOptional.length > 0) {
    console.warn(
      `[backfill:ik] Optional env vars not set: ${missingOptional.join(
        ", ",
      )}. Falling back to local embedding/rerank behavior where supported.`,
    );
  }
}

function progressiveDomainQueries(baseQuery: string): string[] {
  const queries = [
    baseQuery,
    "section 197 crpc sanction section 19 prevention of corruption act",
    "delay condonation refused limitation act section 5",
    "appeal dismissed as time barred prosecution appeal",
    "section 482 crpc quashing criminal proceedings",
    "tribunal appeal limitation condonation",
  ];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const normalized = query.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(query.trim());
  }
  return output;
}

async function main(): Promise<void> {
  runBackfillPreflight();
  const startYear = Number(process.env.IK_BACKFILL_START_YEAR ?? "2016");
  const endYear = Number(process.env.IK_BACKFILL_END_YEAR ?? String(new Date().getUTCFullYear()));
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear) || startYear > endYear) {
    throw new Error(
      `backfill:ik preflight failed. Invalid year window start=${startYear} end=${endYear}.`,
    );
  }
  const reverse = parseBoolean(process.env.IK_BACKFILL_REVERSE, true);
  const progressiveCoverage = parseBoolean(process.env.IK_PROGRESSIVE_INDEX_V2, true);
  const baseQuery = process.env.IK_API_INDEX_QUERY ?? "judgment";
  const queries = progressiveCoverage ? progressiveDomainQueries(baseQuery) : [baseQuery];

  const years: number[] = [];
  for (let year = startYear; year <= endYear; year += 1) {
    years.push(year);
  }
  if (reverse) years.reverse();

  const summary: Array<{ year: number; indexed: number; chunks: number; documents: number }> = [];

  for (const year of years) {
    const fromDate = toIsoDate(year, 1, 1);
    const toDate = toIsoDate(year, 12, 31);

    const result = await runIndexJob({
      fromDate,
      toDate,
      query: baseQuery,
      queries,
      maxPages: Number(process.env.IK_API_INDEX_MAX_PAGES ?? "12"),
    });

    summary.push({
      year,
      indexed: result.indexed,
      chunks: result.chunks,
      documents: result.documents,
    });

    console.log(
      JSON.stringify(
        {
          status: "indexed_year",
          year,
          fromDate,
          toDate,
          indexed: result.indexed,
          chunks: result.chunks,
          documents: result.documents,
        },
        null,
        2,
      ),
    );
  }

  console.log(JSON.stringify({ status: "done", summary }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
