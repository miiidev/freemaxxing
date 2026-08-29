# Maxout Bugfix Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 38 issues from the codebase audit — 5 HIGH, 7 MEDIUM, 12 LOW — across 3 phases.

**Architecture:** Incremental fixes on existing code. No new modules, no restructuring. Each fix is scoped to its file and can be verified independently.

**Tech Stack:** TypeScript (strict), NodeNext modules, vitest, Fastify.

## Global Constraints

- No new dependencies beyond what's in `package.json`
- All fixes must be backward-compatible: existing `~/.maxout/` state files must still load
- Tests must pass: `npm test` (vitest)
- Build must pass: `npm run build` (tsc)
- Fixes in `src/` always include corresponding test updates
- Follow existing code style: no comments, minimal abstraction

---

## File Structure Map

| File | Responsibility in this plan |
|------|----------------------------|
| `src/config.ts` | Remove github ghost, add configurable TTFB/backoff/pacing |
| `src/quirks/index.ts` | Remove github quirk, add ollama quirk |
| `src/executor.ts` | Fix recordFailure to use second attempt, export joinURL |
| `src/server.ts` | Streaming malformed cooldown, pipe error handler order, 503 classification |
| `src/cli.ts` | Fix "N/6 providers" denominator, formatPoolLine both caps, trailing space |
| `src/setup.ts` | Alias safety guards, extract joinURL import |
| `src/sse.ts` | Remove duplicate CapturedUsage |
| `src/log.ts` | Remove unused now parameter |
| `src/router.ts` | Pacing from config |
| `src/url.ts` | NEW: shared joinURL utility |
| `test/unit/setup.test.ts` | Fix provider count test, HTTPS test skip, add local model tests |
| `test/unit/cli.test.ts` | Merge duplicate describe blocks |
| `README.md` | Deduplicate quota harvest section, merge opening paragraphs |

---

## Phase 1 — HIGH Severity (5 tasks)

### Task 1.1: Remove ghost `github` provider

**Files:**
- Modify: `src/config.ts:25-31`
- Modify: `src/quirks/index.ts:99-109,117-124`

- [ ] **Step 1: Remove github from DEFAULT_ENV_KEYS**

In `src/config.ts`, delete the line `github: "GITHUB_TOKEN"` from `DEFAULT_ENV_KEYS`:

```typescript
const DEFAULT_ENV_KEYS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
};
```

- [ ] **Step 2: Remove github quirk and its QUIRKS registration**

In `src/quirks/index.ts`:
- Delete the `github: Quirk = { ... }` object (lines 99-109)
- Remove `github` from the `QUIRKS` record:

```typescript
export const QUIRKS: Record<string, Quirk> = {
  openrouter,
  groq,
  google,
  mistral,
  cerebras,
};
```

- [ ] **Step 3: Run tests**

```
npm test
```

Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: remove retired github provider and its quirk"
```

---

### Task 1.2: Fix setup provider tests for local provider

**Files:**
- Modify: `test/unit/setup.test.ts:13-24`

- [ ] **Step 1: Update provider count test**

Replace the test "covers the five live providers" to include `"local"`:

```typescript
it("covers the six live providers including local", () => {
  expect(SETUP_PROVIDERS.map((p) => p.name)).toEqual([
    "groq", "google", "openrouter", "mistral", "cerebras", "local",
  ]);
});
```

- [ ] **Step 2: Update HTTPS test to skip local**

Add a filter in the HTTPS assertion loop to skip local:

```typescript
it("uses https everywhere", () => {
  for (const p of SETUP_PROVIDERS) {
    if (p.name === "local") continue;
    expect(p.baseURL.startsWith("https://")).toBe(true);
    expect(p.signupUrl).toBeDefined();
    expect(p.signupUrl!.startsWith("https://")).toBe(true);
  }
});
```

- [ ] **Step 3: Run tests**

```
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: update setup tests for local provider"
```

---

### Task 1.3: Add `ollama` quirk

**Files:**
- Modify: `src/quirks/index.ts`

- [ ] **Step 1: Add ollama quirk before the QUIRKS export**

In `src/quirks/index.ts`, add after the `cerebras` quirk (before the `QUIRKS` export):

```typescript
const ollama: Quirk = {
  classifyFailure(status, body, _headers, now) {
    if (status >= 500 || status === 0) return OUTAGE;
    if (status === 404) return RETIRED;
    if (CLIENT_ERROR_STATUSES.has(status)) return BAD_REQUEST;
    // Ollama often returns 200 with an error field in the body
    if (status === 200 || status === 400) {
      const msg = bodyStr(body).toLowerCase();
      if (msg.includes("model not found") || msg.includes("no such model")) return RETIRED;
      if (msg.includes("rate limit") || msg.includes("too many requests")) return RATE_60S;
      if (msg.includes("not loaded") || msg.includes("load model")) return { kind: "rate", retryAfterMs: 30_000 };
    }
    return base(status, body, _headers, now) ?? RATE_60S;
  },
};
```

- [ ] **Step 2: Register ollama in QUIRKS**

```typescript
export const QUIRKS: Record<string, Quirk> = {
  openrouter,
  groq,
  google,
  mistral,
  cerebras,
  ollama,
};
```

- [ ] **Step 3: Run tests**

```
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Build check**

