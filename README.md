# Maxout

<p align="center">
  <img src="docs/assets/logo.png" alt="Maxout logo" width="180" />
</p>

*No entry fee, real winnings — every free AI model, one endpoint.*

<p align="center">
  <img src="docs/assets/banner.png" alt="Maxout banner" width="100%" />
</p>

Maxout is a local OpenAI-compatible proxy that pools curated **free-tier AI
models** (OpenRouter, Groq, Google AI Studio, Mistral, Cerebras)
behind stable aliases. When one model hits its rate limit, your request
transparently fails over to the next-best free model.

## Quickstart

    git clone <this-repo>
    cd maxout
    npm install
    npm start

That's it — if no API keys are configured yet, the setup wizard launches
automatically before the server starts. It recommends a **single** provider
(Groq — fast signup, generous free tier), opens the key page, validates your
key with a live call, and stores it in `%USERPROFILE%\.maxout\.env`. When at
least one key is saved the server starts immediately; adding more providers
later is optional bonus capacity.

### Installed usage (recommended)

    npm install -g .          # or: npm link  (dev)
    maxout serve              # start server
    maxout status             # show quota
    maxout setup              # re-run wizard
    maxout trace <id>         # debug routing

No clone? The package is npx-ready:

    npx github:<owner>/maxout

Scripted equivalent (CI, dotfiles):

    maxout setup --provider groq --key gsk_...

Then point any OpenAI-compatible tool at the server:

    base URL: http://127.0.0.1:8787/v1
    API key:  anything (maxout does not check client keys)
    model:    auto/coding | auto/fast | auto/any

Prefer manual setup? Re-run `maxout setup` anytime, or set any subset of these
as environment variables (a `.env` in `~/.maxout/` is loaded):
`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`,
`CEREBRAS_API_KEY`.

> Warning: in PowerShell, plain `set NAME=value` does **not** create an
> environment variable — use `$env:NAME = value`.

## Aliases

| Alias | Meaning |
|---|---|
| auto/coding | best coding-capable free models (tier-ranked, tools required) |
| auto/fast   | fastest available models first |
| auto/any    | everything, quality-ranked |

Define custom aliases in `~/.maxout/config.json`:

    { "aliases": { "auto/long": { "tags": ["long-context"], "requireTools": false } } }

## Configuration

Keys are read from environment variables (a `.env` in `~/.maxout/` is loaded):
`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`,
`GITHUB_TOKEN`, `CEREBRAS_API_KEY`. Providers without keys are skipped.
(`GITHUB_TOKEN` is accepted but inert: GitHub Models was retired in July 2026 — see docs/registry-notes.md.)
Port/host are configurable in `~/.maxout/config.json`, along with quota-harvest
settings (`harvest`, `modelLimits`, `providerLimits` — see "Quota harvest" below).

## Status

    maxout status

Shows every model with its current limit state (`ok`, `cooldown Xm`,
`exhausted until <UTC reset>`).

Pooled providers appear once as a `[pool] …` line shared by their models;
per-model rows carry reason codes (`cooldown 3m (peak-throttle)`,
`exhausted (pool) until …`, `retired since …`). Clear stuck state with
`maxout revive <model-id>` (or a bare provider name to unblock a pool).

## Transparency

Every response carries the actual serving model in its `model` field and the
`x-maxout-served-by` header. Failover happens only before the first streamed
byte; mid-stream failures surface as a `maxout_error` SSE frame.

- **Routing you can audit** — every request gets an id (`x-maxout-request-id`); `maxout trace <id>` shows the full candidate list, each skip reason, and why the winner won. Last 500 requests kept locally; prompts and responses are never recorded.
- **Live trace** — run `maxout serve --trace` to stream one-line routing decisions to stderr while serving.

### Seeing which model answered

By default Maxout appends a credit line to every text reply so you can see
which model actually served your request:

```
<normal reply>

---
*maxout: groq::openai/gpt-oss-120b*
```

Disable it by setting `"annotateResponses": false` in `~/.maxout/config.json`.

## Tool-call validation

For tool-carrying requests Maxout validates tool-call payloads before your
agent sees them: broken or truncated calls fail over silently before the first
byte (non-streaming), or surface as a `{"maxout_error":"malformed_tool_call"}`
SSE frame at stream end. Every rejection is logged locally as a reason code
(`~/.maxout/malformed.jsonl`) — never the response content.

## Reliability

Maxout tracks how each model actually behaves for you (validation results,
truncations, latency) in a rolling local window and demotes proven-flaky
models beneath their static tier. See the numbers:

    maxout status --reliability

Share an anonymized snapshot (model ids, rates, sample counts — nothing else)
when asked:

    maxout export-stats --out maxout-stats.json

## Quota harvest

Maxout tracks how much of each model's free-tier daily allowance you have spent
(today, UTC) and uses it in routing:

- same-tier candidates are tried least-used first, so no single model burns out by noon;
- models whose remaining daily budget cannot fit your request are skipped without a wasted call;
- provider-wide pools (e.g. OpenRouter's account-level 50 free requests/day) are respected across all their models;
- a model that hits its cap is parked until the UTC reset, exactly like a 429 would.

Spend shows up in `maxout status` (`req 12/50 · tok 84k/1M` per model, plus
`pool 3/1000` for provider-wide pools). Caps come from
curated seeds in `registry.json`/`providers.json`; override or extend them per
model or provider in `~/.maxout/config.json`:

    { "harvest": false,                       // revert to v0 routing entirely
      "modelLimits":   { "google::gemini-2.5-pro": { "rpd": 100 } },
      "providerLimits": { "openrouter": { "rpd": 1000 } } }

Token counts use provider-reported usage when available and an input-size
estimate otherwise.

- **Opt-in paid fallback** — set `hybrid.enabled` in `~/.maxout/config.json` with a hard `dailyCapUSD`; free and local capacity is always used first, spend is tracked locally, and the cap holds across restarts.

## Local-first & privacy

Maxout is deliberately boring about your data:

- Your API keys live only in your environment (or `%USERPROFILE%\.maxout\.env`)
  and go directly to the provider you called. Maxout has no telemetry, no
  phoning home, and no third party in the middle — requests leave your machine
  straight for OpenRouter/Groq/Google/Mistral/Cerebras.
- Prompt and response bodies are never written to disk. What IS stored locally
  under `%USERPROFILE%\.maxout\`: daily spend counters (`usage.json`), model
  health states (`state.json`), quality outcomes as numbers (`reliability.json`),
  rejection reason codes (`malformed.jsonl`), and console lines naming which
  model answered.
- `maxout export-stats` is the ONLY feature that produces shareable data. It
  runs solely when you invoke it and emits an allowlisted, anonymized summary
  (see above). Nothing is sent anywhere unless you send it.

## Development

    npm test          # vitest, fully offline (upstreams mocked)
    npm run build     # strict TypeScript -> dist/
