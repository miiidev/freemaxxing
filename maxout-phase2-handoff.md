# Freeroll — Phase 2 Feature Handoff (Resilience & Quality)

**Context:** This is a follow-on to `freeroll-next-level-handoff.md` (phase 1: cross-provider pool-exhaustion fix, failure-taxonomy-aware routing, agent-aware tool-call validation, reliability-scored ranking, opt-in reliability leaderboard, local-first positioning, onboarding wizard). Phase 2 assumes phase 1's failure-taxonomy classes and reliability scoring already exist and builds directly on top of them — several items below reuse that vocabulary rather than reinventing it.

**Framing:** Phase 1 was about not wasting the free capacity you already have and not shipping bad output. Phase 2 is about closing the two remaining gaps: users still hit a hard wall when free quota runs out, and the routing logic — while smarter now — is still a bit of a black box and doesn't yet account for context size or session consistency.

---

## Priority order and rationale

1. **Local-model fallback tier** — the single biggest resilience upgrade: turns "sometimes blocked" into "never blocked."
2. **Context-window-aware routing** — fixes a failure mode currently indistinguishable from "the model is just bad."
3. **Session-sticky routing** — cheap to build, meaningful perceived-quality win.
4. **Quota burn-rate forecasting** — turns reactive status into proactive planning.
5. **Opt-in hybrid mode with a hard spend cap** — the bounded middle ground between "free-only" and "unpredictable paid."
6. **Exportable routing decision logs** — trust/debuggability layer once the above logic is nontrivial enough to need one.

**Acknowledged but not planned this phase:** editor status surface (VS Code extension or similar) — see note at the end.

---

## 1. Local-model fallback tier

**Problem:** Once every cloud provider's free quota is exhausted for the day, the user is simply blocked until the next UTC reset.

**Design:**
- New provider type `local`, supporting an OpenAI-compatible local endpoint (Ollama by default at `http://localhost:11434`, or a manually configured llama.cpp server URL).
- Config addition in `~/.freeroll/config.json`:
  ```json
  { "local": { "enabled": false, "endpoint": "http://localhost:11434", "model": "qwen2.5-coder:7b" } }
  ```
