# Registry curation notes

Decisions made while curating `src/registry.json`, with evidence, so future
curators don't relitigate them.

## Removed: all GitHub Models entries (2026-08-22)

Removed `github::mistralai/Codestral-2501`, `github::openai/gpt-4o-mini`, and
`github::meta/Llama-3.3-70B-Instruct`: GitHub Models was fully retired on
July 30, 2026. The playground, model catalog, inference API, and BYOK
endpoints are no longer available to any customer, including existing
customers with active usage.

Evidence:

- https://github.blog/changelog/2026-07-30-github-models-is-now-retired —
  "As of July 30, 2026, GitHub Models is now retired. The playground, model
  catalog, inference API, and bring your own key (BYOK) are no longer
  available to any customer, including existing customers with active usage."
- https://docs.github.com/en/github-models — "GitHub Models has been retired.
  As of July 30, 2026, GitHub Models has been fully retired."

The inert `github` provider definition remains in `src/providers.json` (and
its default `GITHUB_TOKEN` env mapping): it routes nothing because no
registry entries reference it, and it costs nothing to keep if GitHub ever
ships a successor endpoint.

## Skipped candidates during curation (2026-08-22)

| Candidate | Provider | Reason |
|---|---|---|
| `magistral-small-latest` | mistral | In deprecated table; retiring 7/31/2026 |
| `pixtral-12b-2409` | mistral | Retired 12/31/2025 |
| `qwen-3-coder-480b` | cerebras | Not offered by Cerebras |
| `gemma-3-27b-it` | google | Verification page unreachable at curation time; skipped rather than added unverified |

## OpenRouter curation decisions (2026-08-22)

Verified against https://openrouter.ai/api/v1/models on 2026-08-22
(421 models total; zero `:free` variants of any candidate family present).

| Candidate | Observation | Decision |
|---|---|---|
| `qwen/qwen3-coder:free` | Not present in /api/v1/models response at $0 price; only paid variants exist (`qwen/qwen3-coder`, `qwen/qwen3-coder-next`, `qwen/qwen3-coder-flash`, `qwen/qwen3-coder-plus`, `qwen/qwen3-coder-30b-a3b-instruct`) | Skip |
| `mistralai/mistral-small-3.1-24b-instruct:free` | Not present at $0 price; only paid `mistralai/mistral-small-3.1-24b-instruct` exists | Skip |
| `z-ai/glm-4.5-air:free` | Not present at $0 price; only paid `z-ai/glm-4.5-air` exists; closest live free relative is `z-ai/glm-5.2:free`, already in registry | Skip (covered by `z-ai/glm-5.2:free`) |
| `deepseek/deepseek-r1:free` | Gone from /api/v1/models response; only paid `deepseek/deepseek-r1` and `deepseek/deepseek-r1-0528` remain | Removed from registry in this pass (was seed entry) |

## Removed: groq::llama-3.3-70b-versatile (2026-08-22)

Groq returns 404 for this id:

    {"error":{"message":"The model \llama-3.3-70b-versatile\ does not exist
    or you do not have access to it.","type":"invalid_request_error",
    "code":"model_not_found"}}

It failed every request observed today while other Groq models served.
Unverified but still listed: groq::llama-3.1-8b-instant � recheck on next
curation pass.

## Known operational constraint (2026-08-22): Groq free-org request caps

With a single free Groq key, agent-sized requests (~8-12K prompt tokens from
opencode-style clients) are rejected with HTTP 413 "Request too large for
model ... in organization ..." even at small max_tokens, across gpt-oss and
qwen models. Tiny probes (<200 token prompts) succeed. The practical floor
for reliable opencode/agent traffic is a provider without such tight org-level
request caps (e.g., OpenRouter :free) or multiple provider keys so the router
has alternatives when Groq bounces large payloads.

## Daily-cap seed evidence (2026-08-23)

Seeds live in `src/providers.json` (provider pools) and `src/registry.json`
(per-model). One evidence line per source, verified against live docs:

- OpenRouter — https://openrouter.ai/docs/api-reference/limits (2026-08-23):
  free-model (`:free`) requests per day = 50 for accounts that have purchased
  < 10 credits all-time; 1,000/day once ≥ 10 credits purchased. Seeded pool:
  `{rpd: 50}`.
- Groq — https://console.groq.com/docs/rate-limits (2026-08-23): Free plan
  per-model RPD = 1K for `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, and
  `qwen/qwen3.6-27b` (all routed here); TPD 200K. Planned seed of 14,400 was
  stale — that figure now applies only to prompt-guard models. Seeded pool at
  the floor of routed models: `{rpd: 1000}`.
- Cerebras — https://inference-docs.cerebras.ai/support/rate-limits
  (2026-08-23): Free Trial tier TPD = 1M tokens/day per model (`gpt-oss-120b`,
  `gemma-4-31b`); no permanent free tier exists (trial is $5 credits / 30
  days). Seeded pool: `{tpd: 1000000}`.
- Google — https://ai.google.dev/gemini-api/docs/rate-limits (2026-08-23):
  page unreachable from build environment (two fetch timeouts); third-party
  summaries conflict (gemini-2.5-pro cited as 25 / 50 / 100 RPD; flash models
  as 250 / 500 / 1500 RPD). Seeds kept at planned values — gemini-2.5-pro
  `{rpd: 100}`, gemini-2.5-flash `{rpd: 250}`, gemini-2.0-flash `{rpd: 200}`
  — unverified as of 2026-08-23. Recheck on next curation pass.
