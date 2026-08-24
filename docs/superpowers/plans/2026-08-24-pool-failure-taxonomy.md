# Pool Semantics + Failure Taxonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider-wide quota pools first-class (a 429 on one `openrouter::*` model instantly kills the whole OpenRouter pool and failover jumps to the next provider), and react differently to *why* a model failed — pool exhaustion, per-model throttle, retirement, or transient outage.

**Architecture:** Provider-pool health lives as entries in the existing `StateMap` under `pool::<provider>` keys (one persistence path, same atomic snapshot format). The executor classifies each failure via the existing quirks layer, then takes a class-specific action: mark the pool + model exhausted (`quota` where pooled caps exist), retire the model persistently on 404, retry once with backoff on transient outages, plain cooldown on rate limits. `resolve()` filters candidates whose provider pool is blocked. `status` renders one `[pool]` summary line per pooled provider and shows reason codes per model.

**Tech Stack:** TypeScript (strict, ESM, Node >= 20), Fastify, vitest (fully offline — upstreams are injected `fetch` mocks).

**Spec:** `docs/superpowers/specs/2026-08-24-next-level-design.md` (§1, §2, §8)

## Global Constraints

- Node >= 20; TypeScript strict; ESM; local imports end in `.js`.
- Tests are fully offline: never hit real provider APIs; inject fake `fetchImpl`.
- No timers: expiry is lazy-checked via `effective()` / `until <= now` comparisons.
- File persistence uses write-to-tmp + `renameSync` atomic replace (pattern in `state.ts`).
- Comments sparse, explain *why* only.
- Commit messages: `feat:` / `fix:` / `docs:` / `test:` prefixes, imperative mood.
- Shell is Windows PowerShell: `$env:X="y"`, chain with `if ($?) { }`.
- Full suite: `npm test`. Single file: `npx vitest run <file>`. Build check: `npm run build`.
- Model ids are always `<provider>::<upstream>`; `pool::<provider>` state keys rely on no provider being named `pool`.

## Deviations from spec (intentional)

1. Spec §2 says "retry same model once with short backoff **before** failing over". Implemented as: first attempt → backoff → second attempt → then cooldown+failover. Backoff defaults to 1000 ms; injectable `sleepImpl`/`retryBackoffMs` keep tests instant (spec silent on determinism).
2. On pooled quota exhaustion the executor writes both `pool::<provider>` and the requesting model's entry directly via `setState` instead of `recordFailure`, so the model's reason can be `"pool"` rather than `"daily-cap"` (spec §8 decision 2).
3. `formatStatusRow` loses its `poolCaps`/`poolTotals` params — pool spend moves from per-model rows to the single `[pool]` line (spec §1 "single pool line"). Existing cli tests asserting inline `pool x/y` fragments are replaced in Task 6.
4. The executor timeout test gains a second `outage` attempts entry because transient failures now retry once (Task 3 updates that assertion).

## File Structure (final state)

| File | Responsibility |
|---|---|
| `src/types.ts` | `FailureKind +"retired"`; `ModelState` reasons + `"retired"` variant |
| `src/state.ts` | + `poolKey`, `isProviderBlocked`, `recordPoolExhaustion`, `retireModel`, `reviveMatching`; reason codes in `applyFailure` |
| `src/quirks/index.ts` | 404 → `{kind:"retired"}` in shared `base()` |
| `src/executor.ts` | class-specific reactions: pool skip, pool marking, retired, transient retry-once |
| `src/router.ts` | ctx.`getProviderState` filter |
| `src/usage.ts` | + `maybeExhaustProvider` |
| `src/server.ts` | live provider state into resolve; proactive pool exhaustion after serving |
| `src/cli.ts` | grouped status w/ `[pool]` lines + reason columns; `reviveCmd`; wiring |
| `README.md` | document pool semantics, reasons, revive |

---

### Task 1: Failure classes & provider-pool state primitives

**Files:**
- Modify: `src/types.ts`
- Modify: `src/state.ts`
- Create: `test/unit/pool-state.test.ts`
- Modify: `test/unit/state.test.ts` (existing `applyFailure` assertions gain reason fields)

**Interfaces:**
- Consumes: nothing new.
- Produces (exact names later tasks rely on):
  - `types.ts`: `FailureKind = "rate" | "quota" | "outage" | "bad_request" | "retired"`; `CooldownReason = "peak-throttle" | "transient"`; `ExhaustReason = "pool" | "daily-cap"`; `ModelState = { state:"ok" } | { state:"cooldown"; until:number; reason?:CooldownReason } | { state:"exhausted"; until:number; reason?:ExhaustReason } | { state:"retired"; since:number }`
  - `state.ts`: `poolKey(provider: string): string`, `recordPoolExhaustion(map: StateMap, provider: string, reset: ResetProfile, now: number): void`, `isProviderBlocked(map: StateMap, provider: string, now: number): boolean`, `retireModel(map: StateMap, id: string, now: number): void`, `reviveMatching(map: StateMap, target: string): string[]`

- [ ] **Step 1: Write failing tests**

