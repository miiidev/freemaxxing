# Freeroll — Next-Level Phase Design

Date: 2026-08-24
Status: Approved (pending implementation plans)
Source: `freeroll-next-level-handoff.md` (strategy + priority order preserved verbatim)
Predecessor: `2026-08-22-freeroll-design.md` (base product), `2026-08-23-quota-harvest-design.md` (harvest mode)

## 0. Strategic framing

OpenRouter's `openrouter/free` auto-router commoditizes "route me to a free model."
Freeroll's differentiation must live in what OpenRouter structurally cannot build:

1. Pooling free quota **across** providers, not within one account-level bucket.
2. Knowing the caller is a **coding agent**, not a generic chat client.

Everything below is ordered by defensibility (handoff order preserved):

| # | Feature | Ships as |
|---|---|---|
| 1 | Verify/fix cross-provider pool semantics | Plan A (with #2) |
| 2 | Failure-taxonomy-aware routing | Plan A (with #1) |
| 3 | Agent-aware tool-call validation | Plan B |
| 4 | Reliability-scored model ranking | Plan C (with #5, #6) |
| 5 | Public reliability data (`export-stats`) | Plan C |
| 6 | Local-first / privacy positioning (README) | Plan C |
| 7 | Onboarding wizard (`freeroll setup`) | Plan D |

Each plan produces working, testable software on its own and may be executed
independently, in order. Features 1→2 are one subsystem; 4 depends on the event
hooks introduced by 3 only at runtime (Plan C works without Plan B — outcomes
then come from stream/request completion alone).

## 1. Feature: cross-provider pool semantics (#1)

### Problem

OpenRouter's `:free` limit is **account-wide**. Hitting the cap on any OpenRouter
free model kills every other OpenRouter free model until UTC reset. Failing over
to a sibling OpenRouter model is wasted latency.

### Current-state audit (code-verified 2026-08-24)

Harvest already models pools at resolve time:

- `providers.json` seeds pool caps (`openrouter.rpd=50`, `groq.rpd=1000`,
  `cerebras.tpd=1_000_000`); `mergedProviderCaps()` exposes them.
- `resolve()` filters candidates whose provider pool cannot fit the request and
  sorts by pooled headroom (`router.ts` `budgetOk`/`headroom`, `usage.ts`
  `fitsBudget`/`usedFraction`).

The gaps are all on the **reactive** side and the **display** side:

1. A quota-class 429 marks **only the requesting model** exhausted
   (`state.ts:applyFailure` via `executor.recordFailure`). Sibling models of a
   pooled provider stay `"ok"` until each one 429s in turn.
2. `maybeExhaust()` after a served request likewise marks only the served model;
   the pool entry itself never exists as state.
3. Within a single request's failover loop, after candidate N exhausts an
   OpenRouter pool, the executor still attempts every remaining
   `openrouter::*` candidate in the list before moving to Groq et al.
4. `freeroll status` prints a `pool x/y` fragment per model row, implying
   per-model headroom rather than one shared bucket.

### Design

**Provider-level state entries.** The existing `StateMap` gains entries keyed
`pool::<provider>` (e.g. `pool::openrouter`). Keying invariant: registry model
ids are always `<provider>::<upstream>`, so `pool::<provider>` can only collide
if a provider were literally named `pool` — providers.json keys are validated
against that assumption in review.

- When a failure classifies as `quota` **and** the provider has pooled caps,
  the executor sets `pool::<provider>` = `{ state:"exhausted",
  until: nextUtcMidnight(now), reason:"pool" }` **and** marks the requesting
  model exhausted with reason `"pool"`.
- After serving a request, if pooled budget is spent, the server marks the pool
  entry exhausted (mirror of today's per-model `maybeExhaust`, new
  `maybeExhaustProvider`).
- `execute()` checks `isProviderBlocked(pool)` before each attempt and skips
  remaining same-pool candidates instantly (attempt record
  `reason:"pool-exhausted"`), so failover jumps straight to the next provider.
- `resolve()` filters every candidate whose provider pool is blocked via a new
  optional ctx hook `getProviderState(provider): ModelState | undefined`.

**Status display.** `status` groups rows under providers. Providers with pooled
caps print one summary line:

```
[pool] openrouter   req 23/50   ok · resets 00:00 UTC   shared by 12 models
```

Model rows beneath it keep per-model columns but no longer repeat the pool
fragment. Pools and per-model limits are therefore visually distinct.

### Acceptance criteria (handoff, verbatim)

- Unit test: simulate OpenRouter pool exhaustion after N requests; assert next
  request routes to a non-OpenRouter provider without attempting any other
  `openrouter::*` model first.
- `freeroll status` output visually distinguishes provider-wide pools from
  independent per-model limits.

## 2. Feature: failure-taxonomy-aware routing (#2)

### Failure classes

| Class | Signal | Reaction |
|---|---|---|
| `PoolExhausted` | quota-class 429 where provider has pooled caps | Mark whole pool dead until reset; skip to next provider |
| `ModelCooldown` | rate-class 429 (per-model throttle) | Park just that model for backoff window; next candidate |
| `ModelRetired` | HTTP 404 | New persistent `{state:"retired"}`; never auto-expires; cleared via `freeroll revive`; logged for registry maintenance |
| `TransientError` | 5xx / timeout / connection reset | Retry **same model once** after short backoff, then cool down + fail over |
| `MalformedOutput` | 200 but tool-call payload invalid/truncated/cut off | Quality signal, not health signal → feeds #4; fail over only pre-first-byte (see #3) |

Mapping onto today's `FailureKind`: `rate` → ModelCooldown, `quota` →
PoolExhausted or per-model cap exhaustion (depending on pool caps),
`outage` → TransientError, new `retired` kind ← HTTP 404, new `malformed`
produced by #3's validator. `bad_request` unchanged (never poisons state).

### Data model

```ts
export type FailureKind = "rate" | "quota" | "outage" | "bad_request" | "retired";

export type ModelState =
  | { state: "ok" }
  | { state: "cooldown"; until: number; reason?: "peak-throttle" | "transient" }
  | { state: "exhausted"; until: number; reason?: "pool" | "daily-cap" }
  | { state: "retired"; since: number };
```

Reasons are optional so existing `state.json` snapshots load unchanged.
`effective()` expiry logic untouched (`retired` has no `until`).
New CLI command `freeroll revive <model-id | provider-name>` deletes matching
state entries — the escape hatch that implements "until a registry refresh
confirms it's back" without adding background refresh machinery.

Quirks change: `404` leaves `CLIENT_ERROR_STATUSES`; `base()` returns
`{kind:"retired"}` for 404 across all six providers.

Executor changes: transient retry-once with injectable sleep
(`retryBackoffMs`, default 1000); retired demotion via `setState`.

### Acceptance criteria (handoff, verbatim)

- `freeroll status` shows the reason, not just the state
  (e.g. `cooldown 3m (peak-throttle)`, `exhausted (pool) until …`,
  `retired since …`).
- Integration test per failure class confirming the differentiated action.

## 3. Feature: agent-aware tool-call validation (#3)

### Design

New module `src/toolcall.ts`. Validation applies whenever the request needs
tools (alias `requireTools === true` **or** request carries a non-empty
`tools` array — same predicate the router uses).

Checks against the parsed completion:

1. `finish_reason === "length"` (or equivalent cutoff) → malformed.
2. Each present `tool_calls[i]`: non-empty `function.name`; name ∈ requested
   tools; `function.arguments` parses as JSON object (string or object form);
   every `parameters.required` key present and non-empty.
3. No tools requested → cutoff/emptiness checks only.

**Documented leniency decision:** a *prose-only reply* to a tools-carrying
request is **not** malformed (coding agents legitimately get clarifying-text
replies). Absence of tool calls never fails validation; malformedness requires
present-but-broken structure or a cutoff signal. This keeps the false-positive
rate at zero against valid corpora, which is an explicit acceptance criterion.

**Failover boundary (unchanged rule, two code paths):**

- Non-streaming: nothing has reached the client, so the executor gains an
  `inspect(entry, response)` hook (runs against a `response.clone()`). A failed
  inspection records attempt `malformed <reason>`, fires
  `onMalformed(modelId, reason)`, and continues to the next candidate — the
  agent never sees the broken response.
- Streaming: bytes commit immediately, so no silent failover (existing design).
  A new `sseToolCallGuard` transform reassembles tool-call deltas from the
  stream and, when validation fails, appends a terminal
  `data: {"freeroll_error":"malformed_tool_call","detail":"…"}` frame instead of
  letting a corrupted tool call land as if valid. Mid-stream upstream failures
  keep today's `upstream_stream_failed` frame.

**Event log:** every malformed-output event appends one JSON line to
`~/.freeroll/malformed.jsonl`: `{ ts, model, reason }` — reason codes only,
never response content. This file is the raw feed for #4.

### Acceptance criteria (handoff, verbatim)

- Fixture set of known-bad outputs (truncated JSON, missing required arg,
  empty diff/cutoff) run through the validator; all rejected before reaching
  the client on non-streamed responses.
- No false positives against valid tool-call corpora from ≥ 3 providers'
  formats.

## 4. Feature: reliability-scored ranking (#4)

### Design

New module `src/reliability.ts`; store at `~/.freeroll/reliability.json`:
`Record<modelId, OutcomeEvent[]>` with `OutcomeEvent =
{ ts:number; ok:boolean; latencyMs?:number; kind?:string }`.

- Rolling window = last `windowSize` events (default 200) **and** last 7 days,
  whichever binds; pruned on write (lazy, no timers — project pattern).
- Score = successes ÷ samples over the window; `null` when zero samples.
- Demotion: `samples ≥ minSamples && score < demoteBelow` → the model sorts
  below all non-demoted models regardless of static tier (demote flag is the
  first comparator term in both alias comparators). Demotion reorders, never
  removes — a demoted model remains a last-resort candidate.
- Fewer than `minSamples` samples → falls back to pure static ranking.

Recording points (server): non-streaming success post-validation →
`{ok:true, latencyMs}`; malformed verdict → `{ok:false, kind:"malformed"}`;
stream close clean → `{ok:true}`; mid-stream error/malformed guard →
`{ok:false}`. Latency is tracked and displayed but deliberately **not** part
of the score (explainability; YAGNI).

Config surface (defaults shown):

```json
{ "reliability": { "windowSize": 200, "minSamples": 10, "demoteBelow": 0.85 } }
```

Router ctx gains `getReliability?(id)` + inline config; `resolve()` stays a
pure function.

### Acceptance criteria (handoff, verbatim)

- `freeroll status --reliability` shows per-model success rate and sample count.
- A model forced to fail validation repeatedly visibly drops below a
  higher-static-tier model within the configured window.

## 5. Feature: export-stats (#5)

`freeroll export-stats [--out FILE]` writes an anonymized snapshot of
`~/.freeroll/reliability.json`:

```json
{ "generatedAt": "…", "window": { "windowSize":200, "minSamples":10, "demoteBelow":0.85 },
  "models": [ { "id":"groq::openai/gpt-oss-120b", "score":0.93, "samples":142, "avgLatencyMs":812 } ] }
```

Only models with samples appear; fields are allowlisted (id, score, samples,
avgLatencyMs — no prompts, paths, keys, content). Default output is stdout;
`--out` atomically writes a file (tmp+rename). **Fully inert unless invoked** —
no daemon, no network call anywhere in this feature. Aggregation endpoint is
explicitly out of scope this phase.

### Acceptance criteria (handoff, verbatim)

- Export contains no prompt content, file paths, or key material — verified by
  a test feeding sentinel strings through the pipeline and asserting absence.
- Inert unless explicitly invoked (command-only; no startup hooks).

## 6. Feature: local-first / privacy positioning (#6)

Docs task shipped inside Plan C so the privacy claim and #5's opt-in framing
land together. README gains a "Local-first & privacy" section stating exactly
what the code does (audited list below); nothing claimed beyond behavior:

- Keys live only in the environment / `~/.freeroll/.env`.
- Requests go machine → provider directly; freeroll holds no third-party hop.
- Persisted data inventory: `usage.json` (daily counters),
  `state.json` (health states), `reliability.json` (outcome/latency events),
  `malformed.jsonl` (reason codes). Prompt/response bodies are never written
  to disk; console logs contain model ids and status codes only.

### Acceptance criterion (handoff)

README claims audited against actual code behavior (harvest/logging paths
reviewed during the task).

## 7. Feature: onboarding wizard (#7)

`freeroll setup` (interactive default, flags for scripting):

- Recommends **one** easiest provider first — Groq (fast signup, generous free
  tier) — framed as sufficient; remaining providers offered afterward as
  optional bonus capacity.
- Shows signup URL, best-effort OS open, waits for pasted key, validates via
  lightweight `GET {baseURL}/models` bearer call, then merges the key into
  `~/.freeroll/.env`.
- Provider catalog excludes GitHub Models (retired July 2026):
  groq, google, openrouter, mistral, cerebras.
- Non-interactive path: `freeroll setup --provider groq --key gsk_...`.
- README Quickstart rewritten to lead with `freeroll setup`.

### Acceptance criterion (handoff)

Zero-key user goes from `npm install` to a working `auto/coding` request using
only `freeroll setup` and one provider signup (manual smoke checklist added to
`docs/manual-smoke.md`).

## 8. Cross-cutting decisions & deviations log

1. **Pool state lives in the existing StateMap** under `pool::<provider>`
   rather than a second store — one persistence path, one snapshot format,
   atomic-write pattern reused.
2. **`quota` maps to pool exhaustion only when pooled caps exist** (openrouter,
   groq, cerebras). Google/Mistral quota hits stay per-model
   (`reason:"daily-cap"`), matching their published per-model limits.
3. **404 ⇒ retired globally** (not pattern-matched): on `/chat/completions` a
   404 is effectively always "model id unresolved"; false retirement risk is
   accepted and reversible via `freeroll revive`.
4. **Transient retry is executor-internal** with injectable clock/sleep so the
   suite stays fully offline and instant.
5. **Prose replies to tool requests are valid** (leniency above) — deviation
   from a strict reading of the handoff, justified by the false-positive AC.
6. **Latency excluded from the reliability score** (display-only) — handoff
   lists latency among tracked metrics but defines demotion by success rate.
7. **Streaming validation is post-hoc** (error frame at stream end) because
   completeness is unknowable before the final delta; consistent with the
   frozen failover boundary.
8. **GitHub excluded from the wizard** (provider retired; env var still parsed
   for backwards compat).

## 9. Out of scope (handoff, unchanged)

- Hosted/shared key pooling across users.
- Prompt-based tool-calling harness for chat-only models.
- Opt-in aggregation endpoint / public leaderboard site (data model in #5 is
  designed to make it trivial later).
