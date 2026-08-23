# Quota Harvest Mode — Design

Date: 2026-08-23
Status: Approved (pending implementation plan)

## 1. Goal

Freeroll currently routes every request to the best-ranked available model and only
moves on when that model fails. All traffic concentrates on one model until it hits
its daily cap, then cascades down. The pooled daily capacity of all free tiers gets
consumed either way — but concentrated spending causes predictable mid-day quality
cliffs, RPM burst failures, and wasted round trips on doomed 429s.

Quota harvest mode makes freeroll treat the user's free tiers as a budget to spend
deliberately:

- **Track** per-model daily request and token usage locally.
- **Skip proactively** any model whose remaining daily cap cannot fit the incoming
  request — before wasting a round trip.
- **Rotate within tier** so same-tier candidates share the load by remaining headroom.

Quality-first behavior is preserved: tier remains the primary sort key. Harvest
changes only how candidates *within a group* are ordered and which are excluded.

## 2. Non-goals

- RPM/TPM (short-window) tracking — reactive cooldowns already cover those; harvest
  handles daily caps only.
- Session stickiness / conversation pinning — the OpenAI API has no session concept;
  heuristics would be fragile.
- Semantic or quality-aware routing across tiers.
- Multi-key round-robin per provider.

### Provider-level pooled caps

Some daily caps are **shared across a provider's whole model catalog**, not per-model
(OpenRouter's free tier: 50 requests/day account-wide; Groq and Cerebras enforce
org-level daily caps). Per-model counters alone would overshoot these by the number of
catalog entries. Therefore limits exist at two levels:

```ts
// ProviderDef (providers.json) — pool shared by all of the provider's models
limits?: { rpd?: number; tpd?: number };

// RegistryEntry (registry.json) — per-model caps
limits?: { rpd?: number; tpd?: number };
```

Budget checks and rotation fractions evaluate BOTH levels: per-model usage against
model caps, and the sum of all models' usage under that provider against provider
caps. Config overrides mirror this: `modelLimits` keyed by registry id,
`providerLimits` keyed by provider name.

## 3. Data model

### Usage counters (`src/usage.ts`, new)

```ts
export interface UsageRecord {
  day: string;        // "YYYY-MM-DD" (UTC) this record belongs to
  requests: number;
  tokensIn: number;
  tokensOut: number;
}
```

- In-memory `UsageMap = Map<string /* registry id */, UsageRecord>`.
- Persisted to `~/.freeroll/usage.json` as `Record<string, UsageRecord>` with the same
  atomic tmp+rename write used by `state.json`. Separate file: health state (transient)
  and spend history (daily) have different lifetimes and must not corrupt each other.
- **Lazy rollover**: every read/write checks `record.day` against the current UTC day;
  stale records reset to zero. No timers, matching the project's existing pattern.
- Corrupt file → start empty (same policy as `loadState`).

### Limits metadata (`RegistryEntry` extension)

```ts
limits?: { rpd?: number; tpd?: number };   // requests/day, tokens/day caps
```

Seeded in `catalog.ts` from providers' current published docs (verified during
implementation; sources recorded in `docs/registry-notes.md`, matching the existing
curation-evidence pattern). Models without limits are **harvest-inert**: never
budget-skipped, treated as full headroom for rotation ordering.

## 4. Routing changes (`src/router.ts`)

`resolve()` gains an optional ctx field `getUsage(id): UsageRecord | undefined` and a
`harvest: boolean` flag. Return type becomes `{ candidates, skippedByBudget }`.

When `harvest === true`:

1. **Budget filter** (after existing tag/tools/context/state filters). A candidate is
   skipped — recorded in `skippedByBudget` — when it has known limits and at least one
   seeded dimension is exceeded by the projected request:
   - `rpd` seeded and `rpd - requests < 1`, or
   - `tpd` seeded and `tpd - (tokensIn + tokensOut) < estTokens`
2. **Within-group rotation.** Used fraction (`max` over the seeded dimensions of
   `requests/rpd` and `(tokensIn + tokensOut)/tpd`; a model with no seeded dimensions
   counts as 0) is inserted as the second sort key, immediately
   after the alias's primary key:
   - default aliases: tier → headroom asc → speed → id
   - `preferSpeed` aliases: speed → headroom asc → tier → id

When `harvest === false`: comparator and filters are byte-for-byte today's behavior
(guarded by a parity test).

## 5. Usage capture

- **Non-streaming**: server already parses the JSON body; read
  `usage.total_tokens` (fallback `prompt_tokens + completion_tokens`), else estimate
  input via `estimateTokens(body)`. Record exact request count.
- **Streaming**: no upstream request mutation (no injected `stream_options`). The SSE
  transform pipeline parses each `data:` frame as JSON and captures the totals when a
  chunk carries a top-level `usage` field (never substring-matched against content).
  On stream close — success, error, or client disconnect — if nothing was captured,
  record the input estimate instead. One record per served request, never double-counted.
- **Proactive local exhaustion**: after recording, if remaining rpd hits 0 or remaining
  tpd ≤ 0, set the model's `ModelState` to `exhausted` until UTC midnight (same shape a
  quota 429 produces), so both filter mechanisms agree and `status` shows it immediately.

## 6. Configuration

```jsonc
// ~/.freeroll/config.json
{
  "harvest": true,                    // default when absent; false restores v0 behavior
  "modelLimits": {                     // per-field overrides over registry seeds
    "google::gemini-2.5-pro": { "rpd": 100 }
  },
  "providerLimits": {                  // per-field overrides over provider pool seeds
    "openrouter": { "rpd": 1000 }      // e.g. after the $10 lifetime top-up
  }
}
```

No new environment variables. Overrides merge per-field (override `tpd` alone keeps
the seeded `rpd`).

## 7. Status CLI

`freeroll status` gains spend columns for models with known limits:

    req 12/50 · tok 84k/1M      (from live usage.json data)
    -                           (limits unknown)

## 8. Error surface

If all candidates are filtered out, the existing 503 path applies, now enriched with
`skippedByBudget` in the error body's `attempts` area, distinguishing "all quotas
spent today" from "no models matched this alias".

## 9. Edge cases

| Case | Behavior |
|---|---|
| Restart mid-day | Counters survive via usage.json |
| Corrupt usage.json | Empty map, fresh start |
| UTC rollover | Lazy check on access; 23:59:59 UTC request counts to that day |
| Estimate overshoot at 99% cap | Conservative skip; model idles until bigger need or rollover |
| Provider reports no usage | Input-token estimate used, documented approximation |
| Old config files | Missing keys default exactly as today |

## 10. Testing plan (vitest, offline)

1. `usage.ts`: record, lazy rollover, persist/load round-trip, corrupt-file recovery.
2. `resolve()`: budget filter drops near-dead models into `skippedByBudget`;
   within-tier rotation orders by headroom; tier priority preserved; preferSpeed
   hierarchy preserved with headroom inserted after speed.
3. **Parity test**: `harvest: false` output identical to pre-change ordering snapshot.
4. Capture paths: non-streaming usage field; streaming sniffed frame; stream-close
   fallback estimate; disconnect mid-stream.
5. Proactive exhaustion sets `exhausted` state visible to `status`.
6. Config merge semantics for `modelLimits`; `harvest: false` off-switch.
7. Status row rendering with mixed known/unknown limits.
