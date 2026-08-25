# Maxout — Phase 2 Resilience & Quality Design

Date: 2026-08-25
Status: Approved (pending implementation plans)
Source: `maxout-phase2-handoff.md` (problem statements + priority order preserved verbatim; "freeroll" names translated to the shipped `maxout` product name per the 2026-08-25 rename)
Predecessor: `2026-08-24-next-level-design.md` (phase 1 — failure taxonomy, reliability scoring, tool-call validation, setup wizard), `2026-08-23-quota-harvest-design.md` (harvest mode), `2026-08-22-freeroll-design.md` (base product)

## 0. Framing

Phase 1 stopped wasted free capacity and bad output. Phase 2 closes the two remaining gaps:
users still hit a hard wall when free quota runs out, and routing — while failure-aware now —
is still a black box that ignores context size and session consistency.

| # | Feature | Ships as | Depends on |
|---|---|---|---|
| 1 | Local-model fallback tier | Plan A (`2026-08-25-local-fallback.md`) | phase 1 taxonomy (state reasons) |
| 2 | Context-window-aware routing | Plan B (`2026-08-25-context-routing.md`) | registry shape only |
| 3 | Session-sticky routing | Plan C (`2026-08-25-session-affinity.md`) | resolve() candidate list |
| 4 | Quota burn-rate forecasting | Plan D (`2026-08-25-burn-rate-forecast.md`) | harvest usage ledger |
| 5 | Opt-in hybrid mode with hard spend cap | Plan E (`2026-08-25-hybrid-mode.md`) | #1 (local tier) for "free AND local gone" semantics |
| 6 | Exportable routing decision logs | Plan F (`2026-08-25-routing-trace.md`) | #2 (`ContextTooSmall`), #3 (affinity reason), phase 1 taxonomy + reliability |

Plans are independently executable in letter order. The handoff's sequencing note is honored by
construction: #6 lands last so its trace output has every skip/reason source available to report.
Features acknowledged but **not** planned this phase: editor status surface (VS Code extension) —
see §7.

## 1. Feature: local-model fallback tier (#1)

### Problem

Once every cloud provider's free quota is exhausted for the day the user is simply blocked until
the next UTC reset.

### Current-state audit (code-verified 2026-08-25)

- `providers.json` entries are validated to be `https://` + bearer + env-key-backed
  (`catalog.ts:isProviderDef`); a localhost endpoint cannot ride that path unchanged.
- `resolve()` returns zero candidates when every model/provider state entry is non-OK
  (`router.ts:stateOk`); `server.ts` then returns `503 all_models_exhausted`. There is no tier
  below the cloud pool.
- The executor treats any entry with a matching `deps.providers[name]` as callable
  (`executor.ts:attemptOnce`), so a synthetic local provider can reuse the entire
  attempt/classify/failover machinery once injected.

### Design

**Config** in `~/.maxout/config.json`, default off:

```json
{ "local": { "enabled": false, "endpoint": "http://localhost:11434", "model": "qwen2.5-coder:7b", "contextWindow": 32768 } }
```

`contextWindow` sizes the synthetic registry entry's context field (local models vary wildly;
the default is conservative).

**Synthetic provider/model pair.** When enabled, `serve` injects a provider def keyed `"local"`
into `ServerDeps.providers`: `baseURL = <endpoint>/v1` (OpenAI-compatible; Ollama and llama.cpp
server both serve `/v1/chat/completions` and `/v1/models`), `auth: "bearer"` with a dummy key
(local servers ignore it), `quirks: "local"` (new quirk: shared base rules — 5xx outage,
404 retired, deterministic client errors — otherwise rate-limit cooldown). The model rides a
synthetic registry entry `{ id: "local::<model>", provider: "local", upstream: <model>, tags:
["coding","chat","fast","long-context"], tier: 9, speed: "slow", tools: true }` built on demand —
it is never written into `registry.json`.

**Probe.** `probeLocal()` does `GET <endpoint>/v1/models` with a 1500 ms timeout. Probes are lazy
with a 60 s memo instead of blocking startup (deviation from the handoff's "on startup" wording:
a startup probe delays `serve` listening and punishes slow-to-boot local servers; lazy probing
achieves the same silence — unreachable ⇒ tier absent — without boot cost, and recovers if the
user starts Ollama after maxout). Unreachable or disabled ⇒ no error, no noise anywhere.

