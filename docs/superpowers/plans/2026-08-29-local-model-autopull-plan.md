# Local Model Auto-Pull on Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

During interactive `maxout setup` with the `local` provider, detect which models from `LOCAL_MODEL_OPTIONS` are actually installed in Ollama, show installed status, and auto-run `ollama pull <model>` for any selected model that is not installed. Only record models that successfully pulled in config.

## Architecture

The plan modifies `src/setup.ts` within the `collect()` function's local provider block. Three main additions:

1. **Detection** — Query Ollama's `GET /api/tags` endpoint to list installed models; mark each `LOCAL_MODEL_OPTIONS` as `installed` or `missing`.
2. **Prompt** — Show installed status markers (`✓ installed` / `✗ not installed`) alongside each model option.
3. **Auto-pull** — For each selected model in `missing` state, spawn `ollama pull <model>` via `child_process.spawn`, wait for exit, keep on success (exit 0), drop on failure.

Only successfully-available models are written to `config.localModels` and reflected in alias provider lists (existing behavior, unchanged). Non-interactive `maxout setup --provider local --key local` keeps current behavior (no model prompt, no pull).

## Tech Stack

- Node.js `v20+`
- Ollama REST API (`GET /api/tags`, child_process spawn)
- Existing `fetchImpl` infrastructure in setup.ts
- `child_process` Node API for `ollama pull`

## Global Constraints

- `npx tsc --noEmit` must pass (TypeScript v5.7)
- Test: existing `test/unit/setup.test.ts` passes unchanged
- Manual: `node dist/cli.js setup`, pick local, confirm status markers, selected missing model triggers `ollama pull`
- Non-interactive path: `maxout setup --provider local --key local` unchanged

---
---
## Implementation Tasks

### Task 1: Add `listInstalledLocalModels` helper

**Files:**
- Modify: `src/setup.ts` — add function after existing helpers (before `buildEnvContent`)

**What this task does:**
Adds a function that queries Ollama's `/api/tags` endpoint and returns a `Set` of model names that are currently installed. If the request fails (Ollama not reachable), return an empty Set and print a warning.

**Step 1 — Write the helper function:**

```typescript
function listInstalledLocalModels(baseURL: string, fetchImpl: typeof fetch): Set<string> {
  const installed = new Set<string>();
  try {
    const res = await fetchImpl(joinURL(baseURL, "/api/tags"), {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return installed;
    const data = (await res.json()) as { models: { name: string }[] };
    data.models.forEach((m) => installed.add(m.name));
  } catch {
    out(`⚠ Could not reach Ollama at ${baseURL}; assuming no models installed`);
  }
  return installed;
}
```

**Step 2 — Run `npx tsc --noEmit`** and confirm no type errors.

**Step 3 — Commit:**

```bash
git add src/setup.ts
git commit -m "feat: add listInstalledLocalModels helper"
```

---
### Task 2: Show installed status in the selection prompt

**Files:**
- Modify: `src/setup.ts` — rework the local model selection prompt inside `collect()`

**What this task does:**
Modifies the prompt that asks the user to select local models. Each `LOCAL_MODEL_OPTIONS` entry now shows `✓ installed` or `✗ not installed` based on the Set returned by `listInstalledLocalModels`.

**Step 1 — Before the ask prompt, call the detection helper and store results:**

```typescript
// After provider is confirmed as "local", before the ask prompt:
const installedModels = listInstalledLocalModels(provider.baseURL, opts.fetchImpl || fetch);
```

**Step 2 — Modify the prompt to show status:**

Change the prompt from:
```
Select models (comma-separated numbers, or 0 to skip):
```
to:
```
1. qwen2.5-coder:3b  ✓ installed
2. phi4-mini:latest  ✗ not installed — will pull
3. llama3.2:latest  ✓ installed
4. mistral:latest  ✗ not installed — will pull
5. gemma:latest  ✗ not installed — will pull
0. Skip (no local models enabled)
Select models (comma-separated numbers, or 0 to skip):
```

**Step 3 — Run `npx tsc --noEmit`** — confirm no errors.

**Step 4 — Commit:**

```bash
git add src/setup.ts
git commit -m "feat: show installed status in local model selection"
```
---
### Task 3: Auto-pull missing models after user selection

**Files:**
- Modify: `src/setup.ts` — after user enters model choices, before saving config

**What this task does:**
For each model the user selected that is not installed (based on the Set from Task 1), spawn `ollama pull <model>` via `child_process.spawn`. Stream output to the terminal so the user sees download progress. On exit code 0, consider the model installed and keep it. On non-zero exit, print a warning and drop it from the selected set.

**Step 1 — After the user's input is parsed into a `selected` array, add pull logic:**

```typescript
// After parsing selected models from user input:
const toPull = selected.filter((m) => !installedModels.has(m));
if (toPull.length > 0) {
  out(`\nDownloading missing local models...`);
  for (const model of toPull) {
    out(`\n▶ ollama pull ${model}`);
    const { spawn } = await import("node:child_process");
    const child = spawn("ollama", ["pull", model], { stdio: "inherit" });
    await new Promise<void>((resolve) => child.on("exit", resolve));
    // Check exit code — if 0, model is now installed; if non-zero, warn.
    // We check by seeing if it now appears in the next detection, or just trust exit code.
    if (child.status !== 0) {
      out(`⚠ Failed to pull ${model} — run: ollama pull ${model}`);
      // Remove from selected so it's not recorded
      selected.splice(selected.indexOf(model), 1);
    }
  }
}
```

**Step 2 — Run `npx tsc --noEmit`** — confirm no errors.

**Step 3 — Commit:**

```bash
git add src/setup.ts
git commit -m "feat: auto-pull missing local models during setup"
```
---
### Task 4: Verify and test

**Files:**
- `src/setup.ts`
- `test/unit/setup.test.ts` (existing — should pass unchanged)

**What this task does:**
Run the existing test suite to confirm nothing is broken. Then do a manual verification:

**Step 1 — Type check:**

```bash
npx tsc --noEmit
```

Expected: zero errors.

**Step 2 — Run existing unit tests:**

```bash
npm test -- --run setup
```

Expected: existing tests pass (the local provider flow may be skipped if tests are non-interactive, but TypeScript/compilation should be fine).

**Step 2 — Manual verification (interactive):**

```bash
node dist/cli.js setup
# → Pick "local" as provider
# → At the model selection prompt, note which models show ✓ installed vs ✗ not installed
# → Enter a selection that includes at least one "not installed" model
# → Observe: `ollama pull <model>` runs automatically
# → After setup completes, verify `config.localModels` contains only the models that pulled successfully
```

**Step 3 — Manual verification (non-interactive, unchanged):**

```bash
node dist/cli.js setup --provider local --key local
# → Should complete without model prompts, save LOCAL_API_KEY only
```

**Step 4 — Commit:**

```bash
git add src/setup.ts
git commit -m "feat: verify typecheck and manual flow"
```
---
## Verification Matrix

| Check | Expected |
|-------|----------|
| `npx tsc --noEmit` | Zero errors |
| `npm test` (setup-relevant tests) | Pass unchanged |
| Interactive setup — pick all installed models | Saves config, no pulls |
| Interactive setup — pick a missing model | Triggers `ollama pull`, model recorded only if pull succeeds |
| Non-interactive (`--provider local --key local`) | Unchanged behavior, no prompts/pulls |
| Ollama unreachable | Prints warning, continues with saved models+commands |