Create `test/unit/pool-state.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  effective, loadState, nextUtcMidnight, setState,
  bindStateFile, recordPoolExhaustion, isProviderBlocked,
  retireModel, reviveMatching, poolKey,
} from "../../src/state.js";

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);
const RESET = { kind: "daily-utc-midnight" } as const;

describe("poolKey", () => {
  it("namespaces provider entries away from model ids", () => {
    expect(poolKey("openrouter")).toBe("pool::openrouter");
  });
});

describe("recordPoolExhaustion", () => {
  it("marks the whole pool exhausted until next UTC midnight", () => {
    const map = new Map();
    recordPoolExhaustion(map, "openrouter", RESET, T0);
    expect(map.get("pool::openrouter")).toEqual({
      state: "exhausted", until: nextUtcMidnight(T0), reason: "pool",
    });
  });

  it("persists through bindStateFile", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-pool-")), "state.json");
    bindStateFile(file);
    const map = new Map();
    recordPoolExhaustion(map, "openrouter", RESET, T0);
    expect(loadState(file, T0).get("pool::openrouter")?.state).toBe("exhausted");
  });
});

describe("isProviderBlocked", () => {
  it("false when no pool entry exists", () => {
    expect(isProviderBlocked(new Map(), "openrouter", T0)).toBe(false);
  });
  it("true while exhausted", () => {
    const map = new Map();
    map.set("pool::openrouter", { state: "exhausted", until: T0 + 1000, reason: "pool" });
    expect(isProviderBlocked(map, "openrouter", T0)).toBe(true);
  });
  it("lazily expires at until", () => {
    const map = new Map();
    map.set("pool::openrouter", { state: "exhausted", until: T0, reason: "pool" });
    expect(isProviderBlocked(map, "openrouter", T0 + 1)).toBe(false);
  });
});

describe("retired models", () => {
  it("retireModel persists a since-stamped entry", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-ret-")), "state.json");
    bindStateFile(file);
    const map = new Map();
    retireModel(map, "or::old", T0);
    expect(loadState(file, T0).get("or::old")).toEqual({ state: "retired", since: T0 });
  });

  it("effective() never expires retired (no until)", () => {
    expect(effective({ state: "retired", since: T0 }, T0 + 86_400_000))
      .toEqual({ state: "retired", since: T0 });
  });
});

describe("reviveMatching", () => {
  it("removes an exact model id and its provider pool by bare name", () => {
    const map = new Map();
    setState(map, "or::a", { state: "retired", since: T0 });
    setState(map, "pool::openrouter", { state: "exhausted", until: T0 + 9, reason: "pool" });
    setState(map, "gr::b", { state: "cooldown", until: T0 + 9, reason: "peak-throttle" });
    const removed = reviveMatching(map, "or::a");
    expect(removed).toEqual(["or::a"]);
    expect(reviveMatching(map, "openrouter")).toEqual(["pool::openrouter"]);
    expect([...map.keys()]).toEqual(["gr::b"]);
  });

  it("returns empty when nothing matches", () => {
    expect(reviveMatching(new Map(), "nope")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/pool-state.test.ts`
Expected: FAIL — `poolKey` etc. not exported from `../../src/state.js`.

- [ ] **Step 3: Implement types + state helpers**

In `src/types.ts` replace the `FailureKind`, `Failure` section and ` ModelState` union:

```typescript
export type FailureKind = "rate" | "quota" | "outage" | "bad_request" | "retired";

export type CooldownReason = "peak-throttle" | "transient";
export type ExhaustReason = "pool" | "daily-cap";

export interface Failure {
  kind: FailureKind;
  retryAfterMs?: number;
}
```

and:

```typescript
export type ModelState =
  | { state: "ok" }
  | { state: "cooldown"; until: number; reason?: CooldownReason }
  | { state: "exhausted"; until: number; reason?: ExhaustReason }
  | { state: "retired"; since: number };
```

In `src/state.ts` replace `applyFailure` with the reason-carrying version and add the new helpers after `setState`:

```typescript
export function applyFailure(
  _current: ModelState,
  f: Failure,
  _reset: ResetProfile,
  now: number,
): ModelState {
  if (f.kind === "quota") {
    return { state: "exhausted", until: nextUtcMidnight(now), reason: "daily-cap" };
  }
  if (f.kind === "rate") {
    return {
      state: "cooldown",
      until: now + (f.retryAfterMs ?? DEFAULT_COOLDOWN_MS),
      reason: "peak-throttle",
    };
  }
  return { state: "cooldown", until: now + (f.retryAfterMs ?? DEFAULT_COOLDOWN_MS), reason: "transient" };
}
```

```typescript
// Pool entries live beside model ids; legal because registry ids always
// contain "::" between two non-empty halves and no provider is named "pool".
export function poolKey(provider: string): string {
  return `pool::${provider}`;
}

export function isProviderBlocked(map: StateMap, provider: string, now: number): boolean {
  const ms = map.get(poolKey(provider));
  if (!ms) return false;
  return effective(ms, now).state !== "ok";
}

export function recordPoolExhaustion(
  map: StateMap,
  provider: string,
  _reset: ResetProfile,
  now: number,
): void {
  setState(map, poolKey(provider), {
    state: "exhausted",
    until: nextUtcMidnight(now),
    reason: "pool",
  });
}

export function retireModel(map: StateMap, id: string, now: number): void {
  setState(map, id, { state: "retired", since: now });
}

export function reviveMatching(map: StateMap, target: string): string[] {
  const removed: string[] = [];
  for (const id of [...map.keys()]) {
    if (id === target || id === poolKey(target)) {
      map.delete(id);
      removed.push(id);
    }
  }
  if (removed.length > 0 && stateFile) saveState(stateFile, map);
  return removed;
}
```

Note: `effective()` needs no change — `retired` has no `until`, so the existing expiry branch leaves it alone.

- [ ] **Step 4: Run new tests to verify they pass**

Run: `npx vitest run test/unit/pool-state.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Fix legacy assertions broken by reason fields**

Run: `npm test`
Expected: FAIL in `test/unit/state.test.ts` — three `applyFailure` `toEqual` assertions lack the new `reason` field.

Edit those assertions in `test/unit/state.test.ts`:

```typescript
  it("rate -> cooldown honoring retryAfterMs", () => {
    expect(applyFailure({ state: "ok" }, { kind: "rate", retryAfterMs: 5000 }, RESET, T0))
      .toEqual({ state: "cooldown", until: T0 + 5000, reason: "peak-throttle" });
  });
  it("rate -> cooldown default 60s without retryAfterMs", () => {
    expect(applyFailure({ state: "ok" }, { kind: "rate" }, RESET, T0))
      .toEqual({ state: "cooldown", until: T0 + 60_000, reason: "peak-throttle" });
  });
```

and:

```typescript
  it("quota -> exhausted at next UTC midnight", () => {
    const ms = applyFailure({ state: "ok" }, { kind: "quota" }, RESET, T0);
    expect(ms.until).toBe(nextUtcMidnight(T0));
  });
  it("quota -> daily-cap reason", () => {
    expect(applyFailure({ state: "ok" }, { kind: "quota" }, RESET, T0).reason).toBe("daily-cap");
  });
  it("outage -> cooldown default", () => {
    expect(applyFailure({ state: "ok" }, { kind: "outage" }, RESET, T0))
      .toEqual({ state: "cooldown", until: T0 + 60_000, reason: "transient" });
  });