**Routing rule (verbatim intent from handoff):** the local tier is entered only once *every*
cloud candidate eligible for the alias is in a non-OK state (`PoolExhausted` / `ModelCooldown` /
`ModelRetired` — i.e. any effective `ModelState ≠ ok`, which includes proactive daily-cap
exhaustion from harvest). It is never preferred over an available cloud model regardless of
latency. Implementation: after `resolve()` returns an empty candidate list, the server checks
`aliasCandidates(aliasDef, registry, hasTools)` (tag+tools filter, exported from `router.ts`);
if that set is non-empty and every member's effective state is non-OK and the probe says
available, the candidate list becomes `[localEntry]`. If the alias-eligible set is empty
(degenerate config) local is *not* substituted — conservative choice, documented.

Budget-only skips (harvest `fitsBudget` false before proactive marking leaves state `ok`) do not
trigger local fallback; this window is one request wide because `recordServed` marks exhaustion
immediately after each serve.

**Status.** `maxout status` prints one line after the provider groups:

```
local (ollama) — qwen2.5-coder:7b — available      # enabled + probe ok
local (ollama) — qwen2.5-coder:7b — unreachable    # enabled + probe failed
local — not configured                             # enabled:false or no config block
```

`(ollama)` is derived from port `:11434`; anything else prints `(custom)`.

**Setup wizard.** After the bonus-provider loop, `maxout setup` offers
`Configure local fallback (Ollama)? [y/N]` — default N keeps the wizard skippable-by-default.
Accepting prompts for endpoint (default above) and model (default above), probes once, and
writes the `local` block into `~/.maxout/config.json` via a new atomic `mergeConfigPatch()`
helper. EOF/decline exits the step silently.

### Decisions

1. Local requests flow through the unmodified executor: failures classify via the `local` quirk
   and land in `StateMap` under `local::<model>` like any model. Reliability outcomes are
   recorded for local too — users see local quality in `status --reliability`.
2. No streaming-specific handling: local responses stream through the existing pipe untouched.
3. Usage counters accrue under `local::<model>` harmlessly (no caps configured ⇒ never budgeted).

### Acceptance criteria (handoff)

- With all cloud providers simulated exhausted, a request successfully routes to the local tier.
- With no local server running and fallback unconfigured, behavior is byte-for-byte today's
  `503 all_models_exhausted` — no crash, no hang.
- `maxout setup` gains an optional, skippable "configure local fallback" step.

## 2. Feature: context-window-aware routing (#2)

### Problem

Free/quantized models frequently have smaller context windows than paid siblings. Routing a huge
agent request to a small-context model causes silent truncation that looks exactly like a quality
problem but is a capacity mismatch the router could have avoided.

### Current-state audit

- `RegistryEntry.context` holds the total context window; `router.ts:contextOk` applies a flat
  10% reserve: `estTokens <= floor(e.context * 0.9)`.
- Candidates failing the check vanish silently — there is no record they were excluded for
  context, and if *all* candidates fail, the request 503s even though a truncated-but-useful
  answer was possible.
- `estimateTokens` (chars/4 over the JSON body) exists and stays.

### Design

**Registry fields.** Every `registry.json` entry gains `maxOutput` (max output tokens, sourced
from provider docs at registry-build time; values below are best-effort snapshots and can be
corrected in-place — routing uses them only as headroom). `contextWindow` from the handoff maps
onto the existing `context` field — no duplicate field is introduced. `types.ts` gains optional
`maxOutput?: number`, validated by `catalog.ts` (absent or positive integer).

Snapshot values used: OpenRouter `:free` entries 8192 each; groq `gpt-oss-*` 32768, other groq
8192; google `gemini-2.5-pro`/`gemini-2.5-flash` 65536, `gemini-2.0-flash` 8192; mistral 8192;
cerebras 8192.

**Fit rule.** `contextOk` becomes: request fits iff
`ctx.estTokens + outReserve(entry) <= entry.context` where `outReserve = entry.maxOutput ?? 4096`
(`OUTPUT_RESERVE_DEFAULT`). This replaces the 10% heuristic (deviation, intentional: the new rule
is the handoff's "estimated input plus reasonable output headroom" stated exactly; worst-case
output reservation is the safe direction). `minContext` alias filtering is unchanged.

