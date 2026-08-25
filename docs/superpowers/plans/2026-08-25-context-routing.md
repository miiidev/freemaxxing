# Context-Window-Aware Routing Implementation Plan (Phase 2 — Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop sending requests that can't fit a model's window (silent truncation disguised as bad quality), by excluding candidates whose context can't hold estimated input plus output headroom — and widening back instead of hard-failing when nothing fits.

**Architecture:** `RegistryEntry` gains optional `maxOutput` (populated for every entry in `registry.json`; the handoff's `contextWindow` maps onto the existing `context` field). The router replaces its flat 10% reserve with an exact fit rule (`estTokens + outReserve ≤ context`), collects context-exclusions into a new `skippedByContext`, and — only when the kept list would otherwise be empty — re-admits those entries against every non-context filter with `widened: true`, so the server logs one warning and serves a truncated-but-useful answer rather than a 503.

**Tech Stack:** TypeScript (strict, ESM, Node >= 20), Fastify, vitest (fully offline).

**Spec:** `docs/superpowers/specs/2026-08-25-phase2-resilience-design.md` (§2)

## Global Constraints

- Node >= 20; TypeScript strict; ESM; local imports end in `.js`.
- Tests fully offline; inject fake `fetchImpl`.
- No timers; atomic persistence tmp+`renameSync`.
- Comments sparse, explain *why* only.
- Commits: `feat:` / `fix:` / `docs:` / `test:` prefixes, imperative mood.
- Shell is Windows PowerShell: `$env:X="y"`, chain with `if ($?) { }`.
- Full suite: `npm test`. Single file: `npx vitest run <file>`. Build check: `npm run build`.

## Deviations from spec (intentional)

1. The handoff names two new fields (`contextWindow`, `maxOutput`). The registry already carries total-window `context`; introducing `contextWindow` alongside it would create two sources of truth. Spec §2 documents the mapping: **`context` IS `contextWindow`**; only `maxOutput` is added.
2. The old flat `estTokens <= floor(context * 0.9)` rule is **replaced** by `estTokens + (maxOutput ?? 4096) <= context` — the handoff's "estimated input plus reasonable output headroom", stated exactly. Worst-case output reservation errs toward exclusion; widen-back covers the fallout.
3. Skip-reason attribution order (for both this plan and trace Plan F): tags → tools → **context** → state → provider-pool → budget. Context failures therefore outrank state failures in attribution; the visible candidate set is unchanged either way.

## File Structure (final state)

| File | Responsibility |
|---|---|
| `src/types.ts` | `RegistryEntry.maxOutput?: number` |
| `src/catalog.ts` | validate optional positive `maxOutput` |
| `src/registry.json` | `maxOutput` on every entry (snapshot values from provider docs) |
| `src/router.ts` | fit rule, `skippedByContext`, `widened`, exported `OUTPUT_RESERVE_DEFAULT` |
| `src/server.ts` | stderr warning when widened |
| `src/cli.ts` | `--verbose` output-limit column |
| `test/unit/catalog-context.test.ts` | NEW — validator coverage |
| `test/unit/router.test.ts` | fit rule + widen-back coverage (one description updated) |
| `test/unit/cli-local.test.ts` | extended with verbose-column assertions |

---

### Task 1: Registry field + validation + data

**Files:**
- Modify: `src/types.ts` (`RegistryEntry`)
- Modify: `src/catalog.ts` (`isRegistryEntry`)
- Modify: `src/registry.json` (all entries)
- Test: `test/unit/catalog-context.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `RegistryEntry.maxOutput?: number` — later tasks read it via `entry.maxOutput ?? OUTPUT_RESERVE_DEFAULT`.

- [ ] **Step 1: Write failing tests**

Create `test/unit/catalog-context.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { REGISTRY } from "../../src/catalog.js";

describe("maxOutput field", () => {
  it("is present and positive on every shipped registry entry", () => {
    const missing = REGISTRY.filter((e) => !(typeof e.maxOutput === "number" && e.maxOutput > 0));
    expect(missing.map((e) => e.id)).toEqual([]);
  });

  it("never exceeds the entry's total context", () => {
    const bad = REGISTRY.filter((e) => (e.maxOutput ?? 0) > e.context);
    expect(bad.map((e) => e.id)).toEqual([]);
  });
});
```

(Invalid-entry rejection is enforced structurally by `isRegistryEntry` throwing at import time — the positive-value assertion above is the behavioral guard.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/catalog-context.test.ts`
Expected: FAIL — `maxOutput` missing from entries.

- [ ] **Step 3: Implement**

In `src/types.ts`, extend `RegistryEntry`:

```typescript
export interface RegistryEntry {
  id: string;
  provider: string;
  upstream: string;
  tags: string[];
  tier: number;
  speed: Speed;
  context: number;
  maxOutput?: number;
  tools: boolean;
  limits?: DailyCaps;
}
```

In `src/catalog.ts`, inside `isRegistryEntry` after the `context` check:

```typescript
  if (e.maxOutput !== undefined && (typeof e.maxOutput !== "number" || !(e.maxOutput > 0))) return false;
```

Rewrite `src/registry.json` (adds `"maxOutput"` to every entry — snapshot values from provider docs; correct them in-place anytime, routing treats them as headroom):

```json
[
  { "id": "openrouter::deepseek/deepseek-chat-v3-0324:free", "provider": "openrouter", "upstream": "deepseek/deepseek-chat-v3-0324:free", "tags": ["coding", "chat"], "tier": 1, "speed": "medium", "context": 64000, "maxOutput": 8192, "tools": true },
  { "id": "openrouter::qwen/qwen-2.5-coder-32b-instruct:free", "provider": "openrouter", "upstream": "qwen/qwen-2.5-coder-32b-instruct:free", "tags": ["coding"], "tier": 1, "speed": "fast", "context": 32000, "maxOutput": 8192, "tools": true },
  { "id": "openrouter::moonshotai/kimi-k2:free", "provider": "openrouter", "upstream": "moonshotai/kimi-k2:free", "tags": ["coding", "chat", "long-context"], "tier": 2, "speed": "slow", "context": 128000, "maxOutput": 8192, "tools": true },
  { "id": "openrouter::meta-llama/llama-3.3-70b-instruct:free", "provider": "openrouter", "upstream": "meta-llama/llama-3.3-70b-instruct:free", "tags": ["chat"], "tier": 3, "speed": "medium", "context": 64000, "maxOutput": 8192, "tools": true },
  { "id": "openrouter::google/gemini-2.0-flash-exp:free", "provider": "openrouter", "upstream": "google/gemini-2.0-flash-exp:free", "tags": ["chat", "fast", "vision", "long-context"], "tier": 3, "speed": "fast", "context": 1000000, "maxOutput": 8192, "tools": true },
  { "id": "openrouter::z-ai/glm-5.2:free", "provider": "openrouter", "upstream": "z-ai/glm-5.2:free", "tags": ["coding", "chat", "long-context"], "tier": 3, "speed": "medium", "context": 256000, "maxOutput": 8192, "tools": true },
  { "id": "openrouter::nvidia/nemotron-3-ultra-550b-a55b:free", "provider": "openrouter", "upstream": "nvidia/nemotron-3-ultra-550b-a55b:free", "tags": ["coding", "chat", "long-context"], "tier": 1, "speed": "slow", "context": 1000000, "maxOutput": 8192, "tools": true },
  { "id": "openrouter::nvidia/nemotron-3-super-120b-a12b:free", "provider": "openrouter", "upstream": "nvidia/nemotron-3-super-120b-a12b:free", "tags": ["coding", "chat"], "tier": 2, "speed": "medium", "context": 262144, "maxOutput": 8192, "tools": true },
  { "id": "openrouter::nvidia/nemotron-3-nano-30b-a3b:free", "provider": "openrouter", "upstream": "nvidia/nemotron-3-nano-30b-a3b:free", "tags": ["chat", "fast"], "tier": 4, "speed": "fast", "context": 256000, "maxOutput": 8192, "tools": true },
  { "id": "openrouter::nvidia/nemotron-3.5-lightning:free", "provider": "openrouter", "upstream": "nvidia/nemotron-3.5-lightning:free", "tags": ["chat", "fast", "long-context"], "tier": 3, "speed": "fast", "context": 1000000, "maxOutput": 8192, "tools": true },
  { "id": "openrouter::nvidia/nemotron-nano-9b-v2:free", "provider": "openrouter", "upstream": "nvidia/nemotron-nano-9b-v2:free", "tags": ["fast", "chat"], "tier": 4, "speed": "fast", "context": 128000, "maxOutput": 8192, "tools": true },
  { "id": "openrouter::cohere/north-mini-code:free", "provider": "openrouter", "upstream": "cohere/north-mini-code:free", "tags": ["coding"], "tier": 3, "speed": "medium", "context": 256000, "maxOutput": 8192, "tools": true },
  { "id": "groq::openai/gpt-oss-120b", "provider": "groq", "upstream": "openai/gpt-oss-120b", "tags": ["coding", "chat"], "tier": 2, "speed": "fast", "context": 131072, "maxOutput": 32768, "tools": true },
  { "id": "groq::openai/gpt-oss-20b", "provider": "groq", "upstream": "openai/gpt-oss-20b", "tags": ["coding", "chat", "fast"], "tier": 2, "speed": "fast", "context": 131072, "maxOutput": 32768, "tools": true },
  { "id": "groq::llama-3.1-8b-instant", "provider": "groq", "upstream": "llama-3.1-8b-instant", "tags": ["fast", "chat"], "tier": 4, "speed": "fast", "context": 128000, "maxOutput": 8192, "tools": true },
  { "id": "groq::qwen/qwen3.6-27b", "provider": "groq", "upstream": "qwen/qwen3.6-27b", "tags": ["coding", "chat"], "tier": 3, "speed": "medium", "context": 131072, "maxOutput": 8192, "tools": true },
  { "id": "google::gemini-2.5-pro", "provider": "google", "upstream": "gemini-2.5-pro", "tags": ["coding", "long-context"], "tier": 1, "speed": "slow", "context": 1048576, "maxOutput": 65536, "tools": true, "limits": { "rpd": 100 } },
  { "id": "google::gemini-2.5-flash", "provider": "google", "upstream": "gemini-2.5-flash", "tags": ["coding", "chat", "fast", "long-context"], "tier": 2, "speed": "fast", "context": 1048576, "maxOutput": 65536, "tools": true, "limits": { "rpd": 250 } },
  { "id": "google::gemini-2.0-flash", "provider": "google", "upstream": "gemini-2.0-flash", "tags": ["chat", "fast", "long-context"], "tier": 3, "speed": "fast", "context": 1048576, "maxOutput": 8192, "tools": true, "limits": { "rpd": 200 } },
  { "id": "mistral::mistral-small-latest", "provider": "mistral", "upstream": "mistral-small-latest", "tags": ["coding", "chat"], "tier": 3, "speed": "medium", "context": 128000, "maxOutput": 8192, "tools": true },
  { "id": "mistral::ministral-8b-latest", "provider": "mistral", "upstream": "ministral-8b-latest", "tags": ["fast", "chat"], "tier": 4, "speed": "fast", "context": 128000, "maxOutput": 8192, "tools": true },
  { "id": "cerebras::llama-3.3-70b", "provider": "cerebras", "upstream": "llama-3.3-70b", "tags": ["coding", "chat"], "tier": 2, "speed": "fast", "context": 128000, "maxOutput": 8192, "tools": true },
  { "id": "cerebras::qwen-3-32b", "provider": "cerebras", "upstream": "qwen-3-32b", "tags": ["coding", "chat"], "tier": 2, "speed": "fast", "context": 128000, "maxOutput": 8192, "tools": true },
  { "id": "cerebras::gemma-4-31b", "provider": "cerebras", "upstream": "gemma-4-31b", "tags": ["coding", "chat", "fast"], "tier": 2, "speed": "fast", "context": 65536, "maxOutput": 8192, "tools": true }
]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/catalog-context.test.ts test/unit/catalog.test.ts`
Expected: PASS (import-time validation of the rewritten file proves schema correctness).

- [ ] **Step 5: Commit**

```powershell
git add src/types.ts src/catalog.ts src/registry.json test/unit/catalog-context.test.ts
git commit -m "feat: maxOutput registry field with provider-doc snapshot values"
```

---

### Task 2: Fit rule, skip collection, widen-back

**Files:**
- Modify: `src/router.ts`
- Test: `test/unit/router.test.ts`

**Interfaces:**
- Consumes: `RegistryEntry.maxOutput` (Task 1).
- Produces:
  - `router.ts`: `OUTPUT_RESERVE_DEFAULT = 4096`; `ResolveResult = { candidates; skippedByBudget; skippedByContext: RegistryEntry[]; widened: boolean }`
  - Fit rule: candidate kept iff `ctx.estTokens + (entry.maxOutput ?? 4096) <= entry.context` (plus unchanged `minContext`).

- [ ] **Step 1: Write failing tests**

In `test/unit/router.test.ts`, rename the existing headroom test description and add the following inside `describe("resolve", ...)`. Replace the old test

```typescript
  it("drops models whose context cannot fit estimated tokens (90% headroom)", () => {
```

with:

```typescript
  it("drops models whose context cannot fit estimated input plus output reserve", () => {
    const reg = [...REG, e({ id: "e::small", provider: "e", upstream: "small", tags: ["coding"], tier: 0, context: 2000 })];
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, { ...CTX, estTokens: 1900 });
    expect(resolved.candidates.map((x) => x.id)).not.toContain("e::small");
    expect(resolved.skippedByContext.map((x) => x.id)).toEqual(["e::small"]);
  });
```

and append a new describe block after it:

```typescript
describe("context-window awareness", () => {
  const BIG = { hasTools: false, estTokens: 50_000 };

  it("excludes small-context models from a ~50k-token request", () => {
    const reg = [
      e({ id: "tiny::a", provider: "tiny", upstream: "a", tags: ["coding"], tier: 1, context: 32_000 }),
      e({ id: "big::b", provider: "big", upstream: "b", tags: ["coding"], tier: 2, context: 131_072 }),
    ];
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, BIG);
    expect(resolved.candidates.map((x) => x.id)).toEqual(["big::b"]);
    expect(resolved.skippedByContext.map((x) => x.id)).toEqual(["tiny::a"]);
  });

  it("reserves each model's declared maxOutput", () => {
    const reg = [
      e({ id: "x::big-out", provider: "x", upstream: "bo", tags: ["chat"], tier: 1, context: 10_000, maxOutput: 8000 }),
      e({ id: "y::default-out", provider: "y", upstream: "do", tags: ["chat"], tier: 2, context: 10_000 }),
    ];
    // estTokens 5000: 5000+8000 > 10000 excludes x; 5000+4096 <= 10000 keeps y
    const resolved = resolve("auto/any", BUILT_IN_ALIASES, reg, () => OK, { hasTools: false, estTokens: 5000 });
    expect(resolved.candidates.map((x) => x.id)).toEqual(["y::default-out"]);
    expect(resolved.skippedByContext.map((x) => x.id)).toEqual(["x::big-out"]);
  });

  it("widens back to context-excluded candidates instead of returning empty", () => {
    const reg = [
      e({ id: "tiny::a", provider: "tiny", upstream: "a", tags: ["coding"], tier: 1, context: 32_000 }),
      e({ id: "tiny::b", provider: "tiny2", upstream: "b", tags: ["coding"], tier: 2, context: 16_000 }),
    ];
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, BIG);
    expect(resolved.widened).toBe(true);
    expect(resolved.candidates.map((x) => x.id)).toEqual(["tiny::a", "tiny::b"]);
    expect(resolved.skippedByContext).toEqual([]);
  });

  it("widening still honors state and budget filters", () => {
    const reg = [
      e({ id: "tiny::dead", provider: "t1", upstream: "d", tags: ["coding"], tier: 1, context: 16_000 }),
      e({ id: "tiny::spent", provider: "t2", upstream: "s", tags: ["coding"], tier: 2, context: 16_000, limits: { rpd: 5 } }),
    ];
    const states: Record<string, ModelState> = { "tiny::dead": COOL };
    const usage = { "tiny::spent": { day: "2026-08-23", requests: 5, tokensIn: 0, tokensOut: 0 } };
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, reg, (id) => states[id] ?? OK, {
      ...BIG,
      harvest: true,
      now: DAY,
      getUsage: (id) => usage[id],
    });
    expect(resolved.widened).toBe(false);
    expect(resolved.candidates).toEqual([]);
    expect(resolved.skippedByContext).toEqual([]);
    expect(resolved.skippedByBudget.map((x) => x.id)).toEqual(["tiny::spent"]);
  });
});
```

Update the top-of-file import of `types` if `DAY` isn't already defined there — it is (line ~90 in current file); no import changes needed beyond what exists.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/router.test.ts`
Expected: FAIL — `skippedByContext`/`widened` undefined; big-request test leaks `tiny::a` into candidates (old 10% rule admits 50000 ≤ 28800? no — 50000 > 28800 so old rule ALSO excludes… the failing assertions are the new fields themselves plus `reserves declared maxOutput`, which the 0.9 rule passes differently).

- [ ] **Step 3: Implement**

In `src/router.ts`:

1. Extend the result interface:

```typescript
export interface ResolveResult {
  candidates: RegistryEntry[];
  skippedByBudget: RegistryEntry[];
  skippedByContext: RegistryEntry[];
  widened: boolean;
}

// Requests reserve their model's worst-case output against the window;
// undeclared outputs assume a modest chat-sized completion.
export const OUTPUT_RESERVE_DEFAULT = 4096;
```

2. Replace `contextOk`:

```typescript
  const outReserve = (e: RegistryEntry) => e.maxOutput ?? OUTPUT_RESERVE_DEFAULT;
  const contextOk = (e: RegistryEntry) =>
    (def.minContext === undefined || e.context >= def.minContext) &&
    ctx.estTokens + outReserve(e) <= e.context;
```

3. Replace the collection loop (after Plan A it reads `for (const entry of loopInput.filter(contextOk).filter(stateOk)) { ... }` with the budget split inside; if executing without Plan A, first apply A's `aliasCandidates` refactor so `loopInput` exists):

```typescript
  const kept: RegistryEntry[] = [];
  const skippedByBudget: RegistryEntry[] = [];
  const skippedByContext: RegistryEntry[] = [];
  for (const entry of loopInput) {
    if (!contextOk(entry)) {
      skippedByContext.push(entry);
      continue;
    }
    if (!stateOk(entry)) continue;
    if (budgetOk(entry)) kept.push(entry);
    else skippedByBudget.push(entry);
  }

  // A truncated answer beats an error: when nothing fits, give every
  // context-excluded entry a second chance against the non-context filters.
  let widened = false;
  if (kept.length === 0 && skippedByContext.length > 0) {
    for (const entry of skippedByContext) {
      if (!stateOk(entry)) continue;
      if (budgetOk(entry)) kept.push(entry);
      else skippedByBudget.push(entry);
    }
    widened = kept.length > 0;
  }
  if (widened) skippedByContext.length = 0;
```

4. Return:

```typescript
  kept.sort(cmp);
  return { candidates: kept, skippedByBudget, skippedByContext, widened };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/router.test.ts`
Expected: PASS — including all pre-existing harvest/reliability/pool-blocking tests (fields are additive; the only edited assertion is the renamed headroom test).

Then run the whole suite — `npm test` — because `server.ts` reads `resolved.skippedByBudget` (unchanged shape) and integration tests must stay green.

- [ ] **Step 5: Commit**

```powershell
git add src/router.ts test/unit/router.test.ts
git commit -m "feat: context-fit routing with output reserves and widen-back"
```

---

### Task 3: Widened-warning + `status --verbose` limits column

**Files:**
- Modify: `src/server.ts` (warning)
- Modify: `src/cli.ts` (`formatStatusRow` verbose column, `printStatus(verbose)`, arg parsing)
- Test: `test/integration/local-fallback.test.ts` — no; create `test/integration/context-warning.test.ts` (new)
- Test: `test/unit/cli-local.test.ts` (extend)

**Interfaces:**
- Consumes: `ResolveResult.widened` (Task 2); `RegistryEntry.maxOutput` (Task 1).
- Produces:
  - `cli.ts`: `formatStatusRow(e, msRaw, now, usage?, verbose = false)` — extra `String(...).padStart(5)` limits column when verbose; `runCli(["status", "--verbose"])` / `-v` routes the flag through.

- [ ] **Step 1: Write failing tests**

Create `test/integration/context-warning.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import type { AppConfig, ActiveProvider } from "../../src/config.js";
import type { RegistryEntry } from "../../src/types.js";

const CFG: AppConfig = {
  port: 8787, host: "127.0.0.1", aliases: {},
  providers: { groq: { apiKeyEnv: "GROQ_API_KEY" } },
  annotateResponses: false, harvest: true,
};
const PROV: Record<string, ActiveProvider> = {
  groq: { baseURL: "https://groq.test/v1", auth: "bearer", quirks: "groq",
          resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk" },
};

function tiny(id: string, upstream: string): RegistryEntry {
  return { id, provider: "groq", upstream, tags: ["coding", "chat"], tier: 1, speed: "fast", context: 2048, maxOutput: 512, tools: true };
}

const OK_BODY = JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] });

function makeServer(registry: RegistryEntry[]) {
  return buildServer({
    config: CFG, providers: PROV,
    aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
    registry,
    stateMap: new Map(),
    fetchImpl: (async () => new Response(OK_BODY, { status: 200 })) as unknown as typeof fetch,
  });
}

describe("widen-back serving", () => {
  it("warns once and serves a truncated-capable model instead of 503", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeServer([tiny("groq::small-a", "up-a"), tiny("groq::small-b", "up-b")]);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/fast", messages: [{ role: "user", content: "x".repeat(40_000) }] },
    });
    expect(res.statusCode).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("widened context filter");
    warn.mockRestore();
  });

  it("stays silent when candidates fit normally", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeServer([tiny("groq::small-a", "up-a")]);
    await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/fast", messages: [{ role: "user", content: "hi" }] },
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

Extend `test/unit/cli-local.test.ts` (append):

```typescript
import { formatStatusRow } from "../../src/cli.js";

describe("status verbose limits column", () => {
  const entry = {
    id: "groq::m", provider: "groq", upstream: "m", tags: ["chat"],
    tier: 2, speed: "fast" as const, context: 131072, maxOutput: 32768, tools: true,
  };

  it("omits the output column by default", () => {
    const row = formatStatusRow(entry, { state: "ok" }, Date.now(), undefined, false);
    expect(row).not.toContain("32k");
  });

  it("shows the output limit under verbose", () => {
    const row = formatStatusRow(entry, { state: "ok" }, Date.now(), undefined, true);
    expect(row).toContain("32k");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/context-warning.test.ts test/unit/cli-local.test.ts`
Expected: FAIL — no warning emitted; `formatStatusRow` arity ignores 5th arg.

- [ ] **Step 3: Implement**

`src/server.ts` — immediately after the `resolve()` try/catch block (before the local-gate code from Plan A, order irrelevant):

```typescript
    if (resolved.widened) {
      console.error(`maxout: no candidate fits ~${estTokens} tokens for ${alias}; widened context filter`);
    }
```

`src/cli.ts`:

1. `formatStatusRow` gains a parameter and inserts the column right after the context column:

```typescript
export function formatStatusRow(
  e: RegistryEntry,
  msRaw: ModelState,
  now: number,
  usage?: UsageRecord,
  verbose = false,
): string {
```

and in the returned array, after `` String(e.context).padStart(7), ``:

```typescript
    ...(verbose ? [(e.maxOutput ? fmtCompact(e.maxOutput) : "-").padStart(5)] : []),
```

2. `printStatus` gains `verbose` and passes it down:

```typescript
async function printStatus(verbose = false): Promise<void> {
```

and the row call becomes:

```typescript
      console.log("  " + formatStatusRow(entry, states.get(entry.id) ?? { state: "ok" }, now, usageMap.get(entry.id), verbose));
```

3. In `runCli`'s `status` branch:

```typescript
  if (cmd === "status") {
    if (argv.includes("--reliability")) {
      await printReliabilityTable();
    } else {
      await printStatus(argv.includes("--verbose") || argv.includes("-v"));
    }
    return 0;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`; then `npm run build`. Expected: green, clean compile.

- [ ] **Step 5: Commit**

```powershell
git add src/server.ts src/cli.ts test/integration/context-warning.test.ts test/unit/cli-local.test.ts
git commit -m "feat: warn on context widening and show output limits in verbose status"
```