- On startup, freeroll probes the local endpoint. If unreachable or `enabled` is false, the local tier is silently absent from routing candidates — no error, no noise for users who haven't set one up.
- Routing rule: the local tier is only entered once **every** cloud candidate for the alias is in a non-OK state (`PoolExhausted` / `ModelCooldown` / `ModelRetired` from phase 1's taxonomy). It is never preferred over any available cloud model, regardless of local latency.
- `freeroll status` shows it explicitly: `local (ollama) — qwen2.5-coder:7b — available` or `local — not configured`.

**Acceptance criteria:**
- With all cloud providers simulated as exhausted, a request successfully routes to the local tier.
- With no local server running and local fallback unconfigured, behavior is unchanged from today (existing "retry at reset" error) — no crash, no hang.
- The phase-1 onboarding wizard (`freeroll setup`) gains an optional "configure local fallback" step, skippable.

---

## 2. Context-window-aware routing

**Problem:** Free/quantized models frequently have smaller context windows than their paid siblings. Routing a large request (e.g., an agent handing over a big diff with lots of file context) to a small-context model causes silent truncation — which looks exactly like a quality problem but is actually a capacity mismatch the router could have avoided.

**Design:**
- Extend each model entry in `registry.json` with `contextWindow` (max input tokens) and `maxOutput` (max output tokens), sourced from provider docs at registry-build time.
- Before routing, estimate the request's token count (reuse existing estimation logic if present; a char/4 heuristic is acceptable for v1) and exclude candidates whose `contextWindow` can't fit the estimated input plus reasonable output headroom.
- If no remaining candidate fits, don't hard-fail — widen back to the full candidate list and log a warning. A slower or lower-tier response that isn't truncated beats an error.
- Acceptance criteria:
  - A simulated large-context request (e.g., ~50k input tokens) excludes small-context free models from the candidate list.
  - Model context/output limits are visible via `freeroll status` (new column or `--verbose` flag).

---

## 3. Session-sticky routing

**Problem:** Per-request load balancing means a single multi-turn agent task can bounce across three different models, producing inconsistent code style and models occasionally contradicting decisions made two turns earlier by a different model.

**Design:**
- Derive a session key per conversation (hash of the first N messages, or an explicit session header if the calling agent supports passing one).
- Once a model is selected for a session, subsequent requests in that session prefer the same model unless it drops into a non-OK state, at which point failover happens and the *new* model becomes sticky for the remainder of the session.
- Config: `sessionAffinity: true` by default for `auto/coding` (consistency matters most here); optional/off by default for `auto/fast`.

**Acceptance criteria:**
- A simulated multi-turn session against a healthy model routes 100% of its requests to that one model.
- Forcing the sticky model into cooldown mid-session triggers failover, and the newly selected model persists for the rest of that session.

---

## 4. Quota burn-rate forecasting

**Problem:** `freeroll status` currently reports usage reactively (`12/50 used`). Nothing warns the user before they hit a wall mid-task.

**Design:**
- Extend harvest's per-model tracking to retain request timestamps for a bounded recent window (not just running totals), so a burn rate can be computed without unbounded storage growth.
- Compute a simple linear extrapolation from today's request rate to project an exhaustion time per pool.
- Surface in `freeroll status`: `openrouter pool: 32/50 used · projected exhaustion ~15:40 UTC at current pace`.
- If there's too little data today to extrapolate meaningfully, show "insufficient data" rather than a misleading estimate.

**Acceptance criteria:**
- Given a fixture request history, the projected exhaustion time matches manual linear extrapolation within a reasonable tolerance.
- Forecast is suppressed (not guessed) below a minimum sample threshold.

---

## 5. Opt-in hybrid mode with a hard spend cap

**Problem:** Once free (and local, per #1) capacity is genuinely gone, today's only option is to wait. Some users would rather pay a small, predictable amount to keep working.

**Design:**
- New config block, off by default:
  ```json
  { "hybrid": { "enabled": false, "dailyCapUSD": 2.00, "provider": "openrouter" } }
  ```
- When every free and local candidate is exhausted, hybrid mode is enabled, and today's tracked paid spend is under `dailyCapUSD`, route to a paid model on the configured provider.
- Track actual spend (via provider-reported cost, or token count × published price) into the same UTC-daily ledger pattern used by harvest.
- Hard stop at the cap: no further paid routing for the rest of the day once reached — spend-based, not request-based, so it doesn't reset early just because free pools reset at midnight alongside it.
- `freeroll status` shows `hybrid: $0.42 / $2.00 spent today` when enabled.

**Acceptance criteria:**
- With hybrid disabled (the default), exhaustion behavior is byte-for-byte unchanged from today — the system never spends money without explicit, visible opt-in.
- Simulated spend reaching the cap blocks further paid routing for the remainder of the day, verified independently of free-pool reset timing.

---

## 6. Exportable routing decision logs

**Problem:** Once failure-taxonomy routing (phase 1), reliability scoring (phase 1), context-awareness (#2), and session affinity (#3) are all influencing a routing decision, it stops being obvious to a user *why* a given request went where it went. For a technical audience, an opaque router undermines trust in the reliability claims it's making.

**Design:**
- New command `freeroll trace <request-id>` (and/or a `--trace` flag on `serve` for continuous logging) outputting: the full candidate list considered, the skip reason for each excluded candidate (reusing phase 1's taxonomy plus `ContextTooSmall` from #2), and the reason the selected model won (reliability score, static tier, session affinity, etc.).
- Human-readable by default; `--json` flag for machine-readable output.
- Bounded local retention (e.g., last 500 requests), not unbounded log growth.
- No prompt or response content in the trace by default — routing metadata only, consistent with the privacy stance already established for phase 1's `export-stats`.

**Acceptance criteria:**
- Trace output for a constructed test scenario matches the actual routing decision, including every skip reason in the correct taxonomy.
- Confirmed no prompt/response content appears in trace output under any default configuration.

---

## Acknowledged, not planned this phase

**Editor status surface (VS Code extension or similar).** Surfacing current model, quota, and reliability data inline in the editor instead of via CLI is a real friction reducer, but it's a distinct UI surface with its own build and maintenance overhead — extension packaging, marketplace listing, editor API churn — separate from the core proxy's feature set. Worth revisiting once phases 1–2 are stable and there's a concrete signal that CLI-only status checking is actually blocking adoption, rather than committing engineering time to it now.

---

## Sequencing note

Items 2 and 6 directly consume phase 1's failure-taxonomy and reliability-scoring output — land those phase 1 pieces first, or #6's "why selected" trace output will have nothing meaningful to report.
