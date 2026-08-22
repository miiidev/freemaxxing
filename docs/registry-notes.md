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