```
npm run build
```

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: add ollama quirk for local provider error classification"
```

---

### Task 1.4: Streaming malformed cooldown

**Files:**
- Modify: `src/server.ts:220-231`

- [ ] **Step 1: Add setState call in streaming onVerdict callback**

In `src/server.ts`, modify the `onVerdict` callback inside the `guard` instantiation (around line 225-230). Add `setState` to cool down the model on malformed verdict:

```typescript
const guard = needsTools
  ? sseToolCallGuard({
      tools: requestedTools,
      onVerdict: (v) => {
        if (!v.ok) {
          streamVerdictBad = v.reason ?? "unknown";
          recordMalformed(servedId, streamVerdictBad);
          setState(deps.stateMap, servedId, {
            state: "cooldown",
            until: Date.now() + 60_000,
            reason: "malformed",
          });
        }
      },
    })
  : undefined;
```

Add `setState` to the import at the top of the file (line 9):

```typescript
import { setState } from "./state.js";
```

- [ ] **Step 2: Run tests**

```
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Build check**

```
npm run build
```

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: apply cooldown on streaming malformed tool calls"
```

---

## Phase 2 — MEDIUM Severity (6 tasks)

### Task 2.1: Setup wizard alias safety

**Files:**
- Modify: `src/setup.ts:274-285`

- [ ] **Step 1: Add null-safe alias access**

Replace lines 274-285 with:

```typescript
config.localModels = selected;
if (!config.aliases) config.aliases = {};
for (const aliasName of ["autoAny", "autoFast", "autoCoding"]) {
  const alias = config.aliases[aliasName];
  if (alias && Array.isArray(alias.providers) && !alias.providers.includes("local")) {
    alias.providers.push("local");
  }
}
```

- [ ] **Step 2: Run tests**

```
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "fix: guard against undefined aliases in local model setup"
```

---

### Task 2.2: Configurable TTFB and backoff

**Files:**
- Modify: `src/config.ts` (AppConfig + loadConfig)
- Modify: `src/executor.ts` (use config values)
- Modify: `src/server.ts` (pass config to executor)

- [ ] **Step 1: Add fields to AppConfig**

In `src/config.ts`, add to `AppConfig`:

```typescript
export interface AppConfig {
  // ... existing fields
  ttfbTimeoutMs?: number;
  retryBackoffMs?: number;
}
```

- [ ] **Step 2: Load from config**

In `loadConfig()`, after line 102:

```typescript
if (typeof raw.ttfbTimeoutMs === "number") cfg.ttfbTimeoutMs = raw.ttfbTimeoutMs;
if (typeof raw.retryBackoffMs === "number") cfg.retryBackoffMs = raw.retryBackoffMs;
```

- [ ] **Step 3: Pass to execute in server.ts**

In `src/server.ts`, in `buildServer`, pass config values to `execute()`:

```typescript
const result = await execute({
  // ... existing fields
  ttfbTimeoutMs: deps.config.ttfbTimeoutMs,
  retryBackoffMs: deps.config.retryBackoffMs,
});
```

- [ ] **Step 4: Run tests + build**

```
npm test && npm run build
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: make TTFB timeout and retry backoff configurable"
```

---

### Task 2.3: Fix "N/6 providers" denominator

**Files:**
- Modify: `src/cli.ts:256-258`

- [ ] **Step 1: Use computed provider count**

Replace line 257:

```
maxout serving ${providerCount}/6 providers on http://${cfg.host}:${cfg.port}/v1
```

With:

```
maxout serving ${providerCount}/${registryProviderCount} providers on http://${cfg.host}:${cfg.port}/v1
```

Also compute `registryProviderCount` at the top of the serve block (before use):

```typescript
const registryProviderCount = new Set(applyModelLimits(REGISTRY, cfg.modelLimits).map((e) => e.provider)).size;
```

This already exists in `printStatus()` (line 180) — reuse the same pattern.

- [ ] **Step 2: Run tests**

```
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "fix: derive provider count from registry instead of hard-coded 6"
```

---

### Task 2.4: Distinguish 503 root causes

**Files:**
- Modify: `src/server.ts:171-177`

- [ ] **Step 1: Add classification function before the 503 handler**

In `src/server.ts`, add a helper to classify failure reasons:

```typescript
function classifyFailures(attempts: AttemptRecord[]): string {
  let rates = 0, malformed = 0, quotas = 0, noKeys = 0, total = attempts.length;
  for (const a of attempts) {
    if (a.reason.startsWith("rate")) rates++;
    else if (a.reason.startsWith("malformed")) malformed++;
    else if (a.reason.startsWith("quota")) quotas++;
    else if (a.reason === "no-key") noKeys++;
  }
  if (malformed > total / 2) return "mostly_malformed";
  if (rates > total / 2) return "mostly_rate_limited";
  if (quotas > total / 2) return "mostly_budget_exhausted";
  if (noKeys > total / 2) return "mostly_no_key";
  return "unknown";
}
```

- [ ] **Step 2: Add classification to 503 response**

```typescript
if (!result.ok) {
  return reply.code(503).send(
    err("all_models_exhausted", `No free model available for ${alias} right now.`, {
      attempts: result.attempts,
      skippedByBudget: resolved.skippedByBudget.map((e) => e.id),
      allExhaustedKind: classifyFailures(result.attempts),
    }),
  );
}
```

- [ ] **Step 3: Run tests**

```
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: classify 503 failure causes in response body"
```

---

### Task 2.5: OpenRouter pacing config

**Files:**
- Modify: `src/config.ts` (AppConfig)
- Modify: `src/router.ts` (read from config)
- Modify: `src/server.ts` (pass through RequestCtx)

- [ ] **Step 1: Add pacing to AppConfig**

In `src/config.ts`, add to `AppConfig`:

```typescript
export interface AppConfig {
  // ... existing fields
  pacing?: {
    provider?: string;
    thresholdHours?: number;
    penalty?: number;
  };
}
```

In `loadConfig()`, after the other config reads:

```typescript
if (raw.pacing && typeof raw.pacing === "object") {
  cfg.pacing = { ...raw.pacing };
}
```

- [ ] **Step 2: Pass through RequestCtx in router**

In `src/types.ts`, add to `RequestCtx`:

```typescript
export interface RequestCtx {
  // ... existing fields
  pacing?: {
    provider?: string;
    thresholdHours?: number;
    penalty?: number;
  };
}
```

- [ ] **Step 3: Use in resolve function**

In `src/router.ts`, replace the hard-coded pacing:

```typescript
const pacing = ctx.pacing ?? { provider: "openrouter", thresholdHours: 4, penalty: 0.3 };
const pacingPenalty = e.provider === (pacing.provider ?? "openrouter") && hrs >= (pacing.thresholdHours ?? 4) ? (pacing.penalty ?? 0.3) : 0;
```

- [ ] **Step 4: Wire in server.ts**

In `src/server.ts`, pass `pacing: deps.config.pacing` to the `resolve()` context object (around line 84-91).

- [ ] **Step 5: Run tests + build**

```
npm test && npm run build
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: make pacing configurable with sensible defaults"
```

---

### Task 2.6: Local provider setup tests

**Files:**
- Modify: `test/unit/setup.test.ts`

- [ ] **Step 1: Add test for local model listing helper**

Add a test that mocks the Ollama tags endpoint:

```typescript
describe("local provider setup", () => {
  it("lists installed Ollama models", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({
          models: [{ name: "llama3.2:latest" }, { name: "mistral:latest" }],
        }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const installed = await listInstalledLocalModels("http://localhost:11434", fetchImpl, (...l) => lines.push(...l));
    expect(installed.has("llama3.2:latest")).toBe(true);
    expect(installed.has("mistral:latest")).toBe(true);
  });

  it("handles Ollama unreachable gracefully", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const lines: string[] = [];
    const installed = await listInstalledLocalModels("http://localhost:11434", fetchImpl, (...l) => lines.push(...l));
    expect(installed.size).toBe(0);
  });
});
```

- [ ] **Step 2: Import listInstalledLocalModels in test**

Add to the existing import:

```typescript
import { SETUP_PROVIDERS, buildEnvContent, validateKey, runSetup, listInstalledLocalModels } from "../../src/setup.js";
```

- [ ] **Step 3: Run tests**

```
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: add local model listing tests"
```

---

## Phase 3 — LOW Severity (9 tasks)

### Task 3.1: README deduplication

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Remove duplicate "Quota harvest" section**

Delete lines 149-169 (the second identical copy of the "Quota harvest" section).

- [ ] **Step 2: Fix opening paragraphs**

Replace lines 1-13 with a single clean opening:

````markdown
# maxout

*No entry fee, real winnings — every free AI model, one endpoint.*

Maxout is a local OpenAI-compatible proxy that pools curated **free-tier AI
models** (OpenRouter, Groq, Google AI Studio, Mistral, Cerebras, **and local
LLMs via Ollama/llama.cpp**) behind stable aliases. When one model hits its rate
limit, your request transparently fails over to the next-best free model (or
local model if configured).

## Quickstart
````

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: deduplicate README quota harvest and opening sections"
```

