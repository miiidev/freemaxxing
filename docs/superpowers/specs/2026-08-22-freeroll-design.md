# Freeroll — Design Spec

**Date:** 2026-08-22
**Status:** Approved (pending implementation plan)
**Tagline:** *No entry fee, real winnings — every free AI model, one endpoint.*

## 1. Overview

Freeroll is a local OpenAI-compatible proxy that exposes curated **free-tier AI
models** from multiple providers behind stable model aliases (`auto/coding`,
`auto/fast`, `auto/any`). When the selected model hits its rate limit, the same
request transparently fails over to the next-best available free model.

Personal tool first. Single Node process, TypeScript, minimal dependencies.

### Problem

Free tiers are generous in aggregate but individually tiny. A coding agent
(opencode, Claude Code, editors) pointed at one provider stalls the moment its
quota runs out, and manually switching models mid-task breaks flow and tooling.

### Solution

One endpoint that knows every free model worth using, ranks them by usefulness
for the task, and reroutes around exhausted quotas automatically — with full
transparency about which model actually answered.

## 2. Goals / Non-goals

### Goals (v1)

1. `POST /v1/chat/completions` — streaming and non-streaming, with tool calls.
2. `GET /v1/models` — lists aliases and underlying models.
3. Smart auto-routing: alias → best available model; automatic failover on
   rate limits within a single request.
4. Providers: OpenRouter (`:free`), Groq, Google AI Studio, Mistral, GitHub
   Models, Cerebras — any free model worth using for coding.
5. Graceful degradation: providers without API keys are simply excluded.
6. `freeroll status` — per-model limit/health state at a glance.
7. Transparency: every response reports which model actually served it.

### Non-goals (v1)

- Web dashboards or UIs of any kind.
- Active quota polling / provider health APIs (failover is reactive only).
- Embeddings, completions (legacy), images, audio endpoints.
- Response caching.
- Multi-user support, auth on the proxy itself (localhost only).
- Live benchmarking; model ranking is hand-curated.

## 3. Architecture

**Zero-adapter principle:** every target provider exposes an OpenAI-compatible
endpoint, so providers are *configuration*, not code. Intelligence lives in
three modules: **Registry**, **Router**, **Failover executor**.

```
                 ┌────────────────────────────────────────────┐
 opencode ──► :8787 │ Freeroll (Fastify, localhost)              │
 Claude Code     │                                            │
 curl ────────►  │  server.ts ─► router.ts ─► executor.ts ────┼──► openrouter.ai/api/v1
                 │                  │             │           │──► api.groq.com/openai/v1
                 │            registry.json   state.ts       │──► generativelanguage.../openai/
                 │            providers.json  (snapshot →    │──► api.mistral.ai/v1
                 │              + quirks/*     ~/.freeroll/) │──► models.github.ai
                 └────────────────────────────────────────────┘──► api.cerebras.ai/v1
```

### Component responsibilities

| Module | Responsibility |
|---|---|
| `server.ts` | Fastify wiring; `/v1/chat/completions`, `/v1/models`; SSE passthrough |
| `router.ts` | Pure functions: alias + request context → ordered candidate list |
| `executor.ts` | Attempt loop over candidates; failover triggers; streaming boundary gate |
| `state.ts` | In-memory model state Map; snapshot to/from `~/.freeroll/state.json` |
| `quirks/*` | Per-provider error-shape parsing → normalized failure classification |
| `config.ts` | Load/validate user config, `.env`, built-in catalogs |
| `cli.ts` | `freeroll serve` (default) / `freeroll status` |

## 4. Component design

### 4.1 Registry (`src/registry.json`, committed)

Hand-curated catalog of ~30–60 free models. One entry per upstream model:

```json
{
  "id": "openrouter::deepseek/deepseek-chat-v3:free",
  "provider": "openrouter",
  "upstream": "deepseek/deepseek-chat-v3:free",
  "tags": ["coding", "chat"],
  "tier": 1,
  "speed": "fast",
  "context": 64000,
  "tools": true
}
```

- `tier`: 1 = best for coding, hand-ranked by maintainers (the user). Lower is
  better. Ranking input: community benchmarks + personal experience.
