# Precedent Finder (HC/SC)

Automated legal research triage app for:
- converting natural-language fact scenarios into targeted legal keyword packs
- querying Indian Kanoon-oriented retrieval sources
- filtering to likely High Court (HC) and Supreme Court (SC) decisions
- ranking case candidates by proposition-aware match score with transparent reasons

## Compliance Boundary

This app does **not** bypass anti-bot systems (Cloudflare, CAPTCHA, or similar protection).

If source-side protections block requests, use:
- official APIs/data feeds (if available)
- licensed legal databases
- manual workflow fallback

## Local Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Retrieval Providers

`POST /api/search` is the only search entrypoint.

Provider selection is controlled with:
- `RETRIEVAL_PROVIDER=auto|indiankanoon_html|serper` (default: `auto`)
- `RETRIEVAL_PROVIDER=auto|indiankanoon_api|indiankanoon_html|serper` (default: `auto`)
- `SERPER_API_KEY` (required when using Serper)
- `IK_API_BASE_URL` + `IK_API_KEY` (required when using `indiankanoon_api`)

`auto` behavior:
- If IK API credentials are configured: uses `indiankanoon_api` (hybrid-capable)
- Else on Vercel (`VERCEL=1`) with `SERPER_API_KEY` set: uses `serper`
- Otherwise: uses `indiankanoon_html`

## Optional: Universal Two-Pass Reasoner (Bounded, Fail-Open)

The production pipeline is query-agnostic. It compiles a universal legal proposition (`actors`, `proceeding/posture`, `legal_hooks`, `required outcome`, `contradictions`) and retrieves against that checklist.

Pass policy:
- Pass-1 (`always attempted` within budget): proposition + strict/broad variants
- Pass-2 (`conditional once`): proposition refinement from retrieved snippet evidence when exact coverage is weak

Set environment variables (local `.env.local` and Vercel Project Settings):

```bash
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-southeast-1
BEDROCK_INFERENCE_PROFILE_ARN=arn:aws:bedrock:...
LLM_REASONER_MODEL_ID=arn:aws:bedrock:...
PIPELINE_V2=1
QUERY_REWRITE_V2=1
ADAPTIVE_VARIANT_SCHEDULER=1
CANONICAL_LEXICAL_SCORING=1
ALWAYS_RETURN_V1=1
ALWAYS_RETURN_SYNTHETIC_FALLBACK=1
RETRIEVAL_PROVIDER=auto
SERPER_API_KEY=
IK_API_BASE_URL=
IK_API_KEY=
EMBEDDING_MODEL_ID=
RERANK_MODEL_ID=
VECTOR_DB_URL=
VECTOR_DB_API_KEY=
VECTOR_COLLECTION=
HYBRID_RETRIEVAL_V1=0
HYBRID_RRF_K=60
HYBRID_SEMANTIC_TOPK=24
HYBRID_LEXICAL_TOPK=18
PROPOSITION_V3=1
PROPOSITION_V41=1
PROPOSITION_V5=1
LLM_REASONER_MODE=initial
LLM_REASONER_TIMEOUT_MS=4500
LLM_REASONER_MAX_TIMEOUT_MS=9000
LLM_REASONER_RETRY_ON_TIMEOUT=0
LLM_REASONER_MAX_CALLS_PER_REQUEST=2
LLM_REASONER_MAX_TOKENS=360
LLM_REASONER_HARD_MAX_TOKENS=520
LLM_REASONER_CACHE_TTL_SEC=21600
LLM_REASONER_PASS2_CACHE_TTL_SEC=900
LLM_REASONER_STRUCTURED_OUTPUT=1
LLM_REASONER_OPTIMIZED_LATENCY=1
LLM_REASONER_FALLBACK_MODEL_ID=global.anthropic.claude-sonnet-4-5-20250929-v1:0
BEDROCK_HEALTH_TIMEOUT_MS=9000
BEDROCK_HEALTH_OPTIMIZED_LATENCY=1
SEARCH_RESULT_CACHE_TTL_SEC=300
SEARCH_RUNTIME_PROFILE=fast_balanced
LLM_CIRCUIT_BREAKER_ENABLED=1
LLM_CIRCUIT_FAIL_THRESHOLD=2
LLM_CIRCUIT_COOLDOWN_MS=30000
AI_FAILOVER_MIN_CASES=4
AI_FAILOVER_MIN_REMAINING_BUDGET=4
PASS2_MIN_REQUIRED_COVERAGE=0.7
PASS2_MIN_HOOK_COVERAGE=0.8
REASONER_TIMEOUT_RECOVERY_MODE=extended_deterministic
EXTENDED_DETERMINISTIC_BUDGET_BONUS=6
PROPOSITION_EXACT_STOP_TARGET=4
PROPOSITION_STRICT_STOP_TARGET=3
PROPOSITION_BEST_EFFORT_STOP_TARGET=4
PROPOSITION_PROVISIONAL_CONFIDENCE_FLOOR=0.62
STRICT_HIGH_CONFIDENCE_ONLY=1
PROVISIONAL_CONFIDENCE_CAP=0.70
NEARMISS_CONFIDENCE_CAP=0.50
STRICT_INTERSECTION_REQUIRED_WHEN_MULTIHOOK=1
SEARCH_CACHE_SCHEMA_VERSION=v6
DEFAULT_GLOBAL_BUDGET=8
DEFAULT_VERIFY_LIMIT=8
IK_FETCH_TIMEOUT_MS=3000
IK_MAX_429_RETRIES=0
IK_MAX_RETRY_AFTER_MS=1500
IK_CHALLENGE_COOLDOWN_MS=30000
IK_GLOBAL_RPS=0.3
ATTEMPT_FETCH_TIMEOUT_CAP_MS=3500
TRACE_EXPANSION_MIN_REMAINING_MS=6000
LLM_REASONER_LOCK_WAIT_MS=250
PIPELINE_MAX_ELAPSED_MS=9000
VERIFY_CONCURRENCY=4
PRIMARY_MAX_PAGES=1
PROPOSITION_CHAIN_MIN_COVERAGE=0.75
SERPER_CACHE_TTL_SEC=600
```

