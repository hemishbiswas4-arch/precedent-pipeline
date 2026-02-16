import { loadEnvConfig } from "@next/env";
import { chunkLegalDocuments } from "@/lib/ingestion/chunker";
import { IndianKanoonApiClient } from "@/lib/ingestion/ik-api-client";
import { normalizeIkDocuments } from "@/lib/ingestion/normalize";
import { embedTexts } from "@/lib/retrieval/embeddings";
import { ManagedVectorStore, VectorRecord } from "@/lib/retrieval/vector-store";

loadEnvConfig(process.cwd());

type IndexWindow = {
  fromDate: string;
  toDate: string;
};

let indexPreflightDone = false;

function arg(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  if (fallback !== undefined) return fallback;
  throw new Error(`missing argument --${name}`);
}

function parseWindow(): IndexWindow {
  return {
    fromDate: arg("from", "2016-01-01"),
    toDate: arg("to", new Date().toISOString().slice(0, 10)),
  };
}

function hasEnv(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function runIndexPreflight(): void {
  if (indexPreflightDone) return;

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
      `index:ik preflight failed. Missing required env vars: ${missingRequired.join(", ")}.`,
    );
  }
  if (missingOptional.length > 0) {
    console.warn(
      `[index:ik] Optional env vars not set: ${missingOptional.join(
        ", ",
      )}. Falling back to local embedding/rerank behavior where supported.`,
    );
  }
  indexPreflightDone = true;
}

async function fetchWindowDocs(input: {
  client: IndianKanoonApiClient;
  court: "SC" | "HC";
  window: IndexWindow;
  query: string;
  maxPages: number;
}): Promise<ReturnType<typeof normalizeIkDocuments>> {
  const rows: Array<Parameters<typeof normalizeIkDocuments>[0][number]> = [];
  for (let page = 0; page < input.maxPages; page += 1) {
    const response = await input.client.search({
      formInput: input.query,
      court: input.court,
      fromDate: input.window.fromDate,
      toDate: input.window.toDate,
      pagenum: page,
      maxpages: 1,
    });

    rows.push(...response.rows);
    if (response.rows.length === 0) break;
  }

  return normalizeIkDocuments(rows, "ik_api_v1");
}

function toVectorRecords(input: {
  chunks: ReturnType<typeof chunkLegalDocuments>;
  embeddings: number[][];
}): VectorRecord[] {
  const records: VectorRecord[] = [];
  for (let i = 0; i < input.chunks.length; i += 1) {
    const chunk = input.chunks[i];
    const embedding = input.embeddings[i];
    if (!embedding || embedding.length === 0) continue;
    records.push({
      id: chunk.chunkId,
      values: embedding,
      payload: {
        docId: chunk.docId,
        chunkId: chunk.chunkId,
        court: chunk.court,
        decisionDate: chunk.decisionDate,
        citations: chunk.citations,
        statuteTokens: chunk.statuteTokens,
        text: chunk.text,
        sourceVersion: chunk.sourceVersion,
      },
    });
  }
  return records;
}

export async function runIndexJob(input?: {
  fromDate?: string;
  toDate?: string;
  query?: string;
  maxPages?: number;
}): Promise<{ indexed: number; chunks: number; documents: number }> {
  runIndexPreflight();
  const window: IndexWindow = {
    fromDate: input?.fromDate ?? "2016-01-01",
    toDate: input?.toDate ?? new Date().toISOString().slice(0, 10),
  };
  const query = input?.query ?? (process.env.IK_API_INDEX_QUERY?.trim() || "judgment");
  const maxPages = Math.max(1, Math.min(input?.maxPages ?? Number(process.env.IK_API_INDEX_MAX_PAGES ?? "6"), 60));

  const client = new IndianKanoonApiClient();
  const vectorStore = new ManagedVectorStore();

  const [scDocs, hcDocs] = await Promise.all([
    fetchWindowDocs({ client, court: "SC", window, query, maxPages }),
    fetchWindowDocs({ client, court: "HC", window, query, maxPages }),
  ]);

  const documents = [...scDocs, ...hcDocs];
  const chunks = chunkLegalDocuments({ documents });
  const embeddings = await embedTexts({
    texts: chunks.map((chunk) => chunk.text),
    preferPassage: true,
  });
  const records = toVectorRecords({ chunks, embeddings });

  await vectorStore.upsert(records);

  return {
    indexed: records.length,
    chunks: chunks.length,
    documents: documents.length,
  };
}

async function main(): Promise<void> {
  const window = parseWindow();
  const query = arg("query", process.env.IK_API_INDEX_QUERY ?? "judgment");
  const maxPages = Math.max(1, Number(arg("maxPages", process.env.IK_API_INDEX_MAX_PAGES ?? "6")) || 6);

  const result = await runIndexJob({
    fromDate: window.fromDate,
    toDate: window.toDate,
    query,
    maxPages,
  });

  console.log(
    JSON.stringify(
      {
        status: "ok",
        fromDate: window.fromDate,
        toDate: window.toDate,
        query,
        indexed: result.indexed,
        chunks: result.chunks,
        documents: result.documents,
      },
      null,
      2,
    ),
  );
}

const isDirectExecution = (process.argv[1] ?? "").includes("index-ik-corpus");
if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
