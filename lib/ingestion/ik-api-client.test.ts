import assert from "node:assert/strict";
import test from "node:test";
import { IndianKanoonApiClient } from "@/lib/ingestion/ik-api-client";

test("IndianKanoonApiClient search maps rows and retries on 429", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const methods: string[] = [];

  global.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    calls += 1;
    methods.push((init?.method ?? "GET").toUpperCase());

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
    });

    assert.equal(response.status, 200);
    assert.equal(response.rows.length, 1);
    assert.equal(response.rows[0].docId, 101);
    assert.ok(calls >= 2);
    assert.deepEqual(methods, ["POST", "POST"]);
  } finally {
    global.fetch = originalFetch;
  }
});
