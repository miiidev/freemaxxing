Maxout is a local OpenAI-compatible proxy that pools curated **free-tier AI
models** (OpenRouter, Groq, Google AI Studio, Mistral, Cerebras, **and local
LLMs via Ollama/llama.cpp**) behind stable aliases. When one model hits its rate
limit, your request transparently fails over to the next-best free model (or
local model if configured).

*No entry fee, real winnings — every free AI model, one endpoint.*

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

You can also configure a **local LLM** (Ollama/llama.cpp) as a no-rate-limit
fallback — see "Local LLM Support" below.

No clone? The package is npx-ready:

    npx github:<owner>/maxout

Scripted equivalent (CI, dotfiles):

    npx . setup --provider groq --key gsk_...

Then point any OpenAI-compatible tool at the server:

    base URL: http://127.0.0.1:8787/v1
    API key:  anything (maxout does not check client keys)
    model:    auto/coding | auto/fast | auto/any

Prefer manual setup? Re-run `maxout setup` anytime, or set any subset of these
as environment variables (a `.env` in `~/.maxout/` is loaded):
`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`,
`CEREBRAS_API_KEY`, `LOCAL_API_KEY`.

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
`CEREBRAS_API_KEY`, `LOCAL_API_KEY`. Providers without keys are skipped.
(`GITHUB_TOKEN` is accepted but inert: GitHub Models was retired in July 2026 — see docs/registry-notes.md.)
Port/host are configurable in `~/.maxout/config.json`, along with quota-harvest
settings (`harvest`, `modelLimits`, `providerLimits` — see "Quota harvest" below).

## Status

    npx . status

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

    npx . status --reliability

Share an anonymized snapshot (model ids, rates, sample counts — nothing else)
when asked:

    npx . export-stats --out maxout-stats.json

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

## Local LLM Support

Maxout can route requests to a **local LLM** running via [Ollama](https://ollama.ai/)
or [llama.cpp], configured to listen on `http://localhost:11434` by default.

### Setup

1. **Install Ollama** (or [llama.cpp](https://github.com/ggerardym/llama.cpp)) and pull a model:
   ```bash
   # Ollama
   ollama pull llama3.2:latest
   
   # Or with llama.cpp
   # ...start a server pointing at a .gguf model
   ```

2. **Run the maxout setup wizard** and select **local** as a provider:
   ```bash
   maxout setup
   # → Select "local" from the provider list [1-6]
   # → Skip the API key prompt (local mode)
   # → Config saved to `~/.maxout/.env`
   ```

   Or run non-interactively:
   ```bash
   maxout setup --provider local --key local
   ```

3. **Verify the local provider is active**:
   ```bash
   maxout status
   # → You should see `[pool] local    req 0/1000000 · ok · resets 00:00 UTC`
   ```

### Usage

Use the `local::model-name` format as your model identifier:

```bash
# Via API or SDK:
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dummy-key-for-maxout" \
  -d '{"model": "local::llama3.2:latest", "messages": [{"role": "user", "content": "Hello"}]}'

# Via maxout CLI:
maxout serve
# Then:
echo "Hello" | maxout chat --model local::llama3.2:latest
```

Or use aliases like `auto/any` — if the local provider is active, its models
will appear in the candidate pool.

### How It Works

- The `local` provider in `providers.json` points at `http://localhost:11434` (the
  default Ollama address)
- Requests are forwarded to the local `/chat/completions` endpoint
- No API key is sent to the local endpoint (maxout skips auth for local)
- Rate limits are set to very high values (`rpd: 1M, tpd: 1M`) so local models
  never cause "exhausted" errors
- Local models appear in the candidate pool alongside cloud free-tier models
- The daily pacing (P0.3) also applies: after 4hrs UTC, local models get a sort
  penalty, so they're used as a last-resort fallback rather than primary models

### Tips

- **Best use case**: "If all cloud free-tier models are exhausted/cooling down,
  finish my request with a local model instead of erroring."
- **Not recommended as primary**: Local models don't have the same quality/consistency
  guarantees as cloud free tiers, and they count against no rate limit — use them
  as a fallthrough, not your everyday model.
- To **disable** local support, just remove the `local` entry from
  `~/.maxout/.env` and re-run `maxout serve`.

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

## Integration with AI Coding Assistants

Maxout can serve as a proxy for free-tier AI models, enabling various AI tools to access curated pools of free models. Here's how to integrate maxout with popular AI coding assistants:

### opencode

Setup maxout as an OpenAI-compatible provider for opencode:

```bash
# From maxout project directory
cd maxout
npm start          # Start maxout server on http://127.0.0.1:8787/v1
```

In your global opencode config (`~/.config/opencode/opencode.json` or `~/.config/opencode/opencode.jsonc`), add the provider:

```json
{
  "provider": {
    "maxout": {
      "name": "Maxout",
      "api": "openai",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "sk-noop"
      },
      "models": {
        "auto/coding": { "name": "Maxout: best free coding model", "tool_call": true },
        "auto/fast": { "name": "Maxout: fastest free model", "tool_call": true },
        "auto/any": { "name": "Maxout: any free model", "tool_call": true }
      }
    }
  },
  "model": "maxout/auto/coding"
}
```

**Notes:**
- maxout doesn't require client API keys (use a dummy key)
- `auto/coding` is optimized for coding tasks with tool support
- `auto/fast` prioritizes speed over intelligence
- `auto/any` includes all available free models

### Other OpenAI-Compatible Tools

Any tool that speaks OpenAI's API can use maxout by pointing it to the local proxy:

#### General Configuration

    base URL: http://127.0.0.1:8787/v1
    API key: anything (maxout does not check client keys)
    model: auto/coding | auto/fast | auto/any

#### Examples

**Cursor**
```json
{
  "name": "Maxout Proxy",
  "endpoint": "http://127.0.0.1:8787/v1",
  "apiKey": "dummy-key-for-maxout",
  "model": "maxout/auto/coding"
}
```

**Cline**
- Set `API_ENDPOINT` to `http://127.0.0.1:8787/v1`
- Set `API_KEY` to `dummy-key-for-maxout`
- Set `MODEL` to `maxout/auto/coding`

**RooCode**
- OpenAI-compatible endpoint: `http://127.0.0.1:8787/v1`
- Use any model name (maxout handles aliasing internally)

**Claude Code**
- Configure to use OpenAI-compatible endpoint
- Base URL: `http://127.0.0.1:8787/v1`
- Model: `maxout/auto/coding`

**Continue**
- Set `openAiHost` to `http://127.0.0.1:8787/v1`
- Any OpenAI-compatible model name works (e.g., `maxout/auto/coding`)

**OpenHands**
```yaml
ai:
  provider: "openai"
  model: "maxout/auto/coding"
  endpoint: "http://127.0.0.1:8787/v1"
  api_key: "dummy-key-for-maxout"
```

**Any HTTP Client**
```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dummy-key-for-maxout" \
  -d '{"model": "maxout/auto/coding", "messages": [{"role": "user", "content": "Hello"}]}'
```

**Troubleshooting**

- Ensure maxout is running: `maxout status`
- Check that maxout can access all required API keys: `maxout setup`
- Use `maxout serve --trace` to see model routing in real-time
- If no models show up in status, check your maxout configuration in `~/.maxout/config.json`

**Quick Prompt for AI Agents**
You can tell your agent: "Please install maxout globally via npm and start the server with `maxout serve`."
