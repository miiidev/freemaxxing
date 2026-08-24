# Freeroll — Next-Level Feature Handoff

**Context for whoever picks this up:** freeroll is a local OpenAI-compatible proxy that pools free-tier AI models (OpenRouter, Groq, Google AI Studio, Mistral, Cerebras) behind stable aliases (`auto/coding`, `auto/fast`, `auto/any`), with request/token quota tracking (`harvest`) and failover across providers.

**Strategic framing:** OpenRouter now ships its own `openrouter/free` auto-router, which commoditizes "route me to a free model." Freeroll's differentiation has to live in things OpenRouter structurally cannot or will not build: pooling free quota *across* providers (not just within OpenRouter's own account-level bucket), and being aware that the caller is a coding agent, not a generic chat client. Everything below is ordered by how defensible it is, not just how easy it is to build.

---

## Priority order and rationale

1. **Verify/fix cross-provider pool semantics** — this is the core moat; if it's subtly wrong, nothing else matters.
2. **Failure-taxonomy-aware routing** — turns "retry on any error" into "react correctly to *why* it failed."
3. **Agent-aware tool-call validation** — the one thing a generic LLM gateway will never build.
4. **Reliability-scored model ranking** — replaces a hand-curated tier list with a self-healing one.
5. **Public reliability data / leaderboard** — turns telemetry you already have into distribution.
6. **Local-first/privacy positioning** — pure messaging, ships independently of code work.
7. **Onboarding wizard** — real friction reducer, but polish, not differentiation. Do last.

---

## 1. Verify/fix cross-provider pool semantics

**Problem:** OpenRouter's `:free` rate limit (20 req/min, 50/day unfunded or 1,000/day after a one-time $10+ credit purchase) is **account-wide**, not per-model. Hitting the cap on one OpenRouter free model means every other OpenRouter free model is also dead until the daily reset — failing over to a different OpenRouter model does nothing.

**Current state:** `registry.json`/`providers.json` already models OpenRouter as a provider-wide pool per the README (`providerLimits: { "openrouter": { "rpd": 1000 } }`). Needs a code-level audit, not a design change.

**Required behavior:**
- When a request fails or is skipped because the OpenRouter pool is exhausted, the router must mark **all** `openrouter::*` candidates as unavailable until the pool's UTC reset — not just demote the one model that 429'd.
- `freeroll status` should surface this clearly: e.g. a single `pool 50/50 · reset 00:00 UTC` line for OpenRouter, rather than implying each OpenRouter model has independent headroom.
- Failover on OpenRouter-pool-exhaustion must skip straight to the next **provider** (Groq, Gemini, Mistral, Cerebras) in the alias's candidate list, not iterate through remaining OpenRouter models first (wasted latency).

**Acceptance criteria:**
- Unit test: simulate OpenRouter pool exhaustion after N requests; assert next request routes to a non-OpenRouter provider without attempting any other `openrouter::*` model first.
- `freeroll status` output visually distinguishes provider-wide pools from independent per-model limits.

---

## 2. Failure-taxonomy-aware routing

**Problem:** Not all failures mean the same thing, and reacting to them identically wastes quota and time.

**Define failure classes:**

