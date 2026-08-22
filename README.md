# Freeroll

*No entry fee, real winnings — every free AI model, one endpoint.*

Freeroll is a local OpenAI-compatible proxy that pools curated **free-tier AI
models** (OpenRouter, Groq, Google AI Studio, Mistral, Cerebras)
behind stable aliases. When one model hits its rate limit, your request
transparently fails over to the next-best free model.

## Quickstart

    npm install
    npm run build

Then give it at least one provider API key (any subset works). Pick one:

PowerShell (this session only):

    $env:GROQ_API_KEY = "gsk_..."
    node dist/cli.js serve      # listens on http://127.0.0.1:8787/v1

cmd.exe (this session only):

    set GROQ_API_KEY=...
    node dist/cli.js serve

Any shell, persists across sessions — create `%USERPROFILE%\.freeroll\.env`
(that exact folder) containing one key per line, e.g. `GROQ_API_KEY=gsk_...`.

> Warning: in PowerShell, plain `set NAME=value` does **not** create an
> environment variable — use `$env:NAME = value`.

Point any OpenAI-compatible tool at the server:

    base URL: http://127.0.0.1:8787/v1
    API key:  anything (freeroll does not check client keys)
    model:    auto/coding | auto/fast | auto/any

## Aliases

| Alias | Meaning |
|---|---|
| auto/coding | best coding-capable free models (tier-ranked, tools required) |
| auto/fast   | fastest available models first |
| auto/any    | everything, quality-ranked |

Define custom aliases in `~/.freeroll/config.json`:

    { "aliases": { "auto/long": { "tags": ["long-context"], "requireTools": false } } }

## Configuration

Keys are read from environment variables (a `.env` in `~/.freeroll/` is loaded):
`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`,
`GITHUB_TOKEN`, `CEREBRAS_API_KEY`. Providers without keys are skipped.
(`GITHUB_TOKEN` is accepted but inert: GitHub Models was retired in July 2026 — see docs/registry-notes.md.)
Port/host are configurable in `~/.freeroll/config.json`.

## Status

    node dist/cli.js status

Shows every model with its current limit state (`ok`, `cooldown Xm`,
`exhausted until <UTC reset>`).

## Transparency

Every response carries the actual serving model in its `model` field and the
`x-freeroll-served-by` header. Failover happens only before the first streamed
byte; mid-stream failures surface as a `freeroll_error` SSE frame.

### Seeing which model answered

By default Freeroll appends a credit line to every text reply so you can see
which model actually served your request:

```
<normal reply>

---
*freeroll: groq::openai/gpt-oss-120b*
```

Disable it by setting `"annotateResponses": false` in `~/.freeroll/config.json`.

## Development

    npm test          # vitest, fully offline (upstreams mocked)
    npm run build     # strict TypeScript -> dist/