Optional shared cache (recommended for multi-user production):

```bash
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=...
```

Behavior highlights:
- max two Opus calls per request (pass-1 + conditional pass-2)
- hard reasoner timeout + circuit breaker + fail-open deterministic fallback
- reasoner cache + search response cache
- exact matches in `cases` / `casesExact`
- strict/provisional split in `casesExactStrict` and `casesExactProvisional`
- near misses in `casesNearMiss` with missing-element tags
- blocked runs return explicit blocked outcomes and retry-after guidance
- when detail verification is unavailable (for example Serper retrieval), snippet-based provisional outputs are still returned with confidence caps

## Build and Validation

```bash
npm run lint
npx next build --webpack
```

Note: `next build` with Turbopack may fail in restricted sandboxes due to local process restrictions. On Vercel, standard production builds run normally.

## API

### `POST /api/search`

Request body:

```json
{
  "query": "Natural-language fact scenario",
  "maxResults": 20
}
```

Response includes:
- compiled proposition summary (`requiredElements`, `optionalElements`)
- proposition constraints (`hookGroups`, `relations`, `outcomeConstraint`, `interactionRequired`)
- generated keyword pack (`primary`, `legalSignals`, `searchPhrases`)
- fetched and filtered counts
- ranked exact-match cases with calibrated confidence bands
- split lists: `casesExactStrict`, `casesExactProvisional`, `casesNearMiss`
- request id + search insights summary
- optional `reasoning` telemetry (`mode`, `cacheHit`, `latencyMs`, `degraded`)
- optional `pipelineTrace` including retrieval `providerId`
- runtime status metadata (`status`, `retryAfterMs`, `partialRun`)

### `GET /api/health/bedrock`

Runs a bounded Bedrock `Converse` probe and returns diagnostic JSON (including region/model/error classification hints).

## Deployment (Vercel)

1. Push this repo to GitHub/GitLab/Bitbucket.
2. Import into Vercel.
3. Build command: `next build` (or `next build --webpack` if needed).
4. Output directory: `.next`.
5. Configure env vars, especially `RETRIEVAL_PROVIDER` and `SERPER_API_KEY`.

## Important

This tool is a triage system, not legal advice. Always verify citations and holdings from original judgments before relying on results.
