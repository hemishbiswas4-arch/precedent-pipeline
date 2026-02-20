# Precedent Finder Documentation

## Overview
Precedent Finder is an internal legal-research triage app that accepts a natural-language fact scenario and returns High Court/Supreme Court precedents that are most likely to satisfy the described proposition. The UI is a Next.js App Router page that walks the user through three stages: describing their scenario, running a retrieval pipeline backed by an LLM reasoner and dedicated retrieval providers, and reviewing ranked case cards with explicit reasons and missing-element explanations.

The repository also contains an older legacy search engine that uses keyword packs and Indian Kanoon scraping logic; the legacy path acts as a fallback when the modern pipeline is disabled or blocked.

## User experience and UI components (`app/`)
- `app/page.tsx` orchestrates the public experience: a `SearchComposer` with a large textarea, an inline query coach, status strips, and actionable prompts; a `ResearchSummary` + `CaseResultCard` grid; a `NearMissPanel` to highlight close-but-not-strict matches; and a `ResultModeBanner` that switches messaging (empty, blocked, partial, exact matches). `ThemeToggle` and session analytics controls keep the experience consistent.
- `app/components/consumer/SearchComposer.tsx` wires in `lib/query-coach.ts` to assess actor/proceeding/outcome/hooks coverage, show heuristic grade/readiness, and expose quick-prompt chips plus the "stricter rewrite" path when the query is too broad.
- `CaseResultCard.tsx` displays propositions, confidence bands, matched statutes, and verification tags reported by the backend response.
- `NearMissPanel.tsx` surfaces the `casesNearMiss` array so attorneys can inspect which elements were missing and why they are the leading fallback.
- The `AdvancedDrawer` (`app/components/consumer/AdvancedDrawer.tsx`) lets developers run `/api/health/bedrock` and `/api/health/indiankanoon` probes, toggle in-browser diagnostics, track session-run metrics, and inspect the `pipelineTrace`, keywords, and complied `notes` fields returned by the backend.

## Top-level services
### Search API (`POST /api/search`)
- Entry point: `app/api/search/route.ts`. The handler validates that the `query` string is present (12+ characters) and enforces per-IP rate limiting via `sharedCache` (Upstash Redis or in-memory fallback).
- Supported payload keys: `query` (string), `maxResults` (5–40, default 20), and `debug` (flag to opt out of caching/rate limiting).
- The API prefers the modern `pipeline` (`PIPELINE_V2` switch) but falls back to `runLegacySearch` when the reasoner path is disabled, unavailable, or explicitly debugged.
- Before invoking the pipeline it checks the `searchCacheKey` hash (schema `SEARCH_CACHE_SCHEMA_VERSION`) and replays cached responses when available. Inflight lock keys keep concurrent requests from repeating expensive work.
- The response payload is a `SearchResponse` (see **Data contracts** below). Cached responses include notes such as `Served from response cache (v6)` and mark `pipelineTrace.classification.cacheReplayGuardApplied`.

### Health probes
- `/api/health/bedrock` (`app/api/health/bedrock/route.ts`) runs a lightweight Bedrock `ConverseCommand` configured via `LLM_REASONER_MODEL_ID` or `BEDROCK_INFERENCE_PROFILE_ARN`, `AWS_REGION`, and the `LLM_REASONER_*` tuning variables (timeouts, retries, cache). It responds with latency, `preview`, and contextual hints when validation/credentials fail.
- `/api/health/indiankanoon` (`app/api/health/indiankanoon/route.ts`) hits the configured IK API base/KEY with a sample query, reporting HTTP status, row count, and retry hints when rate-limited or blocked.
- The UI exposes both probes inside the advanced drawer for quick troubleshooting.

## Pipeline architecture (`lib/pipeline/` + supporting code)
1. **Intent profiling**: `lib/pipeline/intent.ts` cleans the query and harvests actors, procedures, statutes, and issue hooks that feed the query coach and pipeline planner.
2. **Reasoner plan**: `lib/pipeline/planner.ts` orchestrates Bedrock (via `lib/llm-reasoner.ts`) sketch expansion, deterministic fallbacks, canonical rewrites, and variant scheduling. Plans can include strict/broad canonical rewrites plus AI-generated failover variants when deterministic coverage is weak.
3. **Scheduler**: `lib/pipeline/scheduler.ts` consumes the reasons and budgets (shaped by `lib/runtime-profile.ts`) and calls `runRetrievalSchedule` to issue queries in priority order. Adaptive variant scheduling can keep high-precision lanes around even when the reasoner is slow.
4. **Retrieval**: `lib/retrieval/provider.ts` selects between `indiankanoon_api`, `indiankanoon_html`, and `serper` (auto mode defaults to IK API when credentials exist, Serper on Vercel when a Serper key is set, otherwise IK HTML scraping). The `SEARCH_RUNTIME_PROFILE` controls `HYBRID_RETRIEVAL_V1`, lexical/semantic top-k, and RRF combination parameters.
5. **Verification & ranking**: Retrieved candidates are classified (`lib/pipeline/classifier.ts`), verified (`lib/pipeline/verifier.ts`), enriched via `proposition-gate.ts`, and scored (`lib/scoring.ts`, `lib/ranking-diversity.ts`). `lib/pipeline/always-return.ts` ensures the UI always receives advisory cards, synthetic fallbacks, or stale-cache guarantees when strict matches are missing.
6. **Reasoning guardrails**: `pipelineTrace` captures planner decisions, verification breakdowns, retrieval stats, and routing info (cache hit, executionPath). The pipeline enforces proposition coverage targets, strict/high-confidence stops, and reasoner circuit breakers in `lib/pipeline/engine.ts`.
7. **Legacy fallback**: `lib/legacy/engine.ts` rebuilds keyword packs via `lib/keywords.ts`, taps Indian Kanoon HTML with `lib/source-indiankanoon.ts`, and runs the same verification/classification stack. Legacy debug data helps troubleshoot rate limits/cloudflare.