- `tags`: subset of `coding | chat | fast | long-context | vision`.
- `tools`: whether tool-calling works reliably enough for agents on this model.
- Curation policy: only models that pass a manual smoke test get added.

### 4.2 Provider catalog (`src/providers.json`, committed)

Connection details per provider — users never write these:

```json
{
  "openrouter": {
    "baseURL": "https://openrouter.ai/api/v1",
    "auth": "bearer",
    "quirks": "openrouter",
    "resetProfile": { "kind": "daily-utc-midnight" }
  },
  "google": {
    "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "auth": "bearer",
    "quirks": "google",
    "resetProfile": { "kind": "daily-utc-midnight" }
  }
}
```

> Endpoint URLs to be verified against current docs during implementation
> (GitHub Models in particular has changed hosts before).

### 4.3 Quirks profiles (`src/quirks/<provider>.ts`)

~20 lines each. Interface:

```ts
interface Quirk {
  // Classify a failed upstream response into a normalized failure.
  classifyFailure(status: number, body: unknown, headers: Headers):
    { kind: "rate" | "quota" | "outage"; retryAfterMs?: number };
}
```

- `rate`: transient limit → short cooldown (from `Retry-After` or header math,
  default 60 s).
- `quota`: daily/monthly budget gone → `exhausted` until reset profile fires
  (e.g. next UTC midnight for daily-quota providers).
- `outage`: 5xx/network → cooldown 60 s default.

### 4.4 Router (`src/router.ts`) — pure functions

```
resolve(alias, registryState, requestCtx) -> Candidate[]
```

1. Filter registry entries matching the alias definition (see below).
2. Drop entries whose state is not `ok` (lazy expiry: expired cooldowns /
   resets flip back to `ok` on read).
3. If `requestCtx.hasTools`, require `tools === true`.
4. If `requestCtx.estTokens > entry.context * 0.9`, drop (rough estimate:
   JSON body chars ÷ 4).
5. Sort: tier ascending, then speed rank (`fast < medium < slow`),
   then id for determinism.

Built-in aliases:

| Alias | Filter | Sort |
|---|---|---|
| `auto/coding` | tag `coding`, `tools: true` | tier asc |
| `auto/fast` | any | speed asc, then tier |
| `auto/any` | any | tier asc |

Custom aliases (user config) reuse the same filter code:

```json
{ "aliases": { "auto/long": { "tags": ["long-context"], "requireTools": false } } }
```

### 4.5 Failover executor (`src/executor.ts`)

For one inbound request:

```
for candidate in resolve(...):
    open upstream stream/request (TTFB timeout, default 30 s)
    on success:
        if streaming: forward bytes as they arrive
        return response (model field rewritten, see §6)
    on failure (classified via quirks):
        record state transition
        continue to next candidate
all candidates failed:
    HTTP 503 with attempts breakdown (§6)
```

**Streaming boundary rule (hard requirement):** failover is allowed only while
*zero* response bytes have been forwarded to the client. Once the first token
is flushed, an upstream failure surfaces as an error to the client (SSE error
event / connection close). No silent mid-stream model switching — clients must
never see a Frankenstein response stitched from two models.

Non-streaming requests may failover on any pre-commit failure identically.

### 4.6 State store (`src/state.ts`)

```ts
type ModelState =
  | { state: "ok" }
  | { state: "cooldown"; until: number }   // epoch ms
  | { state: "exhausted"; until: number }; // epoch ms (reset-profile computed)
```

- In-memory `Map<modelId, ModelState>`; written through to
  `~/.freeroll/state.json` on every transition (atomic rename).
- Lazy expiry on read; no timers.
- Snapshot survives restarts so a freshly restarted proxy doesn't hammer
  providers known to be exhausted.

### 4.7 Config & keys

`~/.freeroll/config.json` (user-owned):

```json
{
  "port": 8787,
  "providers": {
    "openrouter": { "apiKeyEnv": "OPENROUTER_API_KEY" },
    "groq":       { "apiKeyEnv": "GROQ_API_KEY" },
    "google":     { "apiKeyEnv": "GEMINI_API_KEY" },
    "mistral":    { "apiKeyEnv": "MISTRAL_API_KEY" },
    "github":     { "apiKeyEnv": "GITHUB_TOKEN" },
    "cerebras":   { "apiKeyEnv": "CEREBRAS_API_KEY" }
  }
}
```