---

### Task 3.2: Remove duplicate CapturedUsage interface

**Files:**
- Modify: `src/sse.ts:204-207`

- [ ] **Step 1: Delete second definition**

Delete lines 204-207 (the duplicate `CapturedUsage` interface definition).

- [ ] **Step 2: Run tests + build**

```
npm test && npm run build
```

Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: remove duplicate CapturedUsage interface in sse.ts"
```

---

### Task 3.3: Extract shared joinURL to utility file

**Files:**
- Create: `src/url.ts`
- Modify: `src/setup.ts:57-59`
- Modify: `src/executor.ts:30-32`

- [ ] **Step 1: Create src/url.ts**

```typescript
export function joinURL(base: string, pathPart: string): string {
  return base.replace(/\/+$/, "") + pathPart;
}
```

- [ ] **Step 2: Update setup.ts**

Remove the local `joinURL` function (lines 57-59) and import from `./url.js`:

```typescript
import { joinURL } from "./url.js";
```

- [ ] **Step 3: Update executor.ts**

Remove the local `joinURL` function (lines 30-32) and export it, then import from `./url.js` instead:

```typescript
import { joinURL } from "./url.js";
```

- [ ] **Step 4: Run tests + build**

```
npm test && npm run build
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: extract shared joinURL utility"
```

---

### Task 3.4: Fix recordFailure to use second attempt data

**Files:**
- Modify: `src/executor.ts:157`

- [ ] **Step 1: Change to second.failure**

Replace `recordFailure(args.stateMap, entry.id, first.failure, ...)` with:

```typescript
recordFailure(args.stateMap, entry.id, second.failure, provider.resetProfile, Date.now());
```

- [ ] **Step 2: Run tests**

```
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "fix: record second attempt failure instead of first on retry"
```

---

### Task 3.5: Fix pipe error handler ordering

**Files:**
- Modify: `src/server.ts:240-255`

- [ ] **Step 1: Attach error handlers before pipe**

Reorder lines 240-255 so error handlers are attached to each stream BEFORE `.pipe()` is called:

```typescript
// Attach error handlers before data flow starts
for (const link of [upstream, rewriter, ...(guard ? [guard] : []), capture, ...(tail ? [tail] : [])]) {
  link.on("error", () => {
    if (!reply.raw.writableEnded) {
      if (link === upstream) {
        upstreamDied = true;
        reply.raw.write(`data: {"maxout_error":"upstream_stream_failed"}\n\n`);
      }
      reply.raw.end();
    }
  });
}

