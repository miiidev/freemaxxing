# P2 — Bigger architecture ideas (differentiation, not just bug fixes)

## 1. Mid-stream failover

Currently: failover only happens pre-first-byte; a stream dying mid-response surfaces as a single `freemaxxing_error` SSE frame (`server.ts`, `sse.ts`) and the client has to handle it. For an agent harness mid-tool-call, this is exactly the kind of jank that breaks "smooth af."

**Harder but more differentiating version:** detect a dead stream, silently retry against the next candidate, and either restart the response cleanly or splice in a note that generation continued on a different model. Most lightweight proxies punt on this because resuming generation across models is genuinely tricky — which is exactly why doing it well would stand out.

## 2. Local model as a zero-rate-limit floor

All current providers are cloud free-tiers with real caps. A local model via Ollama/llama.cpp as an opt-in bottom-of-pool tier — "if literally everything else is cooling down, fall back to a small local model instead of erroring" — would solve the P0 failure mode at the architecture level instead of only patching around it, and is a real differentiator vs. pure-cloud aggregators.

## 3. Make reliability scoring a first-class routing input, not just a report

`reliability.ts` already tracks truncations/latency/validation failures and can demote flaky models — but it's currently gated behind `freemaxxing status --reliability` as an opt-in view rather than always shaping default routing (it *is* wired into `router.ts`'s sort via `demoted()`, but the visibility/reporting side is separate from the routing side in a way that's worth tightening — see the malformed-cascade issue in P0 Cause 3 for a concrete case where this matters).

## 4. Provider adapters as a plugin surface

Free-tier terms shift constantly (GitHub Models retiring is already handled as a special case in `setup.ts`/`providers.json` comments). Hardcoding providers means every provider change is a core code change. A small adapter interface — drop a JSON/TS descriptor for a new provider (auth shape, endpoint, rate-limit headers, model list) — would let the project survive provider churn and let contributors add providers without touching `catalog.ts`/`quirks/` internals.

## 5. Minimal local dashboard over the CLI

`freemaxxing status` / `freemaxxing trace` are good, but a tiny local web view (quota bars, cooldown timers, live trace feed) would make debugging visual instead of CLI-output-parsing — lowering the barrier for less CLI-comfortable users and widening who the project is useful to. Doesn't need to be fancy — even a static HTML page hitting a local `/debug` endpoint would help.

## 6. Optional model pinning (opt-in, not default)

Doesn't conflict with the "stable alias, don't make me think about it" pitch as long as it stays opt-in:

- **Direct addressing escape hatch:** `model: "groq::openai/gpt-oss-120b"` bypasses the alias resolver, hits that one model, still respects quota-harvest/cooldown state (fail clearly if it's cold rather than silently rerouting — pinning is an explicit choice).

- **"Preferred, then fallback" hybrid:** something like `auto/coding:prefer=groq::llama-3.3-70b` — try the preferred model first, fall through to normal auto-rotation only if unavailable. Probably the best UX for power users: your favorite model when it's up, resilience when it's not.

Keep this out of the quickstart/wizard — document as an advanced feature layered on top of the alias system.

---