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
