import { embedText } from "@/lib/retrieval/embeddings";
import { rerankCandidates } from "@/lib/retrieval/reranker";
import { ManagedVectorStore } from "@/lib/retrieval/vector-store";
import {
  RetrievalProvider,
  RetrievalSearchInput,
  RetrievalSearchResult,
} from "@/lib/retrieval/providers/types";
import { CaseCandidate } from "@/lib/types";

type RetrievalSourceTag =
  | "lexical_api"
  | "lexical_html"
  | "web_search"
  | "semantic_vector"
  | "fused";

const HYBRID_RETRIEVAL_ENABLED = (() => {
  const raw = (process.env.HYBRID_RETRIEVAL_V1 ?? "0").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
})();
const HYBRID_RRF_K = Math.max(1, Number(process.env.HYBRID_RRF_K ?? "60"));
const HYBRID_SEMANTIC_TOPK = Math.max(4, Number(process.env.HYBRID_SEMANTIC_TOPK ?? "24"));
const HYBRID_LEXICAL_TOPK = Math.max(4, Number(process.env.HYBRID_LEXICAL_TOPK ?? "18"));
const HYBRID_SOURCE_DOMINANCE_CAP = Math.min(
  0.95,
  Math.max(Number(process.env.HYBRID_SOURCE_DOMINANCE_CAP ?? "0.7"), 0.5),
);

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueSourceTags(values: Array<RetrievalSourceTag | undefined>): RetrievalSourceTag[] {
  const out: RetrievalSourceTag[] = [];
  const seen = new Set<RetrievalSourceTag>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function semanticEnabled(): boolean {
  if (!HYBRID_RETRIEVAL_ENABLED) return false;
  if (!ManagedVectorStore.isConfigured()) return false;
  return parseBoolean(process.env.HYBRID_ENABLE_SEMANTIC, true);
}

function semanticCandidateFromHit(input: {
  hit: Awaited<ReturnType<ManagedVectorStore["query"]>>[number];
}): CaseCandidate {
  const { hit } = input;
  const text = normalizeText(hit.payload.text);
  const snippet = text.length > 500 ? `${text.slice(0, 497)}...` : text;
  const title = normalizeText(hit.payload.title ?? `Judgment ${hit.payload.docId}`);
  const url = hit.payload.url?.trim() || `https://indiankanoon.org/doc/${hit.payload.docId}/`;

  return {
    source: "indiankanoon",
    title: title || `Judgment ${hit.payload.docId}`,
    url,
    snippet,
    court: hit.payload.court,
    fullDocumentUrl: url,
    retrieval: {
      sourceTags: ["semantic_vector"],
      semanticScore: Number(hit.score.toFixed(6)),
      semanticRank: 0,
      sourceVersion: hit.payload.sourceVersion,
      semanticHash: `${hit.payload.docId}:${hit.payload.chunkId}`,
    },
  };
}

function annotateRank(input: {
  items: CaseCandidate[];
  kind: "lexical" | "semantic";
}): CaseCandidate[] {
  return input.items.map((item, index) => {
    const rank = index + 1;
    if (input.kind === "lexical") {
      return {
        ...item,
        retrieval: {
          ...(item.retrieval ?? {}),
          sourceTags: uniqueSourceTags([...(item.retrieval?.sourceTags ?? []), "lexical_api"]),
          lexicalRank: rank,
        },
      };
    }
    return {
      ...item,
      retrieval: {
        ...(item.retrieval ?? {}),
        sourceTags: uniqueSourceTags([...(item.retrieval?.sourceTags ?? []), "semantic_vector"]),
        semanticRank: rank,
      },
    };
  });
}

function rrfScore(rank: number, weight: number): number {
  return weight / (HYBRID_RRF_K + rank);
}

function fuseCandidates(input: {
  lexical: CaseCandidate[];
  semantic: CaseCandidate[];
  limit: number;
}): CaseCandidate[] {
  const lexical = annotateRank({ items: input.lexical, kind: "lexical" });
  const semantic = annotateRank({ items: input.semantic, kind: "semantic" });

  const map = new Map<string, CaseCandidate>();

  const merge = (candidate: CaseCandidate): void => {
    const existing = map.get(candidate.url);
    if (!existing) {
      map.set(candidate.url, candidate);
      return;
    }

    const mergedSnippet =
      (candidate.snippet?.length ?? 0) > (existing.snippet?.length ?? 0) ? candidate.snippet : existing.snippet;

    map.set(candidate.url, {
      ...existing,
      ...candidate,
      title: existing.title.length >= candidate.title.length ? existing.title : candidate.title,
      snippet: mergedSnippet,
      court: existing.court !== "UNKNOWN" ? existing.court : candidate.court,
      retrieval: {
        ...(existing.retrieval ?? {}),
        ...(candidate.retrieval ?? {}),
        sourceTags: uniqueSourceTags([
          ...(existing.retrieval?.sourceTags ?? []),
          ...(candidate.retrieval?.sourceTags ?? []),
        ]),
        lexicalRank:
          typeof existing.retrieval?.lexicalRank === "number" &&
          typeof candidate.retrieval?.lexicalRank === "number"
            ? Math.min(existing.retrieval.lexicalRank, candidate.retrieval.lexicalRank)
            : existing.retrieval?.lexicalRank ?? candidate.retrieval?.lexicalRank,
        semanticRank:
          typeof existing.retrieval?.semanticRank === "number" &&
          typeof candidate.retrieval?.semanticRank === "number"
            ? Math.min(existing.retrieval.semanticRank, candidate.retrieval.semanticRank)
            : existing.retrieval?.semanticRank ?? candidate.retrieval?.semanticRank,
      },
    });
  };

  for (const item of lexical) merge(item);
  for (const item of semantic) merge(item);

  const scored = Array.from(map.values())
    .map((item) => {
      const lexicalRank = item.retrieval?.lexicalRank;
      const semanticRank = item.retrieval?.semanticRank;
      const lexicalComponent =
        typeof lexicalRank === "number" && lexicalRank > 0 ? rrfScore(lexicalRank, 1.0) : 0;
      const semanticComponent =
        typeof semanticRank === "number" && semanticRank > 0 ? rrfScore(semanticRank, 1.15) : 0;
      const fusionScore = lexicalComponent + semanticComponent;

      return {
        ...item,
        retrieval: {
          ...(item.retrieval ?? {}),
          sourceTags: uniqueSourceTags([...(item.retrieval?.sourceTags ?? []), "fused"]),
          lexicalScore: Number(lexicalComponent.toFixed(8)),
          semanticScore: Number(semanticComponent.toFixed(8)),
          fusionScore: Number(fusionScore.toFixed(8)),
        },
      };
    })
    .sort((left, right) => (right.retrieval?.fusionScore ?? 0) - (left.retrieval?.fusionScore ?? 0));

  const target = Math.max(1, Math.min(input.limit, scored.length));
  const maxPerSource = Math.max(1, Math.floor(target * HYBRID_SOURCE_DOMINANCE_CAP));
  const selected: CaseCandidate[] = [];
  let lexicalCount = 0;
  let semanticCount = 0;

  for (const item of scored) {
    const lexicalComponent = item.retrieval?.lexicalScore ?? 0;
    const semanticComponent = item.retrieval?.semanticScore ?? 0;
    const dominant = semanticComponent > lexicalComponent ? "semantic" : "lexical";

    if (dominant === "lexical" && lexicalCount >= maxPerSource) continue;
    if (dominant === "semantic" && semanticCount >= maxPerSource) continue;

    selected.push(item);
    if (dominant === "lexical") lexicalCount += 1;
    if (dominant === "semantic") semanticCount += 1;
    if (selected.length >= target) break;
  }

  if (selected.length < target) {
    for (const item of scored) {
      if (selected.some((existing) => existing.url === item.url)) continue;
      selected.push(item);
      if (selected.length >= target) break;
    }
  }

  return selected;
}

async function runSemanticSearch(input: RetrievalSearchInput): Promise<CaseCandidate[]> {
  if (!semanticEnabled()) return [];

  const vectorStore = new ManagedVectorStore();
  const embedding = await embedText({
    text: input.compiledQuery ?? input.phrase,
    preferPassage: false,
  });

  const hits = await vectorStore.query({
    vector: embedding,
    topK: Math.max(HYBRID_SEMANTIC_TOPK, input.maxResultsPerPhrase),
    filter: {
      court: input.courtScope === "ANY" ? undefined : input.courtScope,
      fromDate: input.fromDate,
      toDate: input.toDate,
    },
  });

  return hits.map((hit) => semanticCandidateFromHit({ hit }));
}

export async function runHybridSearch(input: {
  searchInput: RetrievalSearchInput;
  lexicalProvider: RetrievalProvider;
}): Promise<RetrievalSearchResult> {
  const startedAt = Date.now();

  const lexicalPromise = input.lexicalProvider.search({
    ...input.searchInput,
    maxResultsPerPhrase: Math.max(input.searchInput.maxResultsPerPhrase, HYBRID_LEXICAL_TOPK),
  });
  const semanticPromise = runSemanticSearch(input.searchInput);

  const [lexicalResult, semanticResult] = await Promise.allSettled([lexicalPromise, semanticPromise]);

  if (lexicalResult.status === "rejected" && semanticResult.status === "rejected") {
    throw lexicalResult.reason;
  }

  if (lexicalResult.status === "rejected" && semanticResult.status === "fulfilled") {
    const semanticOnly = annotateRank({ items: semanticResult.value, kind: "semantic" }).slice(
      0,
      input.searchInput.maxResultsPerPhrase,
    );

    return {
      cases: semanticOnly,
      debug: {
        searchQuery: input.searchInput.compiledQuery ?? input.searchInput.phrase,
        status: 200,
        ok: true,
        parsedCount: semanticOnly.length,
        parserMode: "semantic_vector",
        pagesScanned: 1,
        pageCaseCounts: [semanticOnly.length],
        nextPageDetected: false,
        rawParsedCount: semanticOnly.length,
        excludedStatuteCount: 0,
        excludedWeakCount: 0,
        cloudflareDetected: false,
        challengeDetected: false,
        sourceTag: "semantic_vector",
        semanticCandidateCount: semanticOnly.length,
        lexicalCandidateCount: 0,
        fusedCandidateCount: semanticOnly.length,
        rerankApplied: false,
        fusionLatencyMs: Date.now() - startedAt,
      },
    };
  }

  const lexical = lexicalResult.status === "fulfilled" ? lexicalResult.value : null;
  const semantic = semanticResult.status === "fulfilled" ? semanticResult.value : [];

  if (!lexical) {
    throw new Error("hybrid_retrieval_missing_lexical_result");
  }

  if (semantic.length === 0 || !semanticEnabled()) {
    return {
      ...lexical,
      cases: lexical.cases.slice(0, input.searchInput.maxResultsPerPhrase),
      debug: {
        ...lexical.debug,
        sourceTag: lexical.debug.sourceTag ?? "lexical_api",
        semanticCandidateCount: 0,
        lexicalCandidateCount: lexical.cases.length,
        fusedCandidateCount: lexical.cases.length,
        rerankApplied: false,
        fusionLatencyMs: Date.now() - startedAt,
      },
    };
  }

  const fused = fuseCandidates({
    lexical: lexical.cases,
    semantic,
    limit: Math.max(input.searchInput.maxResultsPerPhrase, HYBRID_LEXICAL_TOPK),
  });

  const reranked = await rerankCandidates({
    query: input.searchInput.compiledQuery ?? input.searchInput.phrase,
    candidates: fused,
    topN: Math.max(8, Math.min(24, fused.length)),
  });

  const finalCases = reranked.reranked.slice(0, input.searchInput.maxResultsPerPhrase);

  return {
    cases: finalCases,
    debug: {
      ...lexical.debug,
      parsedCount: finalCases.length,
      rawParsedCount: lexical.debug.rawParsedCount,
      sourceTag: "fused",
      semanticCandidateCount: semantic.length,
      lexicalCandidateCount: lexical.cases.length,
      fusedCandidateCount: fused.length,
      rerankApplied: reranked.applied,
      fusionLatencyMs: Date.now() - startedAt,
    },
  };
}

export const hybridTestUtils = {
  fuseCandidates,
};
