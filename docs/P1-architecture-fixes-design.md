# P1 — Near-term architecture fixes

## 1. Fix the `github` provider ghost entry

`providers.json` and `config.ts::DEFAULT_ENV_KEYS` still fully define a `github` provider (real `baseURL`, env var mapping), but `registry.json` has **zero** entries with `provider: "github"`. A user who sets `GITHUB_TOKEN` gets counted in `activeProviders()` and shows up in "N/6 providers have keys" — while contributing exactly zero usable models. This is a real trap for new users.

**Options:**
- Strip `github` from `providers.json` / `DEFAULT_ENV_KEYS` entirely, or
- Make the "N/6" denominator in `cli.ts` reflect only providers with actual registry coverage.

## 2. Filter by key-presence inside `resolve()`, not just in `execute()`

`router.ts::resolve()` currently ranks and returns candidates for providers with no configured key at all; `execute()` then wastes a loop iteration logging `no-key` before moving on. Low cost, but it pollutes `attempts` / trace output with noise that isn't a real failure signal — making the P0 diagnosis harder for everyone downstream.

**Fix:** Pass `hasKey` into `RequestCtx` and filter in `resolve()` so the candidate list only ever describes genuinely servable models.

## 3. Reduce serialized tail latency on outages

In `executor.ts`, an `outage` classification does a full `doSleep(backoffMs)` + same-model retry **before** moving to the next candidate, and each attempt carries a 30s `DEFAULT_TTFB_MS`. If two or three candidates in a row are having a bad moment, that's potentially 60–90+ seconds of serialized waiting before success or exhaustion — which for an interactive coding agent reads as "hung," not "rotated."

Since failover is already contractually pre-first-byte, consider either:
- Racing the top 2–3 candidates concurrently and taking the first successful TTFB, or
- Cutting the per-attempt timeout meaningfully shorter specifically for the retry pass.

## 4. Proactive quota pacing, not just reactive skip

`router.ts`'s `headroom`/`usedFraction` sort already spreads load *within* a request ("least-used first"), but there's no **daily** pacing — nothing stops the OpenRouter 50 req/day pool (see P0 Cause 1) from being spent in the first five minutes if that's when the agent bursts.

A soft pacing layer — e.g. reserve some fraction of remaining daily budget once N hours into the UTC day have elapsed — would directly blunt the most common failure mode described in P0 Cause 1.

---