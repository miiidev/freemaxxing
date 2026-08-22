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
| `deepseek/deepseek-r1:free` | Gone from /api/v1/models response; only paid `deepseek/deepseek-r1` and `deepseek/deepseek-r1-0528` remain | Remove in next curation pass (still in registry as `openrouter::deepseek/deepseek-r1:free`; dead id) |