| Class | Signal | Correct reaction |
|---|---|---|
| `PoolExhausted` | 429 + provider-wide pool cap hit | Mark whole provider dead until reset; skip to next provider |
| `ModelCooldown` | 429 scoped to one model/provider-side throttling during peak | Park just that model until backoff window; try next candidate |
| `ModelRetired` | 404 / model ID no longer resolves | Demote model permanently (or until a registry refresh confirms it's back); log for registry maintenance |
| `TransientError` | 5xx, timeout, connection reset | Retry same model once with short backoff before failing over |
| `MalformedOutput` | Response parses as 200 but tool-call JSON is invalid, truncated, or `finish_reason` indicates a cutoff | **Not a networking failure** — treat as a quality signal (feeds into #4), and only fail over if this happens before the first streamed byte has committed, consistent with existing failover-boundary behavior described in the README |

**Data model additions:** each model's state needs a reason code alongside `ok` / `cooldown Xm` / `exhausted until <reset>` — e.g. `cooldown (peak-throttle)` vs `exhausted (pool)` vs `retired`.

**Acceptance criteria:**
- `freeroll status` shows the reason, not just the state.
- Integration test per failure class confirming the router takes the differentiated action described above.

---

## 3. Agent-aware tool-call validation

**Problem:** Free/quantized models under load are more prone to truncating mid-diff or emitting malformed tool-call JSON. A generic proxy just forwards whatever comes back; an agent-aware proxy can catch garbage before it reaches the coding agent and corrupts a file or stalls the loop.

**Design:**
- Before returning a response for `auto/coding` (and any alias with `requireTools: true`), validate the tool-call block(s): JSON parses, required fields per the schema the agent requested are present and non-empty, and the response wasn't truncated (check `finish_reason`/`stop_reason` for `length` or equivalent cutoff signals).
- If validation fails **before the first streamed byte has been sent to the client** (consistent with the existing failover boundary), treat it as a `MalformedOutput` failure and fail over silently to the next candidate — the agent never sees the broken response.
- If it fails **mid-stream** (can't fail over per existing design), surface it via the existing `freeroll_error` SSE frame rather than letting a corrupted tool call hit the agent as if it were valid.
- Log every malformed-output event per model — this is the raw data feeding #4.

**Acceptance criteria:**
- Fixture set of known-bad model outputs (truncated JSON, missing required arg, empty diff) run through the validator; all correctly rejected before reaching the client on non-streamed responses.
- No false positives against a corpus of valid tool-call responses from at least 3 different providers' formats.

---

## 4. Reliability-scored model ranking (self-healing registry)

**Problem:** `registry.json` is hand-curated and will always drift as providers rotate free models in and out without notice. A static tier list can't reflect that a model that was reliable last week is flaky this week.

**Design:**
- Maintain a rolling window (e.g. last 200 requests or last 7 days, whichever is smaller) per model tracking: tool-call parse success rate (from #3's validator), truncation rate, and average latency.
- Store locally, e.g. `~/.freeroll/reliability.json`, keyed by model ID.
- `auto/coding`/`auto/fast`/`auto/any` candidate ordering incorporates this score alongside the existing static tier rank — e.g. static tier breaks ties, but a model with a reliability score below some threshold (configurable) gets demoted below its static tier regardless.
- Models with too few samples in the window fall back to static tier ranking (don't penalize a model just because it's new to the window).

**Config surface:**
```json
{ "reliability": { "windowSize": 200, "minSamples": 10, "demoteBelow": 0.85 } }
```

**Acceptance criteria:**
- `freeroll status --reliability` (new flag) shows per-model success rate and sample count.
- A model artificially forced to fail validation repeatedly in a test run visibly drops below a higher-static-tier model within the configured window.

---

## 5. Public reliability data / leaderboard

**Problem:** Most "best free model for coding" content online is a stale blog post guessing at a rotating landscape. Freeroll users are already generating real telemetry (#4) that's more accurate than any of it.

**Design (opt-in, privacy-respecting):**
- New command, e.g. `freeroll export-stats`, that dumps an anonymized snapshot of `~/.freeroll/reliability.json` (model IDs, success rates, sample counts — no prompts, no code content, no API keys) to a shareable file or, longer-term, an opt-in aggregation endpoint.
- This must be explicitly opt-in and clearly documented as such — do not default to phoning home. Freeroll's positioning (see #6) depends on being trustworthy about what leaves the machine.
- If/when aggregate data exists across users, a simple static page or regenerated markdown table ("state of free coding models," last updated timestamp) becomes shareable content that draws in exactly the audience searching for this.

**Acceptance criteria:**
- `export-stats` output contains no prompt content, file paths, or key material — verify with a test that feeds known-sensitive strings into the pipeline and confirms they don't appear in the export.
- Feature is fully inert unless explicitly invoked.

---

## 6. Local-first / privacy positioning

**Not a code task — a docs/README task.** Freeroll's architecture already means requests go directly from the user's machine to each provider, with no third party in the middle beyond the providers themselves. This is currently undersold — the README frames freeroll purely as a cost play.

**Action:** Add an explicit section (README + docs site if one exists) stating plainly: your keys stay on your machine, your code/prompts go only to the provider you're calling, freeroll itself doesn't see or log request content beyond what's needed for routing and quota tracking. Pair this with #5's opt-in framing so the privacy claim and the telemetry feature don't contradict each other.

**Acceptance criteria:** README update reviewed for accuracy against actual code behavior (i.e., don't claim something the code doesn't do — audit `harvest`/logging paths first).

---

## 7. Onboarding wizard

**Problem:** Current setup requires manually creating a `.env` and knowing which env var name maps to which provider. Real friction, but not differentiation — do this after 1–5.

**Design:**
- New command, e.g. `freeroll setup`, interactive:
  - Recommends starting with a single easiest provider (Groq: fast signup, generous free tier) rather than presenting all five as equally required.
  - Opens the relevant signup page, waits for the user to paste a key, validates it with a lightweight test call, writes it to `~/.freeroll/.env`.
  - Offers to add additional providers as "bonus capacity" afterward, framed as optional.
- Update Quickstart in README to lead with `freeroll setup` instead of manual env var instructions.

**Acceptance criteria:**
- A user with zero existing keys can go from `npm install` to a working `auto/coding` request using only `freeroll setup` and one provider signup.

---

## Out of scope for this phase

- Hosted/shared key pooling across users — not viable; providers rate-limit per account, not per app, and it likely violates most providers' ToS.
- Prompt-based tool-calling harness for chat-only (non-tool-native) models — adds a reliability tax on top of already-weaker free models; revisit only if #3/#4 show native-tool-calling free models are running out.