**Widen-back.** Context-excluded entries are collected in `ResolveResult.skippedByContext`. If
the kept list would be empty and `skippedByContext` is non-empty, those entries get a second
chance against every *non-context* filter (tags/tools/state/budget) and the result is returned
with `widened: true`; the server logs one stderr warning
(`maxout: no candidate fits ~N tokens; widening context filter`). A truncated response beats an
error, per handoff.

**Status.** `maxout status --verbose` appends an output-limit column (`out 8k` style via
`fmtCompact`) to model rows.

### Acceptance criteria (handoff)

- A simulated ~50k-input request excludes small-context free models (e.g. `qwen-2.5-coder…32b`,
  context 32k) from the candidate list while large-window models survive.
- Context/output limits visible via `freeroll status` → `maxout status --verbose`.
- (Added) widen-back produces candidates plus warning where today it produces a 503.

## 3. Feature: session-sticky routing (#3)

### Problem

Per-request load balancing makes one multi-turn agent task bounce across three models: mixed
code style, contradictions two turns apart.

### Current-state audit

`resolve()` re-sorts from scratch every request; nothing persists a selection between requests.
The server sees raw headers/body per request and already annotates responses, so a sticky layer
fits naturally between `resolve()` and `execute()`.

### Design

**Session key.** `x-maxout-session` header wins when the calling agent supplies one (truncated
to 64 chars). Otherwise: SHA-256 of `JSON.stringify(body.messages.slice(0, 2))`, hex-truncated to
16 chars (`src/session.ts:deriveSessionKey`). First-two-messages hashing is stable across a
conversation because agents append rather than prepend.

**Affinity store.** In-memory LRU (`SessionAffinity`, cap 256 sessions, insertion-order
eviction). Not persisted — a restart clears affinity, which merely re-selects a winner; documented
trade-off, not worth a file.

**Preference semantics.** `AliasDef` gains `sessionAffinity?: boolean`; built-ins become
`auto/coding: true`, `auto/fast: false`, `auto/any: false` (handoff: default-on for coding,
off for fast; `any` unspecified ⇒ off). When enabled and a sticky id exists *inside the resolved
candidate list*, that entry is moved to the front (it must still pass every live filter —
stickiness overrides sort order, never filters). When the sticky model is absent from the list
(cooled down, exhausted, retired, budget-dead), normal ranking picks the winner and *that* model
becomes sticky on success — failover sticks, exactly as the handoff specifies.

**Recording.** After a successful execute, `affinity.set(sessionKey, servedId)`.

### Acceptance criteria (handoff)

- Simulated multi-turn session against a healthy model routes 100% of requests to that model.
- Forcing the sticky model into cooldown mid-session triggers failover, and the newly selected
  model persists for the rest of the session.

## 4. Feature: quota burn-rate forecasting (#4)

### Problem

`maxout status` reports reactively (`12/50 used`). Nothing warns before a mid-task wall.

### Current-state audit

`usage.json` stores aggregate per-model-per-day counters only (`UsageRecord`); timestamps are
not retained, so no rate can be computed after the fact. `formatPoolLine` renders the `[pool]`
rows.

### Design

**Bounded timestamp retention.** `UsageRecord` gains optional `reqTs?: number[]` — UTC ms of
today's requests, newest kept, hard cap 500 per record (drop oldest). `recordUsage` appends when
`delta.requests > 0`; `loadUsage` sanitizes (non-array/garbage stripped). Storage growth is
bounded by construction: ≤ 500 numbers × models-with-traffic per day, dropped at rollover.

**Forecast.** `projectExhaustion(provider, caps, usageMap, now)` in `usage.ts`:

- Pool totals via existing `aggregateProvider`; pool request timestamps concatenated from the
  provider's model records.
- Returns `null` ("insufficient data") when the pool has no `rpd` cap, `< MIN_FORECAST_SAMPLES`
  (5) requests today, fewer than 15 minutes elapsed since UTC midnight, or the pool is already
  exhausted.
- Otherwise pure linear extrapolation from day start: `rate = requests / minutesElapsed`;
  `projectedAt = now + remaining/rate` rounded to the minute. Deliberately simple and
  hand-checkable — the acceptance test recomputes the arithmetic manually.