```

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: PASS (all files).

- [ ] **Step 7: Commit**

```powershell
git add src/types.ts src/state.ts test/unit/pool-state.test.ts test/unit/state.test.ts
git commit -m "feat: failure-class reason codes and provider-pool state primitives"
```

---

### Task 2: Quirks classify 404 as `retired`

**Files:**
- Modify: `src/quirks/index.ts`
- Create: `test/unit/quirks-404.test.ts`

**Interfaces:**
- Consumes: `FailureKind "retired"` (Task 1).
- Produces: every quirk in `QUIRKS` returns `{ kind: "retired" }` for HTTP 404. Executor (Task 3) switches on this exact kind value.

- [ ] **Step 1: Write failing tests**

Create `test/unit/quirks-404.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { QUIRKS } from "../../src/quirks/index.js";

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);

describe("404 classification", () => {
  for (const [name, quirk] of Object.entries(QUIRKS)) {
    it(`${name}: 404 -> retired`, () => {
      const f = quirk.classifyFailure(
        404,
        { error: { message: "No endpoints found for model" } },
        new Headers(),
        NOW,
      );
      expect(f.kind).toBe("retired");
    });
  }

  it("groq: other client errors stay bad_request", () => {
    expect(
      QUIRKS.groq.classifyFailure(400, { error: { message: "bad" } }, new Headers(), NOW),
    ).toEqual({ kind: "bad_request" });
  });

  it("openrouter: 5xx stays outage even with 404 nearby", () => {
    expect(
      QUIRKS.openrouter.classifyFailure(500, {}, new Headers(), NOW).kind,
    ).toBe("outage");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/quirks-404.test.ts`
Expected: FAIL — 404 currently yields `kind: "bad_request"`.

- [ ] **Step 3: Implement**

In `src/quirks/index.ts`:

Remove `404` from the client-error set and add the RETIRED constant:

```typescript
const RETIRED: Failure = { kind: "retired" };

// Deterministic client errors: the REQUEST is at fault, not the model or
// provider — retrying the same request elsewhere may work, but cooling this
// model down would be wrong, and treating it as transient masks the cause.
const CLIENT_ERROR_STATUSES = new Set([400, 405, 409, 413, 422]);
```

Add the 404 branch to `base()` right after the 5xx check:

```typescript
function base(status: number, body: unknown, headers: Headers, now: number): Failure | null {
  if (status >= 500) return OUTAGE;
  // A 404 on /chat/completions is effectively always "model id unresolved".
  if (status === 404) return RETIRED;
  if (CLIENT_ERROR_STATUSES.has(status)) return BAD_REQUEST;
  const ra = retryAfterHeader(headers, now);
  if (ra !== undefined) return { kind: "rate", retryAfterMs: ra };
  return null;
}
```

(The `github` quirk checks its 429 reset header before calling `base()`; untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/quirks-404.test.ts && npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: PASS (existing quirks tests do not assert 404 behavior — verified by reading `test/unit/quirks.test.ts` before this task; if any does, update it to expect `retired`).

- [ ] **Step 6: Commit**

```powershell
git add src/quirks/index.ts test/unit/quirks-404.test.ts
git commit -m "feat: classify 404 responses as model retirement"
```

---

### Task 3: Executor failure-class reactions

**Files:**
- Modify: `src/executor.ts`
- Modify: `test/integration/executor.test.ts` (append new describes; update two existing assertions)

**Interfaces:**
- Consumes: `poolKey`, `isProviderBlocked`, `retireModel`, `setState` (Task 1); `kind:"retired"` (Task 2).
- Produces:
  - `ExecuteArgs` gains optional `providerCaps?: Record<string, DailyCaps>`, `retryBackoffMs?: number` (default 1000), `sleepImpl?: (ms: number) => Promise<void>`.
  - Behavior contract later tasks/tests rely on:
    - quota + `providerCaps[entry.provider]` present → sets `pool::<provider>` AND `<model>` to `{ state:"exhausted", until: nextUtcMidnight(now), reason:"pool" }`; subsequent same-provider candidates skipped with attempt `reason:"pool-exhausted"`.
    - quota without pooled caps → model `{ state:"exhausted", …, reason:"daily-cap" }`.
    - retired → `{ state:"retired", since }`, never retried within the request.
    - outage → one same-model retry after backoff, then `recordFailure` (cooldown `reason:"transient"`) and move on.
    - `bad_request` unchanged (no state writes).

- [ ] **Step 1: Write failing tests**

Append to `test/integration/executor.test.ts` (after the existing `describe("execute", ...)` block, reusing its helpers):

```typescript
const OR: ActiveProvider = {
  baseURL: "https://or.test/v1", auth: "bearer", quirks: "openrouter",
  resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk-or",
};
const OR_A: RegistryEntry = {
  id: "or::a", provider: "or", upstream: "a",
  tags: ["coding"], tier: 1, speed: "fast", context: 1000, tools: true,
};
const OR_B: RegistryEntry = { ...OR_A, id: "or::b", upstream: "b" };
const GR_C: RegistryEntry = { ...A, id: "groq::c", upstream: "c" };
const NO_SLEEP = (async () => {}) as (ms: number) => Promise<void>;

describe("failure taxonomy", () => {
  it("pooled quota kills the whole provider pool and jumps straight to the next provider", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      calls.push(sent.model);
      return sent.model === "a"
        ? jsonResponse(429, { error: { message: "Free-models-per-day limit exceeded" } })
        : jsonResponse(200, { id: "y", choices: [] });
    }) as unknown as typeof fetch;

    const stateMap = new Map();
    const res = await execute({
      candidates: [OR_A, OR_B, GR_C],
      providers: { or: OR, groq: P_GROQ },
      body: { messages: [] },
      stateMap,
      providerCaps: { or: { rpd: 50 } },
      sleepImpl: NO_SLEEP,
      fetchImpl,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.servedBy.id).toBe("groq::c");
    expect(calls).toEqual(["a", "c"]); // or::b was never attempted
    expect(res.attempts.map((a) => a.reason)).toEqual(["quota 429", "pool-exhausted"]);
    expect(stateMap.get("pool::or")).toMatchObject({ state: "exhausted", reason: "pool" });
    expect(stateMap.get("or::a")).toMatchObject({ state: "exhausted", reason: "pool" });
  });

  it("non-pooled quota marks just the model with daily-cap reason", async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      return sent.model === "a"
        ? jsonResponse(429, { error: { message: "Rate limit reached on tokens per day (TPD)" } })
        : jsonResponse(200, { id: "z", choices: [] });
    }) as unknown as typeof fetch;

    const stateMap = new Map();
    await execute({
      candidates: [A, B], providers: { groq: P_GROQ },
      body: { messages: [] }, stateMap, sleepImpl: NO_SLEEP, fetchImpl,
    });
    expect(stateMap.get("groq::a")).toMatchObject({ state: "exhausted", reason: "daily-cap" });
    expect(stateMap.has("pool::groq")).toBe(false);
  });

  it("rate 429 cools down just that model and moves on without same-model retry", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      calls.push(sent.model);
      return sent.model === "a"
        ? jsonResponse(429, { error: { message: "too many requests" } }, { "retry-after": "30" })
        : jsonResponse(200, { id: "y", choices: [] });
    }) as unknown as typeof fetch;

    const slept: number[] = [];
    const stateMap = new Map();
    const res = await execute({
      candidates: [A, B], providers: { groq: P_GROQ },
      body: { messages: [] }, stateMap,
      sleepImpl: (ms) => { slept.push(ms); return Promise.resolve(); },
      fetchImpl,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.servedBy.id).toBe("groq::b");
    expect(calls).toEqual(["a", "b"]);
    expect(slept).toEqual([]); // ModelCooldown never retries in-request
    expect(stateMap.get("groq::a")).toMatchObject({ state: "cooldown", reason: "peak-throttle" });
  });

  it("404 retires the model permanently and moves on", async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      return sent.model === "a"
        ? jsonResponse(404, { error: { message: "No endpoints found" } })
        : jsonResponse(200, { id: "w", choices: [] });
    }) as unknown as typeof fetch;

    const stateMap = new Map();
    const res = await execute({
      candidates: [A, B], providers: { groq: P_GROQ },
      body: { messages: [] }, stateMap, sleepImpl: NO_SLEEP, fetchImpl,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.servedBy.id).toBe("groq::b");
    expect(stateMap.get("groq::a")).toEqual({ state: "retired", since: expect.any(Number) });
  });

  it("transient 5xx retries the SAME model once before failing over", async () => {
    let callsForA = 0;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      if (sent.model === "a") {
        callsForA++;
        return callsForA === 1
          ? jsonResponse(503, { oops: true })
          : jsonResponse(200, { id: "v", choices: [] });
      }
      return jsonResponse(200, { id: "fallback", choices: [] });
    }) as unknown as typeof fetch;

    const slept: number[] = [];
    const res = await execute({
      candidates: [A, B], providers: { groq: P_GROQ },
      body: { messages: [] }, stateMap: new Map(),
      retryBackoffMs: 250, sleepImpl: (ms) => { slept.push(ms); return Promise.resolve(); },
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.servedBy.id).toBe("groq::a"); // recovered in place
    expect(callsForA).toBe(2);
    expect(slept).toEqual([250]);
    expect(res.attempts.map((x) => x.reason)).toEqual(["outage 503"]);
  });

  it("transient that fails twice records a transient cooldown and fails over", async () => {
    const fetchImpl = (async () => jsonResponse(500, { oops: true })) as unknown as typeof fetch;
    const stateMap = new Map();
    const res = await execute({
      candidates: [A, B], providers: { groq: P_GROQ },
      body: { messages: [] }, stateMap, retryBackoffMs: 0, sleepImpl: NO_SLEEP, fetchImpl,
    });
    expect(stateMap.get("groq::a")).toMatchObject({ state: "cooldown", reason: "transient" });
    expect(res.attempts.map((x) => `${x.model}:${x.reason}`)).toEqual([
      "groq::a:outage 500",
      "groq::a:outage 500",
    ]);
  });
});
```

Also update the existing timeout test's final assertion (retry-once now produces two identical attempt entries):

```typescript
  it("treats connect timeouts as outage and moves on", async () => {
    const fetchImpl = ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    const stateMap = new Map();
    const res = await execute({
      candidates: [A],
      providers: { groq: P_GROQ },
      body: { messages: [] },
      stateMap: stateMap,
      ttfbTimeoutMs: 20,
      sleepImpl: NO_SLEEP,
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toEqual([
        { model: "groq::a", reason: "outage" },
        { model: "groq::a", reason: "outage" },
      ]);
    }
    expect(stateMap.get("groq::a")?.state).toBe("cooldown");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/executor.test.ts`
Expected: FAIL — `providerCaps`/`sleepImpl` options ignored, 404 recorded as bad_request without retirement, no same-model retry.

- [ ] **Step 3: Implement**

Replace `src/executor.ts` entirely with:

```typescript
import { QUIRKS } from "./quirks/index.js";
import {
  isProviderBlocked, nextUtcMidnight, poolKey, recordFailure,
  retireModel, setState, type StateMap,
} from "./state.js";
import type { ActiveProvider } from "./config.js";
import type { AttemptRecord, DailyCaps, Failure, RegistryEntry } from "./types.js";

export interface ExecuteArgs {
  candidates: RegistryEntry[];
  providers: Record<string, ActiveProvider>;
  body: Record<string, unknown>;
  stateMap: StateMap;
  ttfbTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  providerCaps?: Record<string, DailyCaps>;
  retryBackoffMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

export type ExecuteResult =
  | { ok: true; response: Response; servedBy: RegistryEntry; attempts: AttemptRecord[] }
  | { ok: false; attempts: AttemptRecord[] };

const DEFAULT_TTFB_MS = 30_000;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;

export function joinURL(base: string, pathPart: string): string {
  return base.replace(/\/+$/, "") + pathPart;
}

type AttemptOutcome =
  | { kind: "ok"; response: Response }
  | { kind: "fail"; failure: Failure; status?: number; detail?: string };

async function attemptOnce(
  entry: RegistryEntry,
  provider: ActiveProvider,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  ttfbTimeoutMs: number,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ttfbTimeoutMs);
  let response: Response;
  try {
    const { model: _ignored, ...upstreamBody } = body;
    response = await fetchImpl(joinURL(provider.baseURL, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({ ...upstreamBody, model: entry.upstream }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return { kind: "fail", failure: { kind: "outage" } };
  }
  clearTimeout(timer);

  if (response.ok) return { kind: "ok", response };

  const text = await response.text().catch(() => "");
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep raw text as the body for classification
  }
  const quirk = QUIRKS[provider.quirks];
  const failure = quirk
    ? quirk.classifyFailure(response.status, parsed, response.headers, Date.now())
    : ({ kind: "outage" } as const);
  return {
    kind: "fail",
    failure: { ...failure },
    status: response.status,
    detail: snippet(parsed),
  };
}

// Failover happens here only — i.e. before any byte reaches the client.
// Once a Response is returned, the caller owns the stream and never switches models.
export async function execute(args: ExecuteArgs): Promise<ExecuteResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const doSleep = args.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoffMs = args.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const attempts: AttemptRecord[] = [];
  const ttfb = args.ttfbTimeoutMs ?? DEFAULT_TTFB_MS;

  for (const entry of args.candidates) {
    if (isProviderBlocked(args.stateMap, entry.provider, Date.now())) {
      attempts.push({ model: entry.id, reason: "pool-exhausted" });
      continue;
    }

    const provider = args.providers[entry.provider];
    if (!provider) {
      attempts.push({ model: entry.id, reason: "no-key" });
      continue;
    }

    const first = await attemptOnce(entry, provider, args.body, fetchImpl, ttfb);
    if (first.kind === "ok") {
      return { ok: true, response: first.response, servedBy: entry, attempts };
    }
    pushAttempt(attempts, entry.id, first);

    // Deterministic client errors say nothing about model health — move on silently.
    if (first.failure.kind === "bad_request") continue;

    if (first.failure.kind === "retired") {
      retireModel(args.stateMap, entry.id, Date.now());
      continue;
    }

    if (first.failure.kind === "quota") {
      markQuota(args, entry);
      continue;
    }

    if (first.failure.kind === "rate") {
      recordFailure(args.stateMap, entry.id, first.failure, provider.resetProfile, Date.now());
      continue;
    }

    // Transient (outage): one same-model retry after a short backoff.
    await doSleep(backoffMs);
    const second = await attemptOnce(entry, provider, args.body, fetchImpl, ttfb);
    if (second.kind === "ok") {
      return { ok: true, response: second.response, servedBy: entry, attempts };
    }
    pushAttempt(attempts, entry.id, second);
    recordFailure(args.stateMap, entry.id, first.failure, provider.resetProfile, Date.now());
  }

  return { ok: false, attempts };
}

function pushAttempt(
  attempts: AttemptRecord[],
  modelId: string,
  outcome: Extract<AttemptOutcome, { kind: "fail" }>,
): void {
  attempts.push({
    model: modelId,
    reason: outcome.status === undefined
      ? outcome.failure.kind
      : `${outcome.failure.kind} ${outcome.status}`,
    status: outcome.status,
    detail: outcome.detail,
  });
}

function markQuota(args: ExecuteArgs, entry: RegistryEntry): void {
  const now = Date.now();
  const until = nextUtcMidnight(now);
  const pooled = Boolean(args.providerCaps?.[entry.provider]);
  setState(args.stateMap, entry.id, {
    state: "exhausted",
    until,
    reason: pooled ? "pool" : "daily-cap",
  });
  if (pooled) {
    setState(args.stateMap, poolKey(entry.provider), {
      state: "exhausted",
      until,
      reason: "pool",
    });
  }
}

function snippet(body: unknown): string | undefined {
  let s = typeof body === "string" ? body : JSON.stringify(body) ?? "";
  if (!s) return undefined;
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}
```

Behavior notes:
- Rate-class failures cool down just the model (`reason:"peak-throttle"` via `applyFailure`) and move on — never retried in-request (spec §2 ModelCooldown).
- Outage-class retries once in place; the cooldown (`reason:"transient"`) is only recorded when the retry also fails (Deviation 1).
- The pre-existing test "fails over on quota 429…" keeps passing: attempt reasons remain `quota 429` and the model ends `exhausted`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/executor.test.ts && npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: PASS. (Server integration tests exercise the executor via mocked fetch; their 200-only flows are unaffected.)

- [ ] **Step 6: Commit**

```powershell
git add src/executor.ts test/integration/executor.test.ts
git commit -m "feat: class-specific failure reactions in executor"
```

---

### Task 4: Router skips provider-blocked candidates

**Files:**
- Modify: `src/router.ts`
- Modify: `test/unit/router.test.ts` (append)

**Interfaces:**
- Consumes: `effective` from `state.js`; `ModelState` with `"retired"` (Task 1).
- Produces: `RequestCtx` gains `getProviderState?: (provider: string) => ModelState | undefined`. Candidates whose provider pool is non-ok are excluded from BOTH `candidates` and `skippedByBudget` (they are unhealthy, not budget-skipped).

- [ ] **Step 1: Write failing tests**

Append to `test/unit/router.test.ts`:

```typescript
describe("provider-level blocking", () => {
  const BLOCKED_EXH: ModelState = { state: "exhausted", until: Number.MAX_SAFE_INTEGER, reason: "pool" };
  const EXPIRED: ModelState = { state: "exhausted", until: 1, reason: "pool" };
  const RETIRED_POOL: ModelState = { state: "retired", since: 0 };

  it("drops every candidate of a blocked provider", () => {
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, REG, () => OK, {
      ...CTX,
      getProviderState: (p) => (p === "a" ? BLOCKED_EXH : undefined),
    });
    expect(resolved.candidates.map((x) => x.id)).toEqual(["b::two"]);
    expect(resolved.skippedByBudget).toEqual([]);
  });

  it("ignores expired pool blocks (lazy expiry)", () => {
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, REG, () => OK, {
      ...CTX,
      getProviderState: (p) => (p === "a" ? EXPIRED : undefined),
    });
    expect(resolved.candidates.map((x) => x.id)).toEqual(["a::one", "b::two"]);
  });

  it("honors retired pool entries regardless of time", () => {
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, REG, () => OK, {
      ...CTX,
      getProviderState: (p) => (p === "a" ? RETIRED_POOL : undefined),
    });
    expect(resolved.candidates.map((x) => x.id)).toEqual(["b::two"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/router.test.ts`
Expected: FAIL — `getProviderState` unknown/ignored.

- [ ] **Step 3: Implement**

In `src/router.ts` add to imports:

```typescript
import { effective } from "./state.js";
```

Extend `RequestCtx` handling — in `src/types.ts` add inside `RequestCtx`:

```typescript
  getProviderState?: (provider: string) => ModelState | undefined;
```

Replace `stateOk` in `resolve()`:

```typescript
  const stateOk = (e: RegistryEntry) => {
    if (getState(e.id).state !== "ok") return false;
    const ps = ctx.getProviderState?.(e.provider);
    return !ps || effective(ps, now).state === "ok";
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/router.test.ts && npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```powershell
git add src/router.ts src/types.ts test/unit/router.test.ts
git commit -m "feat: resolve() filters provider-blocked candidates"
```

---

### Task 5: Server wiring — live pool state & proactive pool exhaustion

**Files:**
- Modify: `src/usage.ts`
- Modify: `src/server.ts`
- Modify: `test/integration/server.test.ts` (append)

**Interfaces:**
- Consumes: `poolKey`, `setState` (Task 1); `getProviderState` ctx hook (Task 4).
- Produces:
  - `usage.ts`: `maybeExhaustProvider(states: StateMap, provider: string, view: BudgetView, now: number): void`
  - server: after every served request, if pooled caps exist and budget is spent, `pool::<provider>` becomes exhausted (visible to `status` and to `resolve()` on the very next request).

- [ ] **Step 1: Write failing test**

Append to `test/integration/server.test.ts`. The server mutates the same `stateMap` instance passed via deps, so assert against it directly:

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("proactive pool exhaustion", () => {
  it("marks pool::<provider> exhausted when the pooled cap is spent", async () => {
    const usageMap: UsageMap = new Map();
    const stateMap = new Map();
    const registry: RegistryEntry[] = [{
      id: "or::m1", provider: "or", upstream: "m1",
      tags: ["coding"], tier: 1, speed: "fast", context: 32000, tools: true,
    }];
    const app = buildServer({
      config: CFG,
      providers: { or: { baseURL: "https://or.test/v1", auth: "bearer", quirks: "openrouter", resetProfile: { kind: "daily-utc-midnight" }, apiKey: "k" } },
      aliases: BUILT_IN_ALIASES,
      registry,
      stateMap,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 })) as unknown as typeof fetch,
      usageMap,
      providerCaps: { or: { rpd: 1 } },
    });

    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(stateMap.get("or::m1")).toMatchObject({ state: "exhausted", reason: "daily-cap" });
    expect(stateMap.get("pool::or")).toMatchObject({ state: "exhausted", reason: "pool" });
  });
});
```

Note: `fs`, `os`, `path` are already imported at the top of this file; add the import line only if missing. The unused temp-dir imports from the earlier draft are not needed — do not include them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/server.test.ts`
Expected: FAIL — `stateMap.has("pool::or")` is false.

- [ ] **Step 3: Implement**

`src/usage.ts` — extend the state import and add after `maybeExhaust`:

```typescript
import { nextUtcMidnight, setState, poolKey, type StateMap } from "./state.js";
```

```typescript
export function maybeExhaustProvider(states: StateMap, provider: string, view: BudgetView, now: number): void {
  if (!fitsBudget(view, 1, now)) {
    setState(states, poolKey(provider), {
      state: "exhausted",
      until: nextUtcMidnight(now),
      reason: "pool",
    });
  }
}
```

`src/server.ts` — import it and wire two places.

Import line becomes:

```typescript
import { aggregateProvider, maybeExhaust, maybeExhaustProvider, recordUsage } from "./usage.js";
```

Inside the request handler, add a lazy-expiring provider-state view next to `liveState`:

```typescript
    const liveProviderState = (provider: string) => {
      const ms = deps.stateMap.get(`pool::${provider}`);
      if (!ms) return undefined;
      if ((ms.state === "cooldown" || ms.state === "exhausted") && ms.until <= Date.now()) {
        return { state: "ok" } as const;
      }
      return ms;
    };
```

Pass it into `resolve()`'s ctx object:

```typescript
          getUsage: (id) => usageMap.get(id),
          getProviderCaps: (p) => providerCaps[p],
          getProviderState: liveProviderState,
          now: Date.now(),
```

Replace `recordServed`'s exhaustion tail:

```typescript
    function recordServed(entry: RegistryEntry, real?: { tokensIn: number; tokensOut: number }) {
      const now = Date.now();
      recordUsage(usageMap, entry.id, {
        requests: 1,
        tokensIn: real?.tokensIn ?? estTokens,
        tokensOut: real?.tokensOut ?? 0,
      }, now);
      const view = {
        rec: usageMap.get(entry.id),
        modelCaps: entry.limits,
        provTotals: aggregateProvider(usageMap, entry.provider),
        provCaps: providerCaps[entry.provider],
      };
      maybeExhaust(deps.stateMap, entry.id, view, now);
      if (providerCaps[entry.provider]) {
        maybeExhaustProvider(deps.stateMap, entry.provider, view, now);
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/server.test.ts && npm test && npm run build`
Expected: all PASS; build clean.

- [ ] **Step 5: Commit**

```powershell
git add src/usage.ts src/server.ts test/integration/server.test.ts
git commit -m "feat: reactive and proactive provider-pool exhaustion wired into server"
```

---

### Task 6: Status — pool summary lines and reason columns

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/unit/cli.test.ts` (replace pool-column describe; add new describes)

**Interfaces:**
- Consumes: `poolKey`, `effective`, `aggregateProvider` (Tasks 1/5); reason fields on `ModelState`.
- Produces:
  - `formatStatusRow(e, msRaw, now, usage?)` — signature SHRINKS by two params (pool fragments moved out).
  - `formatPoolLine(provider: string, caps: DailyCaps, totals: ProviderTotals, msRaw: ModelState, modelCount: number, now: number): string`
  - `printStatus()` groups rows under providers; pooled providers get one `[pool] …` header line; model rows indented two spaces.
  - Acceptance: output visually distinguishes pools (one line per pooled provider) from per-model rows.

- [ ] **Step 1: Rewrite the affected cli tests FIRST (they encode the new contract)**

In `test/unit/cli.test.ts` DELETE the entire `describe("formatStatusRow provider pool column", ...)` block and ADD:

```typescript
describe("reason rendering", () => {
  it("shows cooldown reason next to remaining minutes", () => {
    const ms: ModelState = { state: "cooldown", until: NOW + 180_000, reason: "peak-throttle" };
    expect(formatStatusRow(E, ms, NOW)).toContain("cooldown 3m (peak-throttle)");
  });
  it("defaults gracefully when reason absent (legacy snapshots)", () => {
    const ms: ModelState = { state: "cooldown", until: NOW + 60_000 };
    expect(formatStatusRow(E, ms, NOW)).toContain("cooldown 1m");
  });
  it("shows exhausted reason before the reset timestamp", () => {
    const ms: ModelState = { state: "exhausted", until: Date.UTC(2026, 7, 25, 0, 0, 0), reason: "pool" };
    expect(formatStatusRow(E, ms, NOW)).toContain("exhausted (pool) until 2026-08-25T00:00Z");
  });
  it("renders retired with since timestamp", () => {
    const ms: ModelState = { state: "retired", since: Date.UTC(2026, 7, 24, 9, 30, 0) };
    expect(formatStatusRow(E, ms, NOW)).toContain("retired since 2026-08-24T09:30Z");
  });
});

describe("formatPoolLine", () => {
  const TOTALS = { requests: 23, tokensIn: 70, tokensOut: 5 };
  it("renders request-based pools with shared-by count", () => {
    const line = formatPoolLine("openrouter", { rpd: 50 }, TOTALS, { state: "ok" }, 12, NOW);
    expect(line).toContain("[pool] openrouter");
    expect(line).toContain("req 23/50");
    expect(line).toContain("shared by 12 models");
  });
  it("renders token-based pools", () => {
    const line = formatPoolLine("cerebras", { tpd: 1000000 },
      { requests: 2, tokensIn: 900000, tokensOut: 100000 }, { state: "ok" }, 3, NOW);
    expect(line).toContain("tok 1M/1M");
  });
  it("shows exhausted state with UTC reset time", () => {
    const ms: ModelState = { state: "exhausted", until: Date.UTC(2026, 7, 25, 0, 0, 0), reason: "pool" };
    const line = formatPoolLine("openrouter", { rpd: 50 },
      { requests: 50, tokensIn: 0, tokensOut: 0 }, ms, 12, NOW);
    expect(line).toContain("exhausted · resets 00:00 UTC");
  });
  it("singularizes a single shared model", () => {
    const line = formatPoolLine("x", { rpd: 5 },
      { requests: 0, tokensIn: 0, tokensOut: 0 }, { state: "ok" }, 1, NOW);
    expect(line).toContain("shared by 1 model ");
  });
});
```

Update the top import to include `formatPoolLine`:

```typescript
import { formatStatusRow, formatPoolLine, runCli, noProvidersHint } from "../../src/cli.js";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/cli.test.ts`
Expected: FAIL — `formatPoolLine` not exported; reason strings absent; `formatStatusRow` still accepts old args.

- [ ] **Step 3: Implement in `src/cli.ts`**

New imports (add `poolKey`, `effective` from state.js — `effective` already imported; extend):

```typescript
import { loadState, effective, bindStateFile, poolKey } from "./state.js";
```

Replace `formatStatusRow`:

```typescript
export function formatStatusRow(
  e: RegistryEntry,
  msRaw: ModelState,
  now: number,
  usage?: UsageRecord,
): string {
  const ms = effective(msRaw, now);
  let state: string;
  if (ms.state === "ok") {
    state = "ok";
  } else if (ms.state === "cooldown") {
    const why = ms.reason ? ` (${ms.reason})` : "";
    state = `cooldown ${Math.max(0, Math.round((ms.until - now) / 60_000))}m${why}`;
  } else if (ms.state === "exhausted") {
    const why = ms.reason ? ` (${ms.reason}) ` : " ";
    state = `exhausted${why}until ${new Date(ms.until).toISOString().slice(0, 16)}Z`;
  } else {
    state = `retired since ${new Date(ms.since).toISOString().slice(0, 16)}Z`;
  }
  const parts: string[] = [];
  if (e.limits && usage) {
    if (e.limits.rpd) parts.push(`req ${usage.requests}/${fmtCompact(e.limits.rpd)}`);
    if (e.limits.tpd) {
      parts.push(`tok ${fmtCompact(usage.tokensIn + usage.tokensOut)}/${fmtCompact(e.limits.tpd)}`);
    }
  }
  const usageCol = parts.length > 0 ? parts.join(" · ") : "req -";
  return [
    e.id.padEnd(50),
    `t${e.tier}`,
    e.speed.padEnd(7),
    e.tools ? "tools" : "-",
    String(e.context).padStart(7),
    state.padEnd(34),
    usageCol.padEnd(18),
    e.tags.join(","),
  ].join("  ");
}
```

Add `formatPoolLine` below it:

```typescript
export function formatPoolLine(
  provider: string,
  caps: DailyCaps,
  totals: ProviderTotals,
  msRaw: ModelState,
  modelCount: number,
  now: number,
): string {
  const ms = effective(msRaw, now);
  let spent: string;
  if (caps.rpd) {
    spent = `req ${totals.requests}/${fmtCompact(caps.rpd)}`;
  } else {
    spent = `tok ${fmtCompact(totals.tokensIn + totals.tokensOut)}/${fmtCompact(caps.tpd ?? 0)}`;
  }
  // UTC-midnight rollover for every pool profile, so ok pools always read 00:00.
  const resetAt = ms.state === "exhausted" ? new Date(ms.until).toISOString().slice(11, 16) : "00:00";
  const st = ms.state === "ok" || ms.state === "exhausted" ? ms.state : String(ms.state);
  return [
    `[pool] ${provider.padEnd(12)}`,
    spent.padEnd(10),
    `${st} · resets ${resetAt} UTC`,
    `shared by ${modelCount} model${modelCount === 1 ? "" : "s"}`,
  ].join("  ");
}
```

Rewrite `printStatus()` grouping:

```typescript
async function printStatus(): Promise<void> {
  const cfg = loadConfig(defaultConfigPath());
  const env = loadEnv(defaultEnvPath(), process.env as Record<string, string | undefined>);
  const providers = activeProviders(cfg, env);
  const states = loadState(defaultStatePath());
  const usageMap = loadUsage(defaultUsagePath());
  const providerCount = Object.keys(providers).length;
  console.log(`freeroll status - ${providerCount}/6 providers have keys`);
  if (providerCount === 0) {
    console.log("");
    for (const line of noProvidersHint()) console.log(line);
    return;
  }
  console.log("");
  const providerCaps = mergedProviderCaps(cfg);
  const groups = new Map<string, RegistryEntry[]>();
  for (const entry of applyModelLimits(REGISTRY, cfg.modelLimits)) {
    if (!providers[entry.provider]) continue;
    const list = groups.get(entry.provider) ?? [];
    list.push(entry);
    groups.set(entry.provider, list);
  }
  const now = Date.now();
  for (const [provider, entries] of groups) {
    const caps = providerCaps[provider];
    if (caps) {
      console.log(formatPoolLine(
        provider, caps, aggregateProvider(usageMap, provider),
        states.get(poolKey(provider)) ?? { state: "ok" }, entries.length, now,
      ));
    }
    for (const entry of entries) {
      console.log("  " + formatStatusRow(entry, states.get(entry.id) ?? { state: "ok" }, now, usageMap.get(entry.id)));
    }
    console.log("");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/cli.test.ts && npm test && npm run build`
Expected: PASS everywhere (the earlier usage-column tests don't pass pool params; smoke/cli integration unaffected).

- [ ] **Step 5: Manual visual check**

Run: `node dist/cli.js status`
Expected: pooled providers show one `[pool] …` line above their indented model rows; non-pooled providers show model rows only.

- [ ] **Step 6: Commit**

```powershell
git add src/cli.ts test/unit/cli.test.ts
git commit -m "feat: status distinguishes provider pools and shows failure reasons"
```

---

### Task 7: `freeroll revive` command

**Files:**
- Modify: `src/cli.ts`
- Modify: `README.md`
- Modify: `test/unit/cli.test.ts` (append)

**Interfaces:**
- Consumes: `reviveMatching`, `loadState`, `bindStateFile`, `defaultStatePath` (Task 1 / config).
- Produces: `reviveCmd(target: string, statePath: string): { removed: string[] }` — exported, pure-ish (does its own persistence via `bindStateFile`). CLI: `freeroll revive <model-id | provider-name>` exits 0; missing arg prints usage, exits 64.

- [ ] **Step 1: Write failing tests**

Append to `test/unit/cli.test.ts`:

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviveCmd } from "../../src/cli.js";
import { loadState, bindStateFile, setState, retireModel } from "../../src/state.js";

describe("reviveCmd", () => {
  it("clears matching model and pool entries and persists", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-revive-")), "state.json");
    const map = new Map();
    retireModel(map, "or::a", Date.now());
    setState(map, "pool::openrouter", { state: "exhausted", until: Date.now() + 9, reason: "pool" });
    saveTmp(file, map);

    bindStateFile(file);
    const { removed } = reviveCmd("openrouter", file);
    bindStateFile(null);

    expect(removed).toEqual(["pool::openrouter"]);
    expect(loadState(file).has("pool::openrouter")).toBe(false);
    expect(loadState(file).has("or::a")).toBe(true);
  });

  it("reports nothing matched", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-revive2-")), "state.json");
    expect(reviveCmd("ghost", file).removed).toEqual([]);
  });
});

function saveTmp(file: string, map: Map<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(map)));
}
```

And extend the arg-routing describe:

```typescript
  it("revive without argument returns 64", async () => {
    expect(await runCli(["revive"])).toBe(64);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/cli.test.ts`
Expected: FAIL — `reviveCmd` not exported; routing lacks `revive`.

- [ ] **Step 3: Implement**

`src/cli.ts` imports add `bindStateFile` (already there), `reviveMatching`:

```typescript
import { loadState, effective, bindStateFile, poolKey, reviveMatching } from "./state.js";
```

Add exported command helper:

```typescript
export function reviveCmd(target: string, statePath: string): { removed: string[] } {
  const map = loadState(statePath);
  bindStateFile(statePath);
  const removed = reviveMatching(map, target);
  bindStateFile(null);
  return { removed };
}
```

Wire into `runCli` before the fallthrough:

```typescript
  if (cmd === "revive") {
    const target = argv[1];
    if (!target) {
      process.stderr.write("usage: freeroll revive <model-id | provider-name>\n");
      return 64;
    }
    const { removed } = reviveCmd(target, defaultStatePath());
    if (removed.length === 0) console.log(`nothing matched '${target}'`);
    else for (const id of removed) console.log(`revived ${id}`);
    return 0;
  }
```

Update the generic usage line to `[serve|status|revive|setup]`? — setup arrives in a later phase plan; here use `[serve|status|revive]`.

README: in "Status" section append:

```markdown
Pooled providers appear once as a `[pool] …` line shared by their models;
per-model rows carry reason codes (`cooldown 3m (peak-throttle)`,
`exhausted (pool) until …`, `retired since …`). Clear stuck state with
`freeroll revive <model-id>` (or a bare provider name to unblock a pool).
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/cli.test.ts && npm test && npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```powershell
git add src/cli.ts README.md test/unit/cli.test.ts
git commit -m "feat: freeroll revive clears retired/exhausted state"
```

---

## Completion checklist (Plan A)

- [ ] `npm test` green; `npm run build` clean.
- [ ] Acceptance: unit test proves pool-exhaustion routes to a non-pool provider with zero sibling attempts (Task 3 test 1).
- [ ] Acceptance: `status` visually separates `[pool]` lines from per-model rows (Task 6).
- [ ] Integration coverage exists for every failure class: pool-exhausted (T3), daily-cap (T3), retired (T3), transient retry/move-on (T3), rate cooldown (T3), bad_request pre-existing; MalformedOutput lives in Plan B.