// Now establish pipes (data starts flowing)
head.pipe(capture);
last.pipe(reply.raw);
upstream.pipe(rewriter);
```

- [ ] **Step 2: Run tests**

```
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: attach error handlers before pipe to avoid race"
```

---

### Task 3.6: Type safety and cosmetic fixes batch

**Files:**
- Modify: `src/setup.ts:266` (any → Partial<AppConfig>)
- Modify: `src/cli.ts:78-82` (show both caps)
- Modify: `src/cli.ts:91` (trailing space fix)
- Modify: `src/log.ts:9` (remove unused now param)
- Modify: `test/unit/cli.test.ts:51,146` (merge describe blocks)

- [ ] **Step 1: Fix any type in setup.ts**

Change `let config: any = {};` to:

```typescript
import type { AppConfig } from "./config.js";
// ...
let config: Partial<AppConfig> = {};
```

- [ ] **Step 2: Fix formatPoolLine to show both caps**

Replace the if/else at `cli.ts:78-82`:

```typescript
let spent = "";
if (caps.rpd) {
  spent = `req ${totals.requests}/${fmtCompact(caps.rpd)}`;
}
if (caps.tpd) {
  if (spent) spent += " · ";
  spent += `tok ${fmtCompact(totals.tokensIn + totals.tokensOut)}/${fmtCompact(caps.tpd)}`;
}
if (!spent) spent = "req -";
```

- [ ] **Step 3: Fix trailing space in formatPoolLine**

Change `"model${modelCount === 1 ? ' ' : 's'}"` to `"model${modelCount === 1 ? '' : 's'}"` at `cli.ts:90`.

- [ ] **Step 4: Remove unused now parameter in log.ts**

Change function signature in `src/log.ts:9` from:

```typescript
export function formatRequestLog(
  ...
  now: number = Date.now(),
): string {
```

To remove `now: number = Date.now(),` and the parameter and update the body to use `new Date().toISOString()` directly.

- [ ] **Step 5: Merge duplicate describe blocks in cli.test.ts**

Merge the content from the second `describe("runCli arg routing")` (lines 146-170) into the first one (lines 51-55), then delete lines 146-170.

- [ ] **Step 6: Run tests + build**

```
npm test && npm run build
```

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: type safety and cosmetic fixes"
```

---

### Task 3.7: Unchecked JSON type assertions

**Files:**
- Modify: `src/server.ts:49,184,194`

- [ ] **Step 1: Add runtime shape validation for upstream response**

Add helper:

```typescript
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Use safeJsonParse in place of raw json() call**

Replace line 184:

```typescript
const json = (await result.response.json()) as Record<string, unknown>;
```

With:

```typescript
const json = safeJsonParse(await result.response.text()) ?? {};
```

- [ ] **Step 3: Run tests + build**

```
npm test && npm run build
```

Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: runtime shape validation for upstream JSON responses"
```

---

## Self-Review Checklist

- [ ] **Spec coverage:** All 5 HIGH items from spec → Tasks 1.1-1.4 (Task 1.2 covers item 1.2's two sub-items). All 7 MEDIUM → Tasks 2.1-2.6. All 12 LOW → Tasks 3.1-3.7 (batch items in Task 3.6).
- [ ] **Placeholder scan:** No TODOs, "implement later", or "add appropriate" patterns.
- [ ] **Type consistency:** `AppConfig` interface extended consistently across config.ts → server.ts → router.ts. `setState` imported and used consistently. `joinURL` extracted consistently.