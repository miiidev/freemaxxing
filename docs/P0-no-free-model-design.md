# P0 — Fix "no free model available" (`all_models_exhausted`)

**Problem:** Users see `503 all_models_exhausted` even when models are available. Three root causes exist in the current code, requiring different fixes.

**Grounded in:** `src/server.ts` (503 handler), `src/executor.ts` (execute()), `src/router.ts` (resolve()), `src/state.ts` (state tracking), `src/providers.json`, `src/registry.json`.

## Cause 1 — OpenRouter's shared 50 req/day pool is a single point of failure

- `registry.json` has 12 of 24 entries under `provider: "openrouter"`.
- `providers.json` caps the whole provider at `rpd: 50` — shared across all 12 models.
- `executor.ts::markQuota()` sets **both** the model *and* `pool::openrouter` to `exhausted` (until UTC midnight) the instant that shared budget is spent.
- `router.ts::resolve()`'s `stateOk` filter checks `getProviderState`, so all 12 OpenRouter entries disappear from every alias simultaneously for the rest of the day.
- 50 requests/day is minimal for an agent harness doing many small tool-calling turns.

**Fix direction:** Add pacing so the 50/day budget isn't burned in the first few minutes of a session, and/or add a startup warning that "52% of your configured models share one 50 req/day pool."

## Cause 2 — Default setup path produces a thin pool

- `setup.ts` recommends and stops at **one** provider (Groq).
- With only Groq configured, `auto/coding` has exactly 3 servable candidates (`gpt-oss-120b`, `gpt-oss-20b`, `qwen3.6-27b`), all behind one provider pool.
- Three candidates is a small safety margin relative to what the README's "pools everything" pitch implies.

**Fix direction:** Nudge harder in the wizard/first-run output toward a second key ("bonus capacity" currently framed as fully optional — consider making it feel more consequential), or surface a warning in `maxout status` / first `serve` startup when the active candidate count for `auto/coding` is below some threshold (e.g. < 5).

## Cause 3 — Malformed tool-call failures don't change model state, so they can cascade

- In `executor.ts`, when `inspect()` finds a broken tool call: `attempts.push(...); continue` — **no state change is applied.** The model stays `"ok"` and is retried on the very next request.
- This is fine for a one-off blip, but a free model that's just structurally bad at tool-calling gets retried on **every single request** until it accumulates `minSamples: 10` in the reliability window (`reliability.ts`) before demotion kicks in.
- If a request's candidate list happens to be mostly weak-tool-calling free models, you can exhaust the entire candidate list on `malformed` verdicts alone — zero rate-limiting involved, but the same 503/`all_models_exhausted` message fires, making it indistinguishable from real capacity exhaustion without reading `attempts`.

**Fix direction (highest leverage single fix):** Apply a short cooldown state (e.g. via `setState()` in `state.ts`, similar to the `rate` failure path) on a `malformed` verdict, rather than waiting on the 10-sample reliability window. This stops one flaky model from being retried on every request in the interim.

## Supporting fix — distinguish error causes in the 503 body

`all_models_exhausted` currently reads as pure capacity exhaustion regardless of which of the three causes above is actually responsible. Add a coarse classification to the error response (e.g. `mostly_rate_limited` / `mostly_malformed` / `mostly_no_key`) derived from the `attempts` reasons, so both `maxout trace` and any client-side logic can tell the difference immediately instead of parsing the `attempts` array by hand.

## Suggested sequencing

1. **Instrument first** — capture `attempts` from a real 503, or run `maxout trace <id>`, to confirm which of the three causes is actually firing.
2. **Ship the malformed-cascade cooldown fix** — cheapest, highest-leverage fix for the specific OpenCode pain reported.
3. **Add OpenRouter pool warning + basic daily pacing** — directly blunts the most common failure mode.
4. **Clean up the `github` ghost provider and key-presence filtering** — small, mechanical, improves signal quality for future debugging.

---