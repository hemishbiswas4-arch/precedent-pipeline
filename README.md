# Precedent Finder (HC/SC)

Automated legal research triage app for:
- converting natural-language fact scenarios into targeted legal keyword packs
- querying Indian Kanoon search pages
- filtering to likely High Court (HC) and Supreme Court (SC) decisions
- ranking case candidates by match score with transparent reasons

## Compliance Boundary

This app does **not** bypass anti-bot systems (Cloudflare, CAPTCHA, or similar protection).

If source-side protections block requests, you should use:
- official APIs/data feeds (if available)
- licensed legal databases
- manual workflow fallback

## Local Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Optional: Universal Two-Pass Reasoner (Bounded, Fail-Open)

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
PIPELINE_V2=1
PROPOSITION_V3=1
PROPOSITION_V41=1
PROPOSITION_V5=1
IK_CHALLENGE_COOLDOWN_MS=120000
LLM_REASONER_MODE=initial
LLM_REASONER_MODEL_ID=arn:aws:bedrock:...
LLM_REASONER_TIMEOUT_MS=1200
LLM_REASONER_MAX_TIMEOUT_MS=1800
LLM_REASONER_MAX_CALLS_PER_REQUEST=2
LLM_REASONER_MAX_TOKENS=450
LLM_REASONER_CACHE_TTL_SEC=21600
LLM_REASONER_PASS2_CACHE_TTL_SEC=900
SEARCH_RESULT_CACHE_TTL_SEC=300
SEARCH_RUNTIME_PROFILE=fast_balanced
CLIENT_DIRECT_RETRIEVAL_ENABLED=1
CLIENT_DIRECT_STRICT_VARIANT_LIMIT=2
NEXT_PUBLIC_CLIENT_DIRECT_RETRIEVAL_ENABLED=1
NEXT_PUBLIC_CLIENT_DIRECT_PROBE_TTL_MS=1800000
LLM_CIRCUIT_BREAKER_ENABLED=1
LLM_CIRCUIT_FAIL_THRESHOLD=5
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
ATTEMPT_FETCH_TIMEOUT_CAP_MS=3500
TRACE_EXPANSION_MIN_REMAINING_MS=6000
LLM_REASONER_LOCK_WAIT_MS=250
PIPELINE_MAX_ELAPSED_MS=9000
VERIFY_CONCURRENCY=4
PRIMARY_MAX_PAGES=1
PROPOSITION_CHAIN_MIN_COVERAGE=0.75
```

Optional shared cache (recommended for multi-user production):

```bash
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=...
```

Behavior:
- max two Opus calls per request (pass-1 + conditional pass-2)
- hard reasoner timeout + circuit breaker + fail-open deterministic fallback
- adaptive reasoner timeout (`1200ms` base, up to `1800ms` for complex propositions) while respecting pipeline elapsed-time budget
- reasoner pass-1 cache (default 6h) + pass-2 cache (default 15m) + search response cache (default 5m)
- exact proposition matches returned in `cases` / `casesExact`
- strict exact and provisional exact are split into `casesExactStrict` and `casesExactProvisional`
- near misses returned separately in `casesNearMiss` with missing-element tags
- V5 role-chain conjunctive gating enforces actor/posture/outcome-chain semantics for no-hook propositions
- exact gating requires all required hook groups + outcome polarity (precision-first)
- confidence is calibrated and displayed as bands (`VERY_HIGH`, `HIGH`, `MEDIUM`, `LOW`)
- `HIGH/VERY_HIGH` confidence is only emitted for strict exact matches with doctrinal evidence-window support
- confidence is capped by class (`strict <= 0.95`, `provisional <= 0.70`, `near miss <= 0.50`) to prevent misleading `100%` saturation
- deterministic timeout recovery can expand deterministic budget (`extended_deterministic`)
- blocked/cooldown runs are returned as explicit blocked outcomes with retry-after guidance and are not written to response cache
- fast-balanced runtime defaults: smaller phase budget + top-8 verification + per-fetch timeout + capped 429 retry
- per-attempt fetch cap (`ATTEMPT_FETCH_TIMEOUT_CAP_MS`) and lower page depth keep long-tail source slowness from stalling the full run
- under latency pressure, the API returns best partial verified output with `partial_due_to_latency_budget` note instead of waiting for long tail retries
- stale replay is disabled by policy for blocked/error runs
- `cases` is always an alias of exact matches for backward compatibility
- client-first routing is best-effort: browser-side retrieval is attempted first (user IP), then finalized server-side; if browser retrieval is unavailable, server fallback is used automatically

`PIPELINE_V2` controls the staged retrieval engine:
- `PIPELINE_V2=1` (default): staged pipeline with planner/scheduler/classifier/verifier + `pipelineTrace`.
- `PIPELINE_V2=0`: legacy fallback engine (kept for one release window safety).

`IK_CHALLENGE_COOLDOWN_MS` sets a local cooldown window after Cloudflare challenge/429 detection. During cooldown, requests fail fast with explicit blocked diagnostics instead of repeatedly retrying dead requests.

## Build and Validation

```bash
npm run lint
npx next build --webpack
```

Note: `next build` with Turbopack may fail in some restricted sandboxes due to local process restrictions. On Vercel, standard production builds run normally.

## API

## API Endpoints

### `POST /api/search` (backward-compatible full server path)

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
- ranked exact-match case list with calibrated confidence (plus confidence band)
- additive split lists: `casesExactStrict`, `casesExactProvisional`
- optional near-miss list (`casesNearMiss`) with missing proposition elements
- request id + search insights summary
- optional `reasoning` telemetry (`mode`, `cacheHit`, `latencyMs`, `degraded`)
- optional `pipelineTrace` (planner/scheduler/retrieval/classification/verification)
- optional `debug` payload (only when requested by client)
- routing metadata (`executionPath`, `clientDirectAttempted`, `clientDirectSucceeded`)
- runtime status metadata (`status`, `retryAfterMs`, `partialRun`)

### `POST /api/search/plan` (client-first planning)

Returns:
- cleaned query/context/proposition constraints
- strict and fallback query variants
- runtime budget profile
- client retrieval readiness settings

### `POST /api/search/finalize` (client hits -> server verification/ranking)

Accepts sanitized client-collected Indian Kanoon candidate hits and returns:
- verified strict/provisional/near-miss splits
- confidence-banded rankings
- full pipeline trace and notes

The V3 gate prevents doctrinally adjacent cases from being marked exact by requiring:
- all required legal-hook groups in evidence
- required hook-group interaction/relations (when proposition demands intersection)
- required outcome polarity (for example `sanction required` vs `sanction not required`)
- contradiction rejection (for example condoned/restored when refusal is required)

The V2 pipeline enforces strict case-only output and uses budgeted fail-fast behavior when repeated Cloudflare/429 blocking is detected.

## Deployment (Vercel)

1. Push this repo to GitHub/GitLab/Bitbucket.
2. Import into Vercel.
3. Build command: `next build` (default) or `next build --webpack` if needed.
4. Output directory: `.next` (default).
5. Deploy.

### Hybrid User-IP Routing (Important)

- On Vercel, server-side egress IP is not per-end-user.
- Per-user source IP is only possible when retrieval executes in the browser.
- This app uses a best-effort hybrid path: browser retrieval first (when possible), then server fallback.
- If browser direct retrieval is blocked by source/CORS/challenge constraints, the app transparently falls back to server retrieval.

## Important

This tool is a triage system, not legal advice. Always verify citations and holdings from original judgments before relying on results.