- A `.env` file beside the config is auto-loaded.
- Keys are read from env only; never logged; redacted in all output.
- Missing key ⇒ provider skipped entirely (no error, just absent from routing).
- Defaults: port 8787; bind `127.0.0.1` only.

### 4.8 CLI (`src/cli.ts`)

- `freeroll serve` (default when no args): start proxy, print listening line +
  how many providers/models are active.
- `freeroll status`: table — model / provider / tier / tags / state
  (`ok · cooldown 3m · exhausted until 00:00 UTC`). Reads snapshot without
  starting the server.

## 5. Request flow (happy path + failover)

```
client ─ POST /v1/chat/completions {model:"auto/coding", tools:[...]}
  │
  ├─ router.resolve("auto/coding", state, ctx)
  │    → [A(tier1, ok), B(tier2, ok), C(tier3, ok)]
  │
  ├─ executor tries A → 429 (quirks: kind=quota, daily)
  │    state[A] = exhausted until UTC-midnight
  │
  ├─ executor tries B → 200, first token arrives
  │    forward SSE bytes …
  │
  └─ client receives stream with model="B", x-freeroll-served-by: B
     log: req=42 alias=auto/coding tried=A(quota) served=B ms=812
```

## 6. Error handling & observability

- Response `model` field always reports the actual serving model; header
  `x-freeroll-served-by` mirrors it.
- All candidates fail ⇒ `503`:

```json
{ "error": {
    "type": "all_models_exhausted",
    "message": "No free model available for auto/coding right now.",
    "attempts": [
      { "model": "openrouter::deepseek/deepseek-chat-v3:free", "reason": "quota" },
      { "model": "groq::llama-3.3-70b-versatile", "reason": "rate" }
    ] } }
```

- Unknown alias ⇒ `404`; malformed request ⇒ `400` passthrough of validation
  error; no keys configured at all ⇒ server starts but `/v1/chat/completions`
  returns the 503 shape above.
- One log line per request (stdout): timestamp, alias, attempted models with
  reasons, serving model, total ms. Keys never appear anywhere in logs.
- Failures are classified *before* cooldown decisions so a provider blip
  (outage) can't masquerade as a personal quota exhaustion.

## 7. Testing strategy

1. **Unit** — `router.resolve` (filter/rank/determinism, lazy state expiry);
   quirk parsers fed recorded fixture bodies per provider (429 shapes vary).
2. **Integration** — mock upstreams scripted 429→success sequences; assert
   attempt order, state transitions persisted to snapshot, correct served-by.
3. **Streaming boundary** — upstream fails after N tokens ⇒ client sees error,
   no second-model bytes ever mixed in; upstream fails pre-token ⇒ clean
   transparent failover.
4. **Config edge cases** — missing keys, empty registry matches, bad config.
5. **Manual smoke** — one real request per provider with live keys (documented
   checklist, run at release time).

Framework: vitest. No network access in CI tests — everything mocked.

## 8. Stack & layout

- Node ≥ 20, ESM, TypeScript strict, vitest, Fastify, global `fetch`.
- No SDKs — raw HTTP keeps the zero-adapter promise honest.

```
src/
  cli.ts  server.ts  router.ts  executor.ts  state.ts  config.ts  log.ts
  quirks/{types,openrouter,groq,google,mistral,github,cerebras}.ts
  registry.json  providers.json
test/
  unit/…  integration/…
docs/superpowers/specs/2026-08-22-freeroll-design.md
docs/superpowers/plans/2026-08-22-freeroll.md          (implementation plan, later)
```

## 9. Milestones (for the implementation plan to refine)

1. **M1 — Skeleton:** serve mode, one provider hardcoded, passthrough chat
   completions incl. streaming.
2. **M2 — Routing:** registry + providers catalogs, aliases, router unit
   tests.
3. **M3 — Failover:** quirks, state store, executor attempt loop, streaming
   boundary, integration tests.
4. **M4 — Polish:** status CLI, all six providers curated in registry, README,
   manual smoke checklist.

## 10. Future directions (explicitly out of v1)

Custom ranking from personal usage stats · mini dashboard · quota polling ·
embeddings passthrough · response caching · publish to npm.
