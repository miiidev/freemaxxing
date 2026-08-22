# Freeroll

*No entry fee, real winnings — every free AI model, one endpoint.*

Freeroll is a local OpenAI-compatible proxy that pools curated **free-tier AI
models** (OpenRouter, Groq, Google AI Studio, Mistral, GitHub Models, Cerebras)
behind stable aliases. When one model hits its rate limit, your request
transparently fails over to the next-best free model.

## Quickstart

    npm install
    npm run build
    set GROQ_API_KEY=...        # any subset of provider keys works
    node dist/cli.js serve      # listens on http://127.0.0.1:8787/v1

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
Port/host are configurable in `~/.freeroll/config.json`.

## Status

    node dist/cli.js status

Shows every model with its current limit state (`ok`, `cooldown Xm`,
`exhausted until <UTC reset>`).

## Transparency

Every response carries the actual serving model in its `model` field and the
`x-freeroll-served-by` header. Failover happens only before the first streamed
byte; mid-stream failures surface as a `freeroll_error` SSE frame.

## Development

    npm test          # vitest, fully offline (upstreams mocked)
    npm run build     # strict TypeScript -> dist/