Supporting caches: `lib/cache/shared-cache.ts` abstracts Upstash Redis + local memory for rate limiting, inflight locks, search caching, and fallback recall (`lib/cache/fallback-recall-cache.ts`).

## Response contract and downstream UI cues (`lib/types.ts`)
- `SearchResponse.query` echoes the cleaned query, while `context` carries extracted domains/issues/actors/statutes.
- Result buckets:
  - `casesExact`, `casesExactStrict`, `casesExactProvisional`: fully verified matches.
  - `casesNearMiss`: close matches annotated with `missingElements`/`missingCoreElements` for the UI to explain what is absent.
  - `casesExploratory`: fallback/expansion cards when nothing strict is found.
- `insights` summarizes retrieval quality, `keywordPack` reproduces the search phrases, and `notes` list runtime observations (cache hits, failovers, blocked reasons).
- `pipelineTrace` exposes planner/scheduler/retrieval stats such as `stopReason`, `variantCount`, `phaseSuccesses`, `classification.counts`, detail fetch stats, and `routing` metadata.
- `guarantee` and `reasoning` provide fallback/tracing info for downstream auditing.

## Environment & configuration
### Retrieval
- `RETRIEVAL_PROVIDER`: `auto`, `indiankanoon_html`, `indiankanoon_api`, or `serper`.
- `SERPER_API_KEY`: required for Serper mode.
- `IK_API_BASE_URL` + `IK_API_KEY`: required for `indiankanoon_api`.
- `HYBRID_RETRIEVAL_V1`, `HYBRID_RRF_K`, `HYBRID_SEMANTIC_TOPK`, `HYBRID_LEXICAL_TOPK`: shape hybrid ranking.

### Reasoner & proposition
- `LLM_REASONER_MODEL_ID`, `BEDROCK_INFERENCE_PROFILE_ARN`, `AWS_REGION`: point to the Bedrock LLM.
- `QUERY_REWRITE_V2`, `PIPELINE_V2`, `PROPOSITION_V3/V41/V5`, `CANONICAL_LEXICAL_SCORING`: toggle reasoning stages.
- `LLM_REASONER_TIMEOUT_MS`, `LLM_REASONER_MAX_TOKENS`, `LLM_REASONER_CACHE_TTL_SEC`, `LLM_REASONER_STRUCTURED_OUTPUT`: tune Bedrock calls.
- `PROPOSITION_*` and `PASS2_*` env variables capture stop targets, coverage floors, and fallback behavior.

### Operational
- `SEARCH_RESULT_CACHE_TTL_SEC`: positive values enable cached responses via `sharedCache`.
- `SEARCH_RUNTIME_PROFILE`, `PIPELINE_MAX_ELAPSED_MS`: bounds on pipeline budgets.
- `SEARCH_IP_RATE_LIMIT`, `SEARCH_IP_RATE_WINDOW_SEC`: per-IP throttling.
- `UPSTASH_REDIS_REST_URL` / `_TOKEN`: optional remote cache.
- `ALWAYS_RETURN_V1`, `ALWAYS_RETURN_SYNTHETIC_FALLBACK`, `GUARANTEE_MIN_RESULTS`: guarantee advisory cards.
- `IK_FETCH_TIMEOUT_MS`, `IK_MAX_429_RETRIES`, `IK_GLOBAL_RPS`: control IK API usage.
- `TRACE_EXPANSION_MIN_REMAINING_MS`, `LLM_REASONER_LOCK_WAIT_MS`, `REASONER_TIMEOUT_RECOVERY_MODE`: fine-tune scheduling/resilience.

### Local development & validation
- Copy `.env.example` to `.env.local` and supply the required API keys/Bedrock credentials.
- Install dependencies and start the dev server:
  ```bash
  npm install
  npm run dev
  ```
- Validate formatting/build:
  ```bash
  npm run lint
  npx next build --webpack
  ```

## Monitoring & troubleshooting
- Use `app/api/health/bedrock` and `app/api/health/indiankanoon` to sanity-check external dependencies inside the Advanced drawer.
- In-browser diagnostics include session-run metrics (`lib/client-analytics.ts`), request IDs, fetched/filtered counts, and `pipelineTrace` stats surfaced by `AdvancedDrawer`.
- Cache hits, fallback reasons, and blocked states intentionally show up in `SearchResponse.notes` and `inspection` spans so operators can track whether reasoner/retailer toggles behave as expected.
- For deep dives, consult `pipeline-technical-summary.pdf` for diagrams and `app/api/search/route.ts` for rate-limiting/caching logic.

## Next steps & references
- Review `lib/pipeline` unit tests (`query-rewrite.test.ts`, `scheduler-adaptive.test.ts`, etc.) before changing planner heuristics.
- Keep all compliance notes intact: the app purposely does not bypass CAPTCHAs/Cloudflare – rely on licensed sources when blocked.
