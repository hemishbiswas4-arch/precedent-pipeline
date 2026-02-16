export type VectorRecordPayload = {
  docId: string;
  chunkId: string;
  court: "SC" | "HC" | "UNKNOWN";
  decisionDate?: string;
  citations: string[];
  statuteTokens: string[];
  text: string;
  title?: string;
  url?: string;
  sourceVersion: string;
};

export type VectorRecord = {
  id: string;
  values: number[];
  payload: VectorRecordPayload;
};

export type VectorSearchHit = {
  id: string;
  score: number;
  payload: VectorRecordPayload;
};

export type VectorSearchParams = {
  vector: number[];
  topK: number;
  filter?: {
    court?: "SC" | "HC" | "UNKNOWN";
    fromDate?: string;
    toDate?: string;
  };
};

const VECTOR_TIMEOUT_MS = Math.max(1_500, Number(process.env.VECTOR_DB_TIMEOUT_MS ?? "4500"));

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function parseQdrantHits(payload: unknown): VectorSearchHit[] {
  const data = payload as { result?: Array<{ id?: unknown; score?: unknown; payload?: unknown }> };
  const rows = Array.isArray(data?.result) ? data.result : [];
  const out: VectorSearchHit[] = [];

  for (const row of rows) {
    const id = String(row?.id ?? "").trim();
    const score = Number(row?.score ?? 0);
    const payloadValue = row?.payload as Partial<VectorRecordPayload> | undefined;
    if (!id || !Number.isFinite(score) || !payloadValue) continue;
    if (typeof payloadValue.docId !== "string" || typeof payloadValue.chunkId !== "string") continue;

    out.push({
      id,
      score,
      payload: {
        docId: payloadValue.docId,
        chunkId: payloadValue.chunkId,
        court: payloadValue.court ?? "UNKNOWN",
        decisionDate: payloadValue.decisionDate,
        citations: payloadValue.citations ?? [],
        statuteTokens: payloadValue.statuteTokens ?? [],
        text: payloadValue.text ?? "",
        title: payloadValue.title,
        url: payloadValue.url,
        sourceVersion: payloadValue.sourceVersion ?? "vector_v1",
      },
    });
  }

  return out;
}

function qdrantFilter(input: VectorSearchParams["filter"]): Record<string, unknown> | undefined {
  if (!input) return undefined;

  const must: Array<Record<string, unknown>> = [];
  if (input.court && input.court !== "UNKNOWN") {
    must.push({
      key: "court",
      match: { value: input.court },
    });
  }

  if (input.fromDate || input.toDate) {
    must.push({
      key: "decisionDate",
      range: {
        gte: input.fromDate,
        lte: input.toDate,
      },
    });
  }

  if (must.length === 0) return undefined;
  return { must };
}

export class ManagedVectorStore {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly collection: string;

  constructor(input?: {
    baseUrl?: string;
    apiKey?: string;
    collection?: string;
  }) {
    const baseUrl = input?.baseUrl?.trim() ?? process.env.VECTOR_DB_URL?.trim() ?? "";
    const apiKey = input?.apiKey?.trim() ?? process.env.VECTOR_DB_API_KEY?.trim() ?? "";
    const collection = input?.collection?.trim() ?? process.env.VECTOR_COLLECTION?.trim() ?? "";

    if (!baseUrl) throw new Error("VECTOR_DB_URL missing");
    if (!apiKey) throw new Error("VECTOR_DB_API_KEY missing");
    if (!collection) throw new Error("VECTOR_COLLECTION missing");

    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = apiKey;
    this.collection = collection;
  }

  static isConfigured(): boolean {
    return Boolean(
      process.env.VECTOR_DB_URL?.trim() &&
        process.env.VECTOR_DB_API_KEY?.trim() &&
        process.env.VECTOR_COLLECTION?.trim(),
    );
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VECTOR_TIMEOUT_MS);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "api-key": this.apiKey,
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`vector_http_${response.status}`);
      }

      return await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`vector_request_failed:${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    const points = records.map((record) => ({
      id: record.id,
      vector: record.values,
      payload: record.payload,
    }));

    await this.post(`/collections/${this.collection}/points?wait=true`, {
      points,
    });
  }

  async query(input: VectorSearchParams): Promise<VectorSearchHit[]> {
    const payload = await this.post(`/collections/${this.collection}/points/search`, {
      vector: input.vector,
      limit: Math.max(1, Math.min(input.topK, 80)),
      with_payload: true,
      filter: qdrantFilter(input.filter),
    });

    return parseQdrantHits(payload);
  }
}