Timestamps are stored though v1's formula doesn't consume their distribution — explicit handoff
requirement ("retain request timestamps for a bounded recent window"), and they enable future
trailing-window rates plus per-hour diagnostics without another format migration.

**Status.** `[pool]` line gains a fragment when a forecast exists:

```
[pool] openrouter   req 32/50   ok · resets 00:00 UTC · projected exhaustion ~15:40 UTC   shared by 12 models
```

Pools without an `rpd` cap (cerebras tpd) show no forecast this iteration — documented.

### Acceptance criteria (handoff)

- Fixture history projects exhaustion matching manual linear extrapolation within tolerance
  (test asserts ±2 min).
- Forecast suppressed below minimum sample threshold (and below 15 min elapsed) — not guessed.

## 5. Feature: opt-in hybrid mode with hard spend cap (#5)

### Problem

Once free *and* local capacity is gone, waiting is the only option. Some users would pay a
small, predictable amount to keep working.

### Current-state audit

Nothing spends money: candidates come exclusively from `registry.json`, all free-tier. The
503 path fires when `execute()` exhausts candidates. Provider keys (e.g. `OPENROUTER_API_KEY`)
already authorize paid calls on the same endpoints — no new auth surface needed.

### Design

**Config**, off by default:

```json
{ "hybrid": { "enabled": false, "dailyCapUSD": 2.00, "provider": "openrouter", "model": "deepseek/deepseek-chat-v3.1", "priceInPerMTok": 0.27, "priceOutPerMTok": 1.10 } }
```

Defaults documented as approximate published prices for the default model; both prices feed the
fallback cost estimate only.

**Candidate injection.** When `hybrid.enabled` ∧ spend ledger under cap ∧ the configured
provider has a key, `server.ts` appends `hybridEntry(cfg.hybrid)` — a synthetic
`{ id: "<provider>::<model>", tier: 99, speed: "slow", tools: true, … }` — to the *end* of the
resolved candidates. Position-at-end *is* the handoff's trigger condition: the paid tier is
reached only after every free and local candidate failed. This reuses the whole
execute/failover/streaming path with zero new transport code.

**Spend ledger.** `~/.maxout/spend.json` `{ day, spentUSD }`, same UTC-day rollover +
atomic-write pattern as usage/state. Cost extraction per served paid response:
provider-reported `usage.cost` (USD number) when present, else
`prompt_tokens×priceIn + completion_tokens×priceOut` (streaming uses captured usage),
else $0 recorded. Recorded immediately post-response.

**Hard stop.** `underCap()` compares ledger to `dailyCapUSD` *before* injecting the candidate;
once `spentUSD >= cap` no paid routing occurs for the rest of the UTC day. The ledger persists
across restarts within the day, so restarting cannot evade the cap, and the cap clock
(UTC-daily) is explicitly independent of free-pool resets being simultaneous.

**Serving differences.** Paid responses skip: free usage counters, quota marking, reliability
scoring (paid health is not maxout's problem to score), malformed-output failover (paid models
are trusted; validation adds latency for no failover benefit past first byte anyway).
`x-maxout-served-by` still reports the real paid id — transparency over cosmetics.

**Status.** When enabled: `hybrid: $0.42 / $2.00 spent today`.

### Acceptance criteria (handoff)

- Hybrid disabled (default) ⇒ exhaustion behavior byte-for-byte identical to today; the system
  never spends without explicit opt-in.
- Simulated spend reaching the cap blocks further paid routing for the remainder of the day,
  verified independently of free-pool reset timing (ledger pre-seeded, fixed clock near UTC
  midnight boundary tested).

Known v1 limitation (documented): concurrent in-flight paid requests can overshoot the cap
slightly before their costs land in the ledger; single-user local proxy traffic makes this
acceptable.

## 6. Feature: exportable routing decision logs (#6)

### Problem

With taxonomy routing, reliability scoring, context awareness, and session affinity all
influencing decisions, *why* a request went where it went is no longer obvious. An opaque router
undermines trust in the reliability claims it makes.

### Current-state audit

- `resolve()` returns only `{ candidates, skippedByBudget }` (+ phase-B `skippedByContext`,
  `widened`); exclusion causes and winner rationale are implicit in code, unrecoverable at
  runtime.
- `AttemptRecord[]` from `execute()` captures post-resolution attempts; `formatRequestLog`
  prints a console line with no persistence.
