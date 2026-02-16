import assert from "node:assert/strict";
import test from "node:test";
import { indianKanoonApiProvider } from "@/lib/retrieval/providers/indiankanoon-api";

test("indiankanoon_api provider uses structured metadata, category expansion, docfragment and docmeta", async () => {
  const originalEnv = {
    IK_API_BASE_URL: process.env.IK_API_BASE_URL,
    IK_API_KEY: process.env.IK_API_KEY,
    IK_API_STRUCTURED_QUERY_V2: process.env.IK_API_STRUCTURED_QUERY_V2,
    IK_CATEGORY_EXPANSION_V1: process.env.IK_CATEGORY_EXPANSION_V1,
    IK_DOCMETA_ENRICH_V1: process.env.IK_DOCMETA_ENRICH_V1,
    HYBRID_RETRIEVAL_V2: process.env.HYBRID_RETRIEVAL_V2,
    HYBRID_SHADOW_CAPTURE: process.env.HYBRID_SHADOW_CAPTURE,
    IK_API_DOCFRAGMENT_TOP_N: process.env.IK_API_DOCFRAGMENT_TOP_N,
    IK_API_DOCMETA_TOP_N: process.env.IK_API_DOCMETA_TOP_N,
  };
  const originalFetch = global.fetch;

  process.env.IK_API_BASE_URL = "https://api.example.test";
  process.env.IK_API_KEY = "token";
  process.env.IK_API_STRUCTURED_QUERY_V2 = "1";
  process.env.IK_CATEGORY_EXPANSION_V1 = "1";
  process.env.IK_DOCMETA_ENRICH_V1 = "1";
  process.env.HYBRID_RETRIEVAL_V2 = "0";
  process.env.HYBRID_SHADOW_CAPTURE = "0";
  process.env.IK_API_DOCFRAGMENT_TOP_N = "2";
  process.env.IK_API_DOCMETA_TOP_N = "2";

  const urls: string[] = [];
  global.fetch = (async (_input: URL | RequestInfo) => {
    const url = String(_input);
    urls.push(url);

    if (url.includes("/search/")) {
      const parsed = new URL(url);
      const formInput = parsed.searchParams.get("formInput") ?? "";
      const basePayload = {
        status: 200,
        headers: new Headers(),
      };
      if (formInput.includes("ORR")) {
        return {
          ok: true,
          ...basePayload,
          json: async () => ({
            results: [
              {
                docId: 302,
                title: "State v. B",
                court: "High Court",
                url: "https://indiankanoon.org/doc/302/",
                snippet:
                  "section 197 sanction discussed in detail with criminal appeal context and prosecution matrix",
              },
            ],
          }),
        } as Response;
      }
      return {
        ok: true,
        ...basePayload,
        json: async () => ({
          categories: ["corruption", "appellate"],
          results: [
            {
              docId: 301,
              title: "State v. A",
              court: "Supreme Court",
              url: "https://indiankanoon.org/doc/301/",
              snippet:
                "section 197 crpc sanction requirement analysed with substantial reasoning in prosecution appeal",
            },
          ],
        }),
      } as Response;
    }

    if (url.includes("/docfragment/301/")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          docId: 301,
          snippet: "prior sanction under section 197 crpc required before prosecution",
        }),
      } as Response;
    }
    if (url.includes("/docfragment/302/")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          docId: 302,
          snippet: "section 19 pc act and section 197 interaction discussed",
        }),
      } as Response;
    }

    if (url.includes("/docmeta/301/")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          docId: 301,
          author: "Justice A",
          bench: "Division Bench",
          numcites: 11,
          numcitedby: 42,
        }),
      } as Response;
    }
    if (url.includes("/docmeta/302/")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          docId: 302,
          author: "Justice B",
          bench: "Single Bench",
          numcites: 9,
          numcitedby: 15,
        }),
      } as Response;
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({}),
    } as Response;
  }) as typeof fetch;

  try {
    const result = await indianKanoonApiProvider.search({
      phrase: "section 197 sanction required",
      compiledQuery: "section 197 sanction required",
      courtScope: "ANY",
      queryMode: "context",
      doctypeProfile: "judgments_sc_hc_tribunal",
      titleTerms: ["state appeal"],
      citeTerms: ["section 197 crpc"],
      authorTerms: ["justice a"],
      benchTerms: ["division bench"],
      categoryExpansions: ["corruption"],
      maxResultsPerPhrase: 10,
      maxPages: 1,
      crawlMaxElapsedMs: 1800,
      fetchTimeoutMs: 1000,
      max429Retries: 0,
    });

    assert.ok(result.cases.length >= 2);
    assert.ok((result.debug.categoryExpansionCount ?? 0) >= 1);
    assert.ok((result.debug.docFragmentCalls ?? 0) >= 1 || !urls.some((url) => url.includes("/docfragment/")));
    assert.ok((result.debug.docmetaHydrated ?? 0) >= 1);
    assert.ok(result.cases.some((item) => (item.author ?? "").toLowerCase().includes("justice")));
    assert.ok(result.cases.some((item) => (item.bench ?? "").toLowerCase().includes("bench")));
    assert.ok(urls.some((url) => url.includes("title=state+appeal")));
    assert.ok(urls.some((url) => url.includes("cite=section+197+crpc")));
    assert.ok(urls.some((url) => url.includes("author=justice+a")));
    assert.ok(urls.some((url) => url.includes("bench=division+bench")));
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
});
