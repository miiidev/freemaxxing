# Local Model Auto-Pull on Setup

Date: 2026-08-29
Status: Approved design (pending spec review)

## Problem

`maxout setup` with the `local` provider shows a static list of
`LOCAL_MODEL_OPTIONS`. Users select models, but nothing verifies the model is
actually installed in Ollama. If a model is missing, later requests silently
fail or the user must manually run `ollama pull` out-of-band.

## Goal

During interactive `maxout setup` with the `local` provider:

1. Detect which local models are actually installed in Ollama.
2. Show installed status next to each option.
3. Auto-run `ollama pull <model>` for any selected model that is not installed.
4. Only record models that actually pulled successfully in config.

## Approach

### Detection: query `GET <baseURL>/api/tags`

Ollama exposes `GET /api/tags` at the provider base URL
(`http://localhost:11434`). The response body has shape:

```json
{ "models": [ { "name": "qwen2.5-coder:3b", ... } ] }
```

`fetch` it with the `fetchImpl` already threaded through setup. Distinguish
statuses:

- `installed` — name appears in `/api/tags` (exact match or a tag wildcard).
- `missing` — not present; we have an `ollama pull` command for it.
- `unknown` — Ollama unreachable (fetch error / non-200). Treat as missing but
  skip auto-pull; just print the pull command.

### Selection prompt

Show each `LOCAL_MODEL_OPTIONS` entry with a status marker:

```
1. qwen2.5-coder:3b  installed
2. phi4-mini:latest  installed
3. llama3.2:latest   ✗ not installed — will pull
0. Skip (no local models enabled)
```

### Auto-pull

For each selected model in `missing` state, run:

```
ollama pull <model>
```

via `child_process.spawn(..., { stdio: "inherit" })` so users see Ollama's
download progress. Wait for exit.

- Exit code 0 → considered installed → keep in selected set.
- Non-zero → print `⚠ failed to pull <model> — run: ollama pull <model>` and
  drop from the selected set.
- `unknown` state (Ollama unreachable earlier) → skip pull, print the command,
  do not add to config.

### Config persistence

Only the successfully-available models are written to
`config.localModels` and reflected in the alias `providers` lists (existing
behavior, unchanged).

`LOCAL_API_KEY` is still saved to `.env` regardless.

### Non-interactive path — unchanged

`maxout setup --provider local --key local` keeps its current shortcut (dummy
key only, no model prompt, no pull).

### Ollama not running

If `/api/tags` fails (connection refused), setup still completes: the prompt
shows the static list with a `⚠ Ollama unreachable` banner, selects are saved
anyway, and we print the pull commands for anything not installed. No crash.

## Files touched

- `src/setup.ts` — new helpers `listInstalledLocalModels()` and
  `pullLocalModel()`, reworked local selection block in `collect()`.

## Out of scope

- Auto-pull at request time (setup-only per decision).
- Progress bars beyond raw `ollama pull` passthrough.
- Managing models after setup (`ollama rm`, listing outside setup flow).

## Verification

- `npx tsc --noEmit` passes.
- Unit: existing `test/unit/setup.test.ts` still passes
  (`npm test`).
- Manual: run `node dist/cli.js setup`, pick local, confirm status markers
  and that a selected missing model triggers `ollama pull`.