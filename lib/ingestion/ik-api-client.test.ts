import assert from "node:assert/strict";
import test from "node:test";
import { IndianKanoonApiClient } from "@/lib/ingestion/ik-api-client";

test("IndianKanoonApiClient search maps rows and retries on 429", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const methods: string[] = [];
  const urls: string[] = [];

  global.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    calls += 1;
    methods.push((init?.method ?? "GET").toUpperCase());
    urls.push(String(_input));

    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "0" }),
        json: async () => ({ message: "rate limited" }),
      } as Response;
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        results: [
          {
            docId: 101,
            title: "State v Accused",
            court: "Supreme Court",
            judgmentDate: "2021-04-11",
            url: "https://indiankanoon.org/doc/101/",
            snippet: "criminal appeal dismissed",
          },
        ],
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const client = new IndianKanoonApiClient({
      baseUrl: "https://api.example.test",
      apiKey: "token",
      maxRetries: 1,
      timeoutMs: 2000,
    });

    const response = await client.search({
      query: "criminal appeal",
      court: "SC",
      page: 1,
      perPage: 10,
      title: "state appeal",
      cite: "section 197 crpc",
      author: "justice shah",
      bench: "division bench",
    });

    assert.equal(response.status, 200);
    assert.equal(response.rows.length, 1);
    assert.equal(response.rows[0].docId, 101);
    assert.equal(response.rows[0].court, "Supreme Court");
    assert.ok(calls >= 2);
    assert.deepEqual(methods, ["POST", "POST"]);
    assert.ok(urls.some((url) => url.includes("title=state+appeal")));
    assert.ok(urls.some((url) => url.includes("cite=section+197+crpc")));
    assert.ok(urls.some((url) => url.includes("author=justice+shah")));
    assert.ok(urls.some((url) => url.includes("bench=division+bench")));
  } finally {
    global.fetch = originalFetch;
  }
});

test("IndianKanoonApiClient fetchDocFragment and fetchDocMeta map authority fields", async () => {
  const originalFetch = global.fetch;
  const urls: string[] = [];
  global.fetch = (async (_input: URL | RequestInfo) => {
    const url = String(_input);
    urls.push(url);
    if (url.includes("/docfragment/")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          docId: 202,
          headline: "section 197 crpc sanction discussed",
          snippet: "sanction required before prosecution",
        }),
      } as Response;
    }
    if (url.includes("/docmeta/")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          docId: 202,
          author: "Justice A. Kumar",
          bench: "Division Bench",
          numcites: 18,
          numcitedby: 62,
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
    const client = new IndianKanoonApiClient({
      baseUrl: "https://api.example.test",
      apiKey: "token",
      maxRetries: 0,
      timeoutMs: 2000,
    });

    const fragment = await client.fetchDocFragment("202", "section 197 crpc sanction", {
      timeoutMs: 800,
    });
    const meta = await client.fetchDocMeta("202");

    assert.equal(fragment.docId, 202);
    assert.ok((fragment.headline ?? "").includes("section 197"));
    assert.equal(meta.author, "Justice A. Kumar");
    assert.equal(meta.bench, "Division Bench");
    assert.equal(meta.numcites, 18);
    assert.equal(meta.numcitedby, 62);
    assert.ok(urls.some((url) => url.includes("/docfragment/202/")));
    assert.ok(urls.some((url) => url.includes("/docmeta/202/")));
  } finally {
    global.fetch = originalFetch;
  }
});