- Privacy stance (phase 1 `export-stats`, `malformed.ts` comment): metadata only, content never.

### Design

**Richer resolve output.** `ResolveResult` gains:

- `considered: Array<{ id: string; excludedBy?: SkipReason }>` — every registry entry scanned
  for the alias, with the FIRST failing predicate as its skip reason. Predicate order =
  evaluation order: `tags` → `tools` → `context-too-small` → `cooldown` / `exhausted` /
  `retired` (model state) → `provider-blocked` (pool entry) → `budget`. Kept entries appear with
  rank order and no `excludedBy`.
- `winnerReason: string` — first discriminating labeled comparator between the top two kept
  candidates (`reliability-demoted` | `speed` | `tier` | `headroom` | `limited` | `id`), or
  `sole-candidate`. Comparators are refactored into a labeled array so labels can't drift from
  behavior.

`skippedByBudget` / `skippedByContext` remain (derived views of `considered`).

**Trace records.** `src/trace.ts` — `TraceRecord`:

```ts
{ requestId, ts, alias, sessionKey?, estTokens, widened,
  considered: [{ id, excludedBy? }],
  picked, pickedReason,   // pickedReason: hybrid-paid | local-fallback | session-affinity | <winnerReason>
  attempts: [{ model, reason }], servedBy? }
```

Structurally incapable of holding prompt/response content — only ids, enum-ish reason strings,
numbers. Retention: ring buffer capped 500 (`TRACE_CAP`), persisted to
`~/.maxout/traces.json` as one array with the tmp+rename atomic write per append (~150 KB worst
case; fine at proxy QPS). Corrupt file ⇒ start fresh (house pattern).

**Correlation.** Each request gets `requestId = r<seq>-<random>`; echoed via
`x-maxout-request-id` response header (JSON + streaming writeHead).

**pickedReason precedence** (server-side assembly): `hybrid-paid` (servedBy is the synthetic
paid entry) → `local-fallback` (servedBy.provider === "local") → `session-affinity` (affinity
moved the winner or the sticky model equals servedBy) → `resolved.winnerReason`.

**CLI.** `maxout trace <request-id>` prints human-readable detail; `--last [N]` lists recent
(one line each, default 20); `--json` emits raw records. `serve --trace` additionally logs one
line per request to stderr while serving. Recording itself is always-on once `bindTraceFile` is
bound in `serve` — bounded retention makes always-on safe, and traces you didn't know you needed
are the ones that help.

### Acceptance criteria (handoff)

- Trace output for a constructed scenario matches actual routing, including every skip reason in
  the correct taxonomy (unit tests pin predicate-order precedence; integration test pins a full
  request lifecycle).
- No prompt/response content appears in trace output under any default configuration
  (structural review + test feeding known-sensitive strings into messages and grepping the file).

## 7. Acknowledged, not planned this phase

**Editor status surface (VS Code extension or similar).** Real friction reducer, distinct UI
surface with its own build/marketplace/API-churn overhead. Revisit once phases 1–2 are stable
and there's concrete signal that CLI-only status checking blocks adoption.

## 8. Cross-feature interactions & sequencing

Execution order A→F (handoff priority). Interaction matrix:

- **A×E:** hybrid injection happens *after* local substitution; paid is reached only if the
  local attempt also fails (position guarantees it).
- **B×A:** context widening operates on cloud candidates only; the local gate keys on *state*,
  not context fit — a request too big for every cloud model gets the widened cloud list, not the
  local tier (strict handoff reading; revisit if users report it).
- **C×A/B/E:** affinity reorder runs on whatever candidate list exists (cloud, local-only, or
  cloud+paid); sticky ids outside the list fail over naturally.
- **D:** independent; display-only.
- **F:** consumes everything; lands last. `winnerReason` labels and skip-reason strings are its
  contract surface — plans A–E must not rename them (none introduce renames; F owns the final
  vocabulary).
- Config keys added: `local`, `hybrid`, alias-level `sessionAffinity` — all parsed leniently
  (absent ⇒ defaults), consistent with `loadConfig` style.

Follow-ups deliberately deferred: trailing-window burn-rate refinement (needs ts distribution
analysis), tpd-pool forecasts, trace compaction/rotation beyond the 500 cap.
