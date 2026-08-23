# Quota Harvest Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track per-model daily request/token usage locally, skip models whose remaining daily caps cannot fit the request, and rotate same-tier candidates by remaining headroom — so pooled free-tier capacity is spent deliberately instead of burning out one model by mid-morning.

**Architecture:** A new `src/usage.ts` persists daily counters to `~/.freeroll/usage.json` (atomic tmp+rename, lazy UTC rollover, no timers — same patterns as `state.ts`). Caps live at two levels: provider pools (`providers.json`, e.g. OpenRouter's account-wide 50/day) and per-model (`registry.json`, e.g. Gemini free-tier daily request caps). `router.resolve()` gains a harvest mode that filters budget-dead candidates and inserts headroom as the second sort key. The server records usage after every served response (exact from `usage` fields when available, estimated input otherwise) and marks fully-spent models exhausted until UTC midnight.

**Tech Stack:** TypeScript (strict, ESM, Node >= 20), Fastify, vitest (fully offline — upstreams are injected `fetch` mocks).

**Spec:** `docs/superpowers/specs/2026-08-23-quota-harvest-design.md`

## Global Constraints

- Node >= 20; TypeScript strict; ESM (`"type": "module"`); imports of local src files end in `.js`.
- Tests are fully offline: never hit real provider APIs; inject fake `fetchImpl`.
- No timers anywhere: day rollover is lazy-checked on access (project pattern).
- File persistence uses write-to-tmp + `renameSync` atomic replace (pattern in `state.ts`).
- Comments are sparse and explain *why* — match that style.
- Commit messages follow repo convention: `feat:`, `fix:`, `docs:`, `test:` prefixes, imperative mood.
- Shell is Windows PowerShell: `$env:X="y"` not `set X=y`; chain with `if ($?) { }`.
- Full suite: `npm test`. Single file: `npx vitest run <file>`. Build check: `npm run build`.

## Deviations from spec (intentional)

1. Spec §4 return-shape change (`resolve()` → `{candidates, skippedByBudget}`) requires updating all existing call sites/tests — enumerated explicitly in Task 4.
2. `RequestCtx` gains optional `now?: number` so tests pin time instead of mocking clocks (spec silent on determinism).
3. `buildServer` deps gain optional `usageMap?`/`providerCaps?` with safe defaults so existing integration tests compile unchanged (spec silent).

## File Structure (final state)

| File | Responsibility |
|---|---|
| `src/types.ts` | + `DailyCaps`, `UsageRecord`, `UsageMap`; `limits?` on defs; ctx extensions |
| `src/usage.ts` (new) | usage persistence, rollover, aggregation, budget math, exhaustion hook |
| `src/state.ts` | + `setState()` helper (set + persist-if-bound) |
| `src/router.ts` | harvest filter + within-group rotation in `resolve()` |
| `src/catalog.ts` | validators accept `limits`; `applyModelLimits()` |
| `src/providers.json` | pool seeds: openrouter/groq/cerebras |
| `src/registry.json` | per-model seeds: 3 google entries |
| `src/config.ts` | + `harvest`, `modelLimits`, `providerLimits`; `defaultUsagePath()`; `mergedProviderCaps()` |
| `src/sse.ts` | + `sseUsageCapture()` passthrough transform |
| `src/server.ts` | wiring: resolve result, recording, 503 enrichment |
| `src/cli.ts` | status spend columns; serve binds usage file |
| `README.md` | harvest documentation |

---

### Task 1: Usage types + tracker module

**Files:**
- Modify: `src/types.ts`
- Create: `src/usage.ts`
- Test: `test/unit/usage.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (exact names later tasks rely on):
  - types: `DailyCaps { rpd?: number; tpd?: number }`, `UsageRecord { day: string; requests: number; tokensIn: number; tokensOut: number }`, `type UsageMap = Map<string, UsageRecord>`
  - usage module: `UsageDelta { requests?: number; tokensIn?: number; tokensOut?: number }`, `utcDayKey(now: number): string`, `freshRecord(day: string): UsageRecord`, `loadUsage(file: string, now?: number): UsageMap`, `saveUsage(file: string, map: UsageMap): void`, `bindUsageFile(file: string | null): void`, `recordUsage(map: UsageMap, id: string, delta: UsageDelta, now?: number): void`, `aggregateProvider(map: UsageMap, provider: string): { requests: number; tokensIn: number; tokensOut: number }`

- [ ] **Step 1: Write failing tests**

Create `test/unit/usage.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  utcDayKey, freshRecord, loadUsage, saveUsage, bindUsageFile,
  recordUsage, aggregateProvider, type UsageMap,
} from "../../src/usage.js";

const T0 = Date.UTC(2026, 7, 23, 10, 0, 0);
const NEXT_DAY = Date.UTC(2026, 7, 24, 0, 0, 1);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "freeroll-usage-"));
  bindUsageFile(null);
});

describe("utcDayKey", () => {
  it("formats UTC YYYY-MM-DD", () => {
    expect(utcDayKey(T0)).toBe("2026-08-23");
  });
});

describe("freshRecord", () => {
  it("zeroes counters for a day", () => {
    expect(freshRecord("2026-08-23")).toEqual({ day: "2026-08-23", requests: 0, tokensIn: 0, tokensOut: 0 });
  });
});

describe("recordUsage", () => {
  it("accumulates deltas under the model id", () => {
    const map: UsageMap = new Map();
    recordUsage(map, "a::m", { requests: 1, tokensIn: 100 }, T0);
    recordUsage(map, "a::m", { requests: 1, tokensIn: 50, tokensOut: 20 }, T0);
    expect(map.get("a::m")).toEqual({ day: "2026-08-23", requests: 2, tokensIn: 150, tokensOut: 20 });
  });

  it("lazily rolls over on a new UTC day instead of accumulating", () => {
    const map: UsageMap = new Map();
    recordUsage(map, "a::m", { requests: 5, tokensIn: 9999 }, T0);
    recordUsage(map, "a::m", { requests: 1 }, NEXT_DAY);
    expect(map.get("a::m")).toEqual({ day: "2026-08-24", requests: 1, tokensIn: 0, tokensOut: 0 });
  });

  it("persists through bindUsageFile and reloads", () => {
    const file = path.join(dir, "nested", "usage.json");
    bindUsageFile(file);
    const map: UsageMap = new Map();
    recordUsage(map, "a::m", { requests: 3, tokensIn: 10, tokensOut: 4 }, T0);
    expect(fs.existsSync(file)).toBe(true);
    expect(loadUsage(file, T0).get("a::m")).toEqual({ day: "2026-08-23", requests: 3, tokensIn: 10, tokensOut: 4 });
  });
});

describe("loadUsage", () => {
  it("returns empty map when file missing", () => {
    expect(loadUsage(path.join(dir, "nope.json"), T0).size).toBe(0);
  });

  it("drops stale-day records on load", () => {
    const file = path.join(dir, "usage.json");
    saveUsage(file, new Map([["a::m", { day: "2026-08-22", requests: 9, tokensIn: 9, tokensOut: 9 }]]));
    expect(loadUsage(file, T0).has("a::m")).toBe(false);
  });

  it("starts fresh on corrupt JSON", () => {
    const file = path.join(dir, "usage.json");
    fs.writeFileSync(file, "{not json");
    expect(loadUsage(file, T0).size).toBe(0);
  });

  it("ignores malformed records instead of throwing", () => {
    const file = path.join(dir, "usage.json");
    fs.writeFileSync(file, JSON.stringify({ "a::m": { day: "2026-08-23" }, "b::n": 5 }));
    const map = loadUsage(file, T0);
    expect(map.size).toBe(0);
  });
});

describe("aggregateProvider", () => {
  it("sums usage across all models of one provider only", () => {
    const map: UsageMap = new Map([
      ["groq::a", { day: "2026-08-23", requests: 2, tokensIn: 100, tokensOut: 10 }],
      ["groq::b", { day: "2026-08-23", requests: 3, tokensIn: 50, tokensOut: 5 }],
      ["openrouter::c", { day: "2026-08-23", requests: 100, tokensIn: 9999, tokensOut: 99 }],
    ]);
    expect(aggregateProvider(map, "groq")).toEqual({ requests: 5, tokensIn: 150, tokensOut: 15 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/usage.test.ts`
Expected: FAIL — `Cannot find module '../../src/usage.js'` (or TS equivalent)

- [ ] **Step 3: Implement**

In `src/types.ts`, add after the `Failure`/`ResetProfile` interfaces:

```typescript
export interface DailyCaps {
  rpd?: number;
  tpd?: number;
}

export interface UsageRecord {
  day: string; // "YYYY-MM-DD" (UTC) this record belongs to
  requests: number;
  tokensIn: number;
  tokensOut: number;
}

export type UsageMap = Map<string, UsageRecord>;
```

Create `src/usage.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import type { UsageMap, UsageRecord } from "./types.js";

export interface UsageDelta {
  requests?: number;
  tokensIn?: number;
  tokensOut?: number;
}

let usageFile: string | null = null;

export function bindUsageFile(file: string | null): void {
  usageFile = file;
}

export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function freshRecord(day: string): UsageRecord {
  return { day, requests: 0, tokensIn: 0, tokensOut: 0 };
}

function rolled(rec: UsageRecord | undefined, now: number): UsageRecord {
  const day = utcDayKey(now);
  if (!rec || rec.day !== day) return freshRecord(day);
  return rec;
}

export function saveUsage(file: string, map: UsageMap): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map), null, 2));
  fs.renameSync(tmp, file);
}

function isUsageRecord(v: unknown): v is UsageRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.day === "string" &&
    typeof r.requests === "number" &&
    typeof r.tokensIn === "number" &&
    typeof r.tokensOut === "number"
  );
}

export function loadUsage(file: string, now: number = Date.now()): UsageMap {
  const map: UsageMap = new Map();
  if (!fs.existsSync(file)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const day = utcDayKey(now);
    for (const [id, rec] of Object.entries(raw)) {
      // stale days are dropped on sight — counters only ever describe today
      if (isUsageRecord(rec) && rec.day === day) map.set(id, rec);
    }
  } catch {
    // corrupt snapshot: start fresh
  }
  return map;
}

export function recordUsage(
  map: UsageMap,
  id: string,
  delta: UsageDelta,
  now: number = Date.now(),
): void {
  const rec = rolled(map.get(id), now);
  rec.requests += delta.requests ?? 0;
  rec.tokensIn += delta.tokensIn ?? 0;
  rec.tokensOut += delta.tokensOut ?? 0;
  map.set(id, rec);
  if (usageFile) saveUsage(usageFile, map);
}

export interface ProviderTotals {
  requests: number;
  tokensIn: number;
  tokensOut: number;
}

export function aggregateProvider(map: UsageMap, provider: string): ProviderTotals {
  const prefix = `${provider}::`;
  const totals: ProviderTotals = { requests: 0, tokensIn: 0, tokensOut: 0 };
  for (const [id, rec] of map) {
    if (!id.startsWith(prefix)) continue;
    totals.requests += rec.requests;
    totals.tokensIn += rec.tokensIn;
    totals.tokensOut += rec.tokensOut;
  }
  return totals;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/usage.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```powershell
git add src/types.ts src/usage.ts test/unit/usage.test.ts
git commit -m "feat: daily usage tracker with lazy UTC rollover and provider aggregation"
```

---

### Task 2: Budget math + proactive exhaustion

**Files:**
- Modify: `src/usage.ts`, `src/state.ts`
- Test: `test/unit/usage.test.ts` (append), `test/unit/state.test.ts` (append one case)

**Interfaces:**
- Consumes: Task 1's types/functions.
- Produces:
  - `usage.ts`: `BudgetView { rec?, modelCaps?, provTotals?, provCaps? }`, `usedFraction(view: BudgetView, now: number): number`, `fitsBudget(view: BudgetView, estTokens: number, now: number): boolean`, `maybeExhaust(states: StateMap, id: string, view: BudgetView, now: number): void`
  - `state.ts`: `setState(map: StateMap, id: string, ms: ModelState): void`

- [ ] **Step 1: Write failing tests**

Append to `test/unit/usage.test.ts` (add `fitsBudget, maybeExhaust, usedFraction, type BudgetView` to the import list from `../../src/usage.js`, and `type DailyCaps` from `../../src/types.js`):

```typescript
import { effective } from "../../src/state.js";

const CAPS_BOTH: DailyCaps = { rpd: 100, tpd: 1000 };

describe("usedFraction", () => {
  it("is 0 without caps or records", () => {
    expect(usedFraction({}, T0)).toBe(0);
    expect(usedFraction({ modelCaps: CAPS_BOTH }, T0)).toBe(0);
  });

  it("takes the max over seeded dimensions", () => {
    const view: BudgetView = {
      rec: { day: "2026-08-23", requests: 50, tokensIn: 900, tokensOut: 0 },
      modelCaps: CAPS_BOTH,
    };
    expect(usedFraction(view, T0)).toBe(0.9); // tokens dominate over 50% requests
  });

  it("pools provider usage with model usage", () => {
    const view: BudgetView = {
      rec: { day: "2026-08-23", requests: 10, tokensIn: 0, tokensOut: 0 },
      provTotals: { requests: 40, tokensIn: 0, tokensOut: 0 },
      provCaps: { rpd: 100 },
    };
    // model alone 10%, provider pool alone 40% -> max wins
    expect(usedFraction(view, T0)).toBeCloseTo(0.49); // (10+40)/100 via combined check below
  });
});
```

Correction — pooled fraction must not double-count the served request. Define it precisely instead: `usedFraction = max(modelOnlyFrac, providerPoolFrac)` where `providerPoolFrac` uses ONLY `provTotals`. Rewrite that third case as:

```typescript
  it("max of model-only and provider-pool fractions", () => {
    const view: BudgetView = {
      rec: { day: "2026-08-23", requests: 10, tokensIn: 0, tokensOut: 0 },
      provTotals: { requests: 40, tokensIn: 0, tokensOut: 0 },
      provCaps: { rpd: 100 },
    };
    expect(usedFraction(view, T0)).toBeCloseTo(0.4); // pool dominates model-only 0.1
  });
```

Append budget/exhaustion cases:

```typescript
describe("fitsBudget", () => {
  it("true when no caps at any level", () => {
    expect(fitsBudget({}, 5000, T0)).toBe(true);
  });

  it("false when remaining rpd < 1", () => {
    const view: BudgetView = {
      rec: { day: "2026-08-23", requests: 50, tokensIn: 0, tokensOut: 0 },
      modelCaps: { rpd: 50 },
    };
    expect(fitsBudget(view, 1, T0)).toBe(false);
  });

  it("false when remaining tpd < estimated tokens", () => {
    const view: BudgetView = {
      rec: { day: "2026-08-23", requests: 0, tokensIn: 990, tokensOut: 0 },
      modelCaps: CAPS_BOTH,
    };
    expect(fitsBudget(view, 11, T0)).toBe(false);
    expect(fitsBudget(view, 10, T0)).toBe(true);
  });

  it("respects provider pool even when model has headroom", () => {
    const view: BudgetView = {
      rec: { day: "2026-08-23", requests: 0, tokensIn: 0, tokensOut: 0 },
      provTotals: { requests: 50, tokensIn: 0, tokensOut: 0 },
      provCaps: { rpd: 50 },
    };
    expect(fitsBudget(view, 1, T0)).toBe(false);
  });
});

describe("maybeExhaust", () => {
  it("marks exhausted until UTC midnight when fully spent", () => {
    const states = new Map();
    maybeExhaust(states, "a::m", {
      rec: { day: "2026-08-23", requests: 50, tokensIn: 0, tokensOut: 0 },
      modelCaps: { rpd: 50 },
    }, T0);
    const ms = states.get("a::m");
    expect(ms.state).toBe("exhausted");
    expect(ms.until).toBe(Date.UTC(2026, 7, 24, 0, 0, 0));
  });

  it("leaves state alone when budget remains", () => {
    const states = new Map();
    maybeExhaust(states, "a::m", { modelCaps: { rpd: 50 } }, T0);
    expect(states.has("a::m")).toBe(false);
  });
});

describe("effective interplay", () => {
  it("treats exhausted state after rollover time as ok", () => {
    expect(effective({ state: "exhausted", until: NEXT_DAY - 1 }, NEXT_DAY)).toEqual({ state: "ok" });
  });
});
```

Also append to `test/unit/state.test.ts` a `setState` persistence case mirroring its existing `recordFailure` file-bound test style (read that file first and copy its temp-dir pattern exactly).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/usage.test.ts`
Expected: FAIL — `usedFraction` etc. not exported.

- [ ] **Step 3: Implement**

In `src/state.ts`, add after `recordFailure`:

```typescript
export function setState(map: StateMap, id: string, ms: ModelState): void {
  map.set(id, ms);
  if (stateFile) saveState(stateFile, map);
}
```

In `src/usage.ts`, add imports and the budget API:

```typescript
import { nextUtcMidnight, setState, type StateMap } from "./state.js";
import type { DailyCaps } from "./types.js";

export interface BudgetView {
  rec?: UsageRecord;
  modelCaps?: DailyCaps;
  provTotals?: Pick<UsageRecord, "requests" | "tokensIn" | "tokensOut">;
  provCaps?: DailyCaps;
}

export function usedFraction(view: BudgetView, now: number = Date.now()): number {
  const rec = rolled(view.rec, now);
  let frac = 0;
  if (view.modelCaps?.rpd) frac = Math.max(frac, rec.requests / view.modelCaps.rpd);
  if (view.modelCaps?.tpd) frac = Math.max(frac, (rec.tokensIn + rec.tokensOut) / view.modelCaps.tpd);
  if (view.provCaps?.rpd && view.provTotals) {
    frac = Math.max(frac, view.provTotals.requests / view.provCaps.rpd);
  }
  if (view.provCaps?.tpd && view.provTotals) {
    frac = Math.max(frac, (view.provTotals.tokensIn + view.provTotals.tokensOut) / view.provCaps.tpd);
  }
  return frac;
}

export function fitsBudget(view: BudgetView, estTokens: number, now: number = Date.now()): boolean {
  const rec = rolled(view.rec, now);
  const totals = {
    requests: rec.requests + (view.provTotals?.requests ?? 0),
    tokensIn: rec.tokensIn + view.provTotals?.tokensIn ?? ... // see correction
  };
}
```

Correction — do NOT sum model+provider totals (double-counts the served request, as caught in Step 1). The real implementation checks each level independently:

```typescript
export function fitsBudget(view: BudgetView, estTokens: number, now: number = Date.now()): boolean {
  const rec = rolled(view.rec, now);
  if (view.modelCaps?.rpd !== undefined && view.modelCaps.rpd - rec.requests < 1) return false;
  if (view.modelCaps?.tpd !== undefined && view.modelCaps.tpd - (rec.tokensIn + rec.tokensOut) < estTokens) {
    return false;
  }
  if (view.provCaps?.rpd !== undefined && view.provTotals &&
      view.provCaps.rpd - view.provTotals.requests < 1) {
    return false;
  }
  if (view.provCaps?.tpd !== undefined && view.provTotals &&
      view.provCaps.tpd - (view.provTotals.tokensIn + view.provTotals.tokensOut) < estTokens) {
    return false;
  }
  return true;
}

export function maybeExhaust(states: StateMap, id: string, view: BudgetView, now: number): void {
  if (!fitsBudget(view, 1, now)) {
    setState(states, id, { state: "exhausted", until: nextUtcMidnight(now) });
  }
}
```

(Delete the incorrect `totals` sketch entirely; ship only the corrected `fitsBudget`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/usage.test.ts test/unit/state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/usage.ts src/state.ts test/unit/usage.test.ts test/unit/state.test.ts
git commit -m "feat: budget math with pooled provider caps and proactive exhaustion"
```

---

### Task 3: Caps plumbing — validators, seeds, config

**Files:**
- Modify: `src/types.ts` (limits on defs), `src/catalog.ts`, `src/providers.json`, `src/registry.json`, `src/config.ts`
- Test: `test/unit/catalog.test.ts` (append), `test/unit/config.test.ts` (append)

**Interfaces:**
- Consumes: `DailyCaps` from Task 1.
- Produces:
  - `ProviderDef.limits?: DailyCaps`; `RegistryEntry.limits?: DailyCaps`
  - `catalog.ts`: `applyModelLimits(registry: RegistryEntry[], overrides?: Record<string, Partial<DailyCaps>> | undefined): RegistryEntry[]`
  - `config.ts`: `AppConfig.harvest: boolean`, `AppConfig.modelLimits: Record<string, Partial<DailyCaps>>`, `AppConfig.providerLimits: Record<string, Partial<DailyCaps>>`, `defaultUsagePath(): string`, `mergedProviderCaps(cfg: AppConfig): Record<string, DailyCaps>`

- [ ] **Step 1: Write failing tests**

Append to `test/unit/catalog.test.ts`:

```typescript
import { applyModelLimits } from "../../src/catalog.js";

describe("applyModelLimits", () => {
  it("merges per-field overrides over seeded limits", () => {
    const reg = [{ ...REGISTRY[0], limits: { rpd: 50, tpd: 1000 } }];
    const out = applyModelLimits(reg, { [REGISTRY[0].id]: { tpd: 2000 } });
    expect(out[0].limits).toEqual({ rpd: 50, tpd: 2000 });
  });

  it("adds limits to entries without them", () => {
    const entry = REGISTRY.find((e) => !e.limits)!;
    const out = applyModelLimits([entry], { [entry.id]: { rpd: 7 } });
    expect(out[0].limits).toEqual({ rpd: 7 });
  });

  it("ignores unknown ids and returns entries unchanged when no overrides", () => {
    expect(applyModelLimits(REGISTRY, { "nope::x": { rpd: 1 } })).toEqual(REGISTRY);
    expect(applyModelLimits(REGISTRY)).toEqual(REGISTRY);
  });
});

describe("seeded caps", () => {
  it("openrouter pool is account-wide 50/day; google models have per-model rpd", () => {
    expect(PROVIDERS.openrouter.limits).toEqual({ rpd: 50 });
    expect(PROVIDERS.groq.limits?.rpd).toBeGreaterThan(0);
    expect(PROVIDERS.cerebras.limits?.tpd).toBeGreaterThan(0);
    expect(REGISTRY.find((e) => e.id === "google::gemini-2.5-pro")!.limits!.rpd).toBeGreaterThan(0);
  });
});
```

Append to `test/unit/config.test.ts` (match its existing temp-file patterns):

```typescript
describe("harvest config", () => {
  it("defaults harvest on with empty override maps", () => {
    const cfg = loadConfig(null);
    expect(cfg.harvest).toBe(true);
    expect(cfg.modelLimits).toEqual({});
    expect(cfg.providerLimits).toEqual({});
  });

  it("parses harvest off and limit overrides", () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({
      harvest: false,
      modelLimits: { "google::gemini-2.5-pro": { rpd: 5 } },
      providerLimits: { openrouter: { rpd: 1000 } },
    }));
    const cfg = loadConfig(file);
    expect(cfg.harvest).toBe(false);
    expect(cfg.modelLimits["google::gemini-2.5-pro"]).toEqual({ rpd: 5 });
    expect(cfg.providerLimits.openrouter).toEqual({ rpd: 1000 });
  });

  it("mergedProviderCaps overlays config onto provider seeds per-field", () => {
    const cfg = loadConfig(null);
    cfg.providerLimits = { openrouter: { rpd: 1000 } };
    const caps = mergedProviderCaps(cfg);
    expect(caps.openrouter).toEqual({ rpd: 1000 }); // seed had only rpd anyway
    expect(caps.groq).toEqual(PROVIDERS.groq.limits);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/catalog.test.ts test/unit/config.test.ts`
Expected: FAIL — missing exports / fields.

- [ ] **Step 3: Implement**

`src/types.ts` — add `limits?: DailyCaps;` to both `ProviderDef` and `RegistryEntry`.

`src/catalog.ts` — add this helper and call it from both validators:

```typescript
function validCaps(v: unknown): boolean {
  if (v === undefined) return true;
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    (c.rpd === undefined || (typeof c.rpd === "number" && c.rpd > 0)) &&
    (c.tpd === undefined || (typeof c.tpd === "number" && c.tpd > 0))
  );
}
```

- in `isProviderDef`: add `if (!validCaps(d.limits)) return false;`
- in `isRegistryEntry`: add `if (!validCaps(e.limits)) return false;`

Add at the end of `src/catalog.ts`:

```typescript
export function applyModelLimits(
  registry: RegistryEntry[],
  overrides?: Record<string, Partial<NonNullable<RegistryEntry["limits"]>>>,
): RegistryEntry[] {
  if (!overrides) return registry;
  return registry.map((e) => {
    const o = overrides[e.id];
    if (!o) return e;
    return { ...e, limits: { ...e.limits, ...o } };
  });
}
```

`src/providers.json` — seeds (values as of 2026-08-23, see verification step):
- `"openrouter"` gains `"limits": { "rpd": 50 }`
- `"groq"` gains `"limits": { "rpd": 14400 }`
- `"cerebras"` gains `"limits": { "tpd": 1000000 }`

`src/registry.json` — per-model seeds:
- `google::gemini-2.5-pro`: `"limits": { "rpd": 100 }`
- `google::gemini-2.5-flash`: `"limits": { "rpd": 250 }`
- `google::gemini-2.0-flash`: `"limits": { "rpd": 200 }`

Mistral stays unseeded (monthly-token free tier → harvest-inert by design).

`src/config.ts`:
- import type `DailyCaps`.
- `AppConfig` gains `harvest: boolean; modelLimits: Record<string, Partial<DailyCaps>>; providerLimits: Record<string, Partial<DailyCaps>>;`
- new path helper:

```typescript
export function defaultUsagePath(): string {
  return path.join(os.homedir(), ".freeroll", "usage.json");
}
```

- in `loadConfig`, defaults gain `harvest: true, modelLimits: {}, providerLimits: {}`, and parsing gains:

```typescript
if (typeof raw.harvest === "boolean") cfg.harvest = raw.harvest;
if (raw.modelLimits && typeof raw.modelLimits === "object") {
  cfg.modelLimits = raw.modelLimits as AppConfig["modelLimits"];
}
if (raw.providerLimits && typeof raw.providerLimits === "object") {
  cfg.providerLimits = raw.providerLimits as AppConfig["providerLimits"];
}
```

- at end of file:

```typescript
// Provider pools are account/org-wide: every model under a provider shares one budget.
export function mergedProviderCaps(cfg: AppConfig): Record<string, DailyCaps> {
  const out: Record<string, DailyCaps> = {};
  for (const [name, def] of Object.entries(PROVIDERS)) {
    if (def.limits) out[name] = { ...def.limits };
  }
  for (const [name, o] of Object.entries(cfg.providerLimits)) {
    out[name] = { ...out[name], ...o };
  }
  return out;
}
```

- [ ] **Step 4: Verify seed values against provider docs**

These numbers drift. Verify against live docs and adjust if changed; append one evidence line per source to `docs/registry-notes.md` (existing pattern: date + URL + observed value):

1. OpenRouter daily requests — https://openrouter.ai/docs/api-reference/limits (expect 50/day base)
2. Groq org daily requests — https://console.groq.com/docs/rate-limits
3. Cerebras daily tokens — https://inference-docs.cerebras.ai/support/rate-limits
4. Google AI Studio per-model RPD — https://ai.google.dev/gemini-api/docs/rate-limits

If a value differs: update the JSON seed AND its test expectation together.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/catalog.test.ts test/unit/config.test.ts; if ($?) { npm run build }`
Expected: PASS, clean compile.

- [ ] **Step 6: Commit**

```powershell
git add src/types.ts src/catalog.ts src/providers.json src/registry.json src/config.ts test/unit/catalog.test.ts test/unit/config.test.ts docs/registry-notes.md
git commit -m "feat: seeded daily caps at provider-pool and per-model levels with config overrides"
```

---

### Task 4: Harvest routing in resolve()

**Files:**
- Modify: `src/router.ts`
- Test: `test/unit/router.test.ts` (update all call sites + new cases)

**Interfaces:**
- Consumes: `usedFraction`/`fitsBudget`/`BudgetView` (Task 2); `RequestCtx` extensions (Task 3 types).
- Produces:
  - `ResolveResult { candidates: RegistryEntry[]; skippedByBudget: RegistryEntry[] }`
  - `resolve(alias, aliases, registry, getState, ctx): ResolveResult` — **return type changes**

- [ ] **Step 1: Update existing tests for the new return shape**

In `test/unit/router.test.ts`, lines 31, 36, 42, 48, 54, 67 each become two lines:

```typescript
const resolved = resolve(...same args as before...);
const out = resolved.candidates;
```

Lines 59–60 become:

```typescript
const r1 = resolve("auto/any", BUILT_IN_ALIASES, REG, () => OK, CTX).candidates.map((x) => x.id);
const r2 = resolve("auto/any", BUILT_IN_ALIASES, REG, () => OK, CTX).candidates.map((x) => x.id);
```

Line 72 (`throws`) unchanged.

- [ ] **Step 2: Write failing harvest tests**

Append to `test/unit/router.test.ts`:

```typescript
const DAY = Date.UTC(2026, 7, 23, 10, 0, 0);
const recOf = (requests: number) => ({ day: "2026-08-23", requests, tokensIn: 0, tokensOut: 0 });

const LIMITED: RegistryEntry[] = [
  { ...REG[0], limits: { rpd: 100 } },
  { ...REG[1], limits: { rpd: 100 } },
  { ...REG[2], limits: { rpd: 100 } },
];

function harvestCtx(usage: Record<string, ReturnType<typeof recOf>>) {
  return {
    ...CTX,
    harvest: true,
    now: DAY,
    getUsage: (id: string) => usage[id],
  };
}

describe("harvest mode", () => {
  const usage = { "a::one": recOf(90), "b::two": recOf(5), "c::three": recOf(0) };

  it("orders tier asc then headroom asc within tier", () => {
    // a::one and c::three are tier 1; a::one at 90% vs c::three at 0%; b::two is tier 2
    const { candidates } = resolve("auto/any", BUILT_IN_ALIASES, LIMITED, () => OK, harvestCtx(usage));
    expect(candidates.map((x) => x.id)).toEqual(["c::three", "a::one", "b::two"]);
  });

  it("skips budget-dead candidates into skippedByBudget", () => {
    const ctx = harvestCtx({ ...usage, "c::three": recOf(100) });
    const { candidates, skippedByBudget } = resolve("auto/any", BUILT_IN_ALIASES, LIMITED, () => OK, ctx);
    expect(candidates.map((x) => x.id)).not.toContain("c::three");
    expect(skippedByBudget.map((x) => x.id)).toEqual(["c::three"]);
  });

  it("preferSpeed aliases keep speed primary with headroom secondary", () => {
    // b::two is fast+fresh; c::three medium-fresh beats a::one slow-spent
    const { candidates } = resolve("auto/fast", BUILT_IN_ALIASES, LIMITED, () => OK, harvestCtx(usage));
    expect(candidates.map((x) => x.speed)).toEqual(["fast", "medium", "slow"]);
  });

  it("treats unlimited models as full headroom (fraction 0)", () => {
    const mixed: RegistryEntry[] = [
      ...LIMITED,
      e({ id: "z::free", provider: "z", upstream: "free", tags: ["chat"], tier: 1 }),
    ];
    const { candidates } = resolve("auto/any", BUILT_IN_ALIASES, mixed, () => OK, harvestCtx(usage));
    expect(candidates[0].id).toBe("z::free");
  });

  it("provider pool exhaustion skips models with personal headroom", () => {
    const ctx = {
      ...harvestCtx(usage),
      getProviderCaps: (p: string) => (p === "a" ? { rpd: 90 } : undefined),
    };
    const { candidates, skippedByBudget } = resolve("auto/any", BUILT_IN_ALIASES, LIMITED, () => OK, ctx);
    expect(skippedByBudget.map((x) => x.id)).toEqual(["a::one"]); // pooled 90/90
    expect(candidates.map((x) => x.id)).toEqual(["c::three", "b::two"]);
  });
});

describe("harvest off parity", () => {
  it("ignores usage entirely and preserves legacy order", () => {
    const spent = { "a::one": recOf(100), "c::three": recOf(100), "b::two": recOf(100) };
    const out = resolve("auto/coding", BUILT_IN_ALIASES, REG, () => OK, {
      ...CTX, harvest: true, now: DAY, getUsage: (id) => spent[id],
    });
    expect(out.candidates.map((x) => x.id)).toEqual(["a::one", "b::two"]);
    expect(out.skippedByBudget).toEqual([]); // REG entries carry no limits -> inert
  });
});
```

Note the parity test uses un-limited `REG` — models without caps are never budget-skipped even when spent. This is the spec's harvest-inert rule.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/router.test.ts`
Expected: FAIL — `.candidates` undefined on array; harvest tests missing.

- [ ] **Step 4: Implement**

`src/types.ts` — extend `RequestCtx`:

```typescript
export interface RequestCtx {
  hasTools: boolean;
  estTokens: number;
  harvest?: boolean;
  getUsage?: (id: string) => import("./types.js").UsageRecord | undefined;
  getProviderCaps?: (provider: string) => import("./types.js").DailyCaps | undefined;
  now?: number;
}
```

(If `UsageRecord`/`DailyCaps` live in the same file, reference them directly instead of `import()`.)

`src/router.ts` — full replacement of `resolve` and new type:

```typescript
import { fitsBudget, usedFraction } from "./usage.js";
import type {
  AliasDef, DailyCaps, ModelState, RegistryEntry, RequestCtx, Speed, UsageRecord,
} from "./types.js";

export interface ResolveResult {
  candidates: RegistryEntry[];
  skippedByBudget: RegistryEntry[];
}

export function resolve(
  alias: string,
  aliases: Record<string, AliasDef>,
  registry: RegistryEntry[],
  getState: (id: string) => ModelState,
  ctx: RequestCtx,
): ResolveResult {
  const def = aliases[alias];
  if (!def) throw new UnknownAliasError(alias);

  const harvest = ctx.harvest === true;
  const now = ctx.now ?? Date.now();

  const tagOk =
    def.tags?.length
      ? (e: RegistryEntry) => (def.tags as string[]).some((t) => e.tags.includes(t))
      : (_e: RegistryEntry) => true;

  // Tools requirement: either the alias demands tools, or the request carries tools.
  const needsTools = def.requireTools === true || ctx.hasTools;
  const toolsOk = (e: RegistryEntry) => (needsTools ? e.tools : true);

  const contextOk = (e: RegistryEntry) =>
    (def.minContext === undefined || e.context >= def.minContext) &&
    ctx.estTokens <= Math.floor(e.context * 0.9);

  const stateOk = (e: RegistryEntry) => getState(e.id).state === "ok";

  // provider totals are derived lazily per provider to avoid rescanning per candidate
  const provCache = new Map<string, Pick<UsageRecord, "requests" | "tokensIn" | "tokensOut"> | null>();
  const provCapsOf = (e: RegistryEntry): DailyCaps | undefined => {
    const caps = ctx.getProviderCaps?.(e.provider);
    if (!caps) return undefined;
    if (!provCache.has(e.provider)) {
      const totals = { requests: 0, tokensIn: 0, tokensOut: 0 };
      for (const other of registry) {
        if (other.provider !== e.provider) continue;
        const r = ctx.getUsage?.(other.id);
        if (!r || r.day !== utcDayKey(now)) continue;
        totals.requests += r.requests;
        totals.tokensIn += r.tokensIn;
        totals.tokensOut += r.tokensOut;
      }
      provCache.set(e.provider, totals);
    }
    return { ...caps };
  };

  // provCapsOf must run BEFORE reading provCache — it populates the cache.
  const budgetOk = (e: RegistryEntry) => {
    if (!harvest) return true;
    const caps = provCapsOf(e);
    return fitsBudget(
      {
        rec: ctx.getUsage?.(e.id),
        modelCaps: e.limits,
        provTotals: caps ? (provCache.get(e.provider) ?? undefined) : undefined,
        provCaps: caps,
      },
      ctx.estTokens,
      now,
    );
  };
```

Add `utcDayKey` to the usage.js import. Then filters and comparator:

```typescript
  const kept: RegistryEntry[] = [];
  const skippedByBudget: RegistryEntry[] = [];
  for (const entry of registry.filter(tagOk).filter(toolsOk).filter(contextOk).filter(stateOk)) {
    if (budgetOk(entry)) kept.push(entry);
    else skippedByBudget.push(entry);
  }

  const headroom = (e: RegistryEntry) =>
    harvest
      ? usedFraction(
          {
            rec: ctx.getUsage?.(e.id),
            modelCaps: e.limits,
            provTotals:
              e.limits || ctx.getProviderCaps?.(e.provider)
                ? (provCache.get(e.provider) ?? undefined)
                : undefined,
            provCaps: ctx.getProviderCaps?.(e.provider),
          },
          now,
        )
      : 0;

  const cmp = def.preferSpeed
    ? (a: RegistryEntry, b: RegistryEntry) =>
        SPEED_RANK[a.speed] - SPEED_RANK[b.speed] ||
        headroom(a) - headroom(b) ||
        a.tier - b.tier ||
        a.id.localeCompare(b.id)
    : (a: RegistryEntry, b: RegistryEntry) =>
        a.tier - b.tier ||
        headroom(a) - headroom(b) ||
        SPEED_RANK[a.speed] - SPEED_RANK[b.speed] ||
        a.id.localeCompare(b.id);

  kept.sort(cmp);
  return { candidates: kept, skippedByBudget };
}
```

Ensure every branch that computes headroom first ensured `provCapsOf` ran for that provider (call it defensively at the top of `headroom` when caps may exist).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/router.test.ts`
Expected: PASS including all legacy tests.

- [ ] **Step 6: Commit**

```powershell
git add src/types.ts src/router.ts test/unit/router.test.ts
git commit -m "feat: harvest mode - budget filter and within-tier rotation in resolve"
```

---

### Task 5: SSE usage capture transform

**Files:**
- Modify: `src/sse.ts`
- Test: `test/unit/sse.test.ts` (append)

**Interfaces:**
- Produces: `CapturedUsage { tokensIn: number; tokensOut: number }`, `sseUsageCapture(onUsage: (u: CapturedUsage) => void): Transform` — pass-through stream that fires the callback at most once when a parsed frame carries a top-level `usage` object.

- [ ] **Step 1: Write failing tests**

Append to `test/unit/sse.test.ts` (match its existing sink-helper style):

```typescript
import { sseUsageCapture } from "../../src/sse.js";

describe("sseUsageCapture", () => {
  it("passes frames through untouched and captures usage once", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n',
      'data: {"choices":[{"delta":{"content":" with \\"usage\\" inside"}}]}\n\n', // word inside content must not match
      "data: [DONE]\n\n",
    ].join("");
    let captured: { tokensIn: number; tokensOut: number } | undefined;
    const out = await pipeThrough(frames, sseUsageCapture((u) => { captured ??= u; }));
    expect(out).toBe(frames);
    expect(captured).toEqual({ tokensIn: 12, tokensOut: 34 });
  });

  it("never fires on streams without usage", async () => {
    let fired = false;
    await pipeThrough('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n',
      sseUsageCapture(() => { fired = true; }));
    expect(fired).toBe(false);
  });
});
```

If the existing test file has no `pipeThrough` helper, copy it from the neighboring describe blocks' pattern (a PassThrough sink collecting output as a string promise).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/sse.test.ts`
Expected: FAIL — `sseUsageCapture` not exported.

- [ ] **Step 3: Implement** — add to `src/sse.ts`:

```typescript
export interface CapturedUsage {
  tokensIn: number;
  tokensOut: number;
}

// Observes usage totals without altering a single byte of the stream.
export function sseUsageCapture(onUsage: (u: CapturedUsage) => void): Transform {
  let buffer = "";
  let done = false;
  const scan = (frame: string) => {
    if (done || !frame.startsWith("data: ") || frame === "data: [DONE]") return;
    try {
      const parsed = JSON.parse(frame.slice(5)) as Record<string, unknown>;
      const u = parsed.usage as Record<string, unknown> | undefined;
      if (u && typeof u === "object") {
        const tokensIn = typeof u.prompt_tokens === "number"
          ? u.prompt_tokens
          : typeof u.total_tokens === "number" ? u.total_tokens : 0;
        const tokensOut = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
        if (tokensIn > 0 || tokensOut > 0) {
          done = true;
          onUsage({ tokensIn, tokensOut });
        }
      }
    } catch {
      // malformed JSON — ignore
    }
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      this.push(chunk);
      buffer += chunk.toString();
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      parts.forEach(scan);
      cb();
    },
    flush(cb) {
      scan(buffer);
      cb();
    },
  });
}
```

Note `"data: "` is 6 characters — use `frame.slice(6)` (already correct above).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/unit/sse.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/sse.ts test/unit/sse.test.ts
git commit -m "feat: SSE passthrough transform capturing provider usage frames"
```

---

### Task 6: Server wiring — resolve result, non-streaming recording, 503 enrichment

**Files:**
- Modify: `src/server.ts`
- Test: `test/integration/server.test.ts` (append)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `ServerDeps.usageMap?: UsageMap`, `ServerDeps.providerCaps?: Record<string, DailyCaps>`; internal `recordServed(deps, entry, estTokens, real?)` helper reused by Task 7.

- [ ] **Step 1: Write failing tests**

Append to `test/integration/server.test.ts`:

```typescript
import { loadUsage, bindUsageFile } from "../../src/usage.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DAY = "2026-08-23";

describe("harvest recording (non-streaming)", () => {
  it("records exact usage from the response body and marks exhaustion at cap", async () => {
    const usageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-srv-")), "usage.json");
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const app = buildServer({
      config: CFG, providers: PROV, aliases: BUILT_IN_ALIASES,
      registry: applyModelLimits(REGISTRY.filter((e) => e.provider === "groq").map((e) => ({ ...e, limits: { rpd: 2 } })), undefined),
      stateMap: new Map(),
      fetchImpl,
      usageMap: new Map(),
      providerCaps: {},
    });
    // NOTE: bindUsageFile must be pointed at usageFile by the test setup helper
    bindUsageFile(usageFile);
    for (let i = 0; i < 2; i++) {
      await app.inject({ method: "POST", url: "/v1/chat/completions",
        payload: { messages: [{ role: "user", content: "hi" }] } });
    }
    const rec = loadUsage(usageFile).get("groq::openai/gpt-oss-120b");
    expect(rec?.requests).toBe(2);
    expect(rec?.tokensIn).toBe(200);
    expect(rec?.tokensOut).toBe(40);
    bindUsageFile(null);
  });
});
```

Adapt to the file's existing helpers (`makeServer`) rather than duplicating config — add optional deps params to `makeServer`.

Second test — 503 enrichment:

```typescript
it("reports skippedByBudget when every candidate is spent", async () => {
  const spent = new Map([["groq::openai/gpt-oss-120b", { day: DAY, requests: 999, tokensIn: 0, tokensOut: 0 }]]);
  const app = buildServer({
    config: { ...CFG, harvest: true },
    providers: PROV, aliases: BUILT_IN_ALIASES,
    registry: REGISTRY.filter((e) => e.provider === "groq").map((e) => ({ ...e, limits: { rpd: 100 } })),
    stateMap: new Map(),
    fetchImpl: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
    usageMap: spent,
    providerCaps: {},
  });
  const res = await app.inject({ method: "POST", url: "/v1/chat/completions",
    payload: { model: "auto/coding", messages: [{ role: "user", content: "x" }] } });
  expect(res.statusCode).toBe(503);
  expect(res.json().error.skippedByBudget.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/integration/server.test.ts`
Expected: FAIL — unknown props ignored today, no recording happens.

- [ ] **Step 3: Implement in `src/server.ts`**

New imports:

```typescript
import { aggregateProvider, maybeExhaust, recordUsage } from "./usage.js";
import { applyModelLimits, mergedProviderCaps } from "./config.js"; // mergedProviderCaps unused here if caps injected
```

Extend `ServerDeps`:

```typescript
usageMap?: UsageMap;
providerCaps?: Record<string, DailyCaps>;
```

At top of `buildServer`: `const usageMap = deps.usageMap ?? new Map();` and `const providerCaps = deps.providerCaps ?? {};`

Replace the resolve block:

```typescript
let resolved: ReturnType<typeof resolve>;
try {
  resolved = resolve(alias, deps.aliases, deps.registry, liveState, {
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
    estTokens: estimateTokens(body),
    harvest: deps.config.harvest === true,
    getUsage: (id) => usageMap.get(id),
    getProviderCaps: (p) => providerCaps[p],
    now: Date.now(),
  });
} catch (e) { /* unchanged UnknownAliasError handling */ }
```

After success (both paths share this), define and call once per request:

```typescript
function recordServed(entry: RegistryEntry, estTokens: number, real?: { tokensIn: number; tokensOut: number }) {
  const now = Date.now();
  recordUsage(usageMap, entry.id, {
    requests: 1,
    tokensIn: real?.tokensIn ?? estTokens,
    tokensOut: real?.tokensOut ?? 0,
  }, now);
  maybeExhaust(deps.stateMap!, entry.id, {
    rec: usageMap.get(entry.id),
    modelCaps: entry.limits,
    provTotals: aggregateProvider(usageMap, entry.provider),
    provCaps: providerCaps[entry.provider],
  }, now);
}
```

Non-streaming branch, after `const json = ...`:

```typescript
const u = json.usage as Record<string, unknown> | undefined;
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const tokensIn = num(u?.prompt_tokens) ?? num(u?.total_tokens) ?? estTokens;
recordServed(servedId, estTokens, { tokensIn, tokensOut: num(u?.completion_tokens) ?? 0 });
```

(`estTokens` is already computed in the ctx literal — hoist it into a `const estTokens = estimateTokens(body);` above the resolve call.)

503 branch becomes:

```typescript
if (!result.ok) {
  return reply.code(503).send(
    err("all_models_exhausted", `No free model available for ${alias} right now.`, {
      attempts: [...result.attempts, ...resolved.skippedByBudget.map((e) => ({ model: e.id, reason: "budget" }))],
      skippedByBudget: resolved.skippedBudgetIds(),
    }),
  );
}
```

Simpler final shape — put ids array directly:

```typescript
skippedByBudget: resolved.skippedByBudget.map((e) => e.id),
```

Also wire cli.ts serve path (Task 8 covers status columns; do the serve-side binding HERE so production works end-to-end):

```typescript
// in runCli serve branch:
bindUsageFile(defaultUsagePath());
const usageMap = loadUsage(defaultUsagePath());
// pass into buildServer deps:
usageMap,
providerCaps: mergedProviderCaps(cfg),
```

And registry passed to the server should be limit-aware: replace `registry: REGISTRY` with `registry: applyModelLimits(REGISTRY, cfg.modelLimits)` in both serve and printStatus.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/integration`
Expected: PASS including all pre-existing server tests (they don't pass usageMap → defaults keep behavior).

- [ ] **Step 5: Commit**

```powershell
git add src/server.ts src/cli.ts test/integration/server.test.ts
git commit -m "feat: record served-request usage, proactive exhaustion, budget-aware 503"
```

---

### Task 7: Streaming usage recording

**Files:**
- Modify: `src/server.ts` (streaming branch only)
- Test: `test/integration/streaming.test.ts` (append)

**Interfaces:**
- Consumes: `sseUsageCapture` (Task 5), `recordServed` helper (Task 6).

- [ ] **Step 1: Write failing test**

Append to `test/integration/streaming.test.ts` (reuse its existing fake-SSE fetch pattern):

```typescript
it("records real usage when the stream carries a usage frame; estimates otherwise", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const fetchImpl = (async () => new Response(sse, { status: 200 })) as unknown as typeof fetch;
  const app = makeStreamingServer({ fetchImpl }); // existing helper, extended with usageMap/providerCaps like Task 6
  const res = await app.inject({ method: "POST", url: "/v1/chat/completions",
    payload: { stream: true, messages: [{ role: "user", content: "hello" }] } });
  expect(res.statusCode).toBe(200);
  // wait for pipeline close is handled inside server before replying; assert via injected map:
  const rec = injectedUsage.get("groq::openai/gpt-oss-20b");
  expect(rec?.tokensIn).toBe(7);
  expect(rec?.tokensOut).toBe(3);

  const est = makeStreamingServer({ fetchImpl: noUsageStream() });
  await est.inject({ method: "POST", url: "/v1/chat/completions",
    payload: { stream: true, messages: [{ role: "user", content: "hello" }] } });
  const rec2 = injectedUsage2.get("groq::openai/gpt-oss-20b");
  expect(rec2?.requests).toBe(1);
  expect(rec2?.tokensIn).toBeGreaterThan(0); // chars/4 estimate of request body
});
```

Adapt names to the file's actual helpers — the point is two servers with distinct injected `usageMap`s.

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/integration/streaming.test.ts` → FAIL (no usage recorded on streams).

- [ ] **Step 3: Implement** in the streaming branch of `src/server.ts`:

```typescript
const capture = sseUsageCapture((u) => {
  capturedUsage = u;
});
let capturedUsage: { tokensIn: number; tokensOut: number } | undefined;
```

Insert into BOTH pipe chains between `rewriter` and the final sink:

```typescript
// annotate path: upstream -> rewriter -> capture -> annotator -> reply.raw
capture.pipe(annotator);
rewriter.pipe(capture);
upstream.pipe(rewriter);

// plain path: upstream -> rewriter -> capture -> reply.raw
capture.pipe(reply.raw);
rewriter.pipe(capture);
upstream.pipe(rewriter);
```

Add error handler mirroring siblings (`capture.on("error", ...)` → end reply if not ended).

Extend the close-await promise to also resolve on `capture.on("close")`, then AFTER it resolves:

```typescript
if (capturedUsage) recordServed(servedId, estTokens, capturedUsage);
else recordServed(servedId, estTokens); // estimate fallback covers disconnects too
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/integration/streaming.test.ts`
Expected: PASS. Also run full `npm test`.

- [ ] **Step 5: Commit**

```powershell
git add src/server.ts test/integration/streaming.test.ts
git commit -m "feat: streaming usage capture with estimate fallback"
```

---

### Task 8: Status CLI spend columns

**Files:**
- Modify: `src/cli.ts`
- Test: `test/unit/cli.test.ts` (append)

**Interfaces:**
- Produces: `formatStatusRow(e, msRaw, now, usage?: UsageRecord)` — optional 4th param keeps old callers valid.

- [ ] **Step 1: Write failing tests**

Append to `test/unit/cli.test.ts`:

```typescript
describe("formatStatusRow usage column", () => {
  const E2: RegistryEntry = { ...E, limits: { rpd: 50, tpd: 1000000 } };

  it("renders spend against caps", () => {
    const row = formatStatusRow(E2, { state: "ok" }, NOW,
      { day: "2026-08-22", requests: 12, tokensIn: 84000, tokensOut: 16000 });
    expect(row).toContain("req 12/50");
    expect(row).toContain("tok 100k/1M");
  });

  it("renders dash for models without caps", () => {
    expect(formatStatusRow(E, { state: "ok" }, NOW)).toContain("req -");
  });

  it("omits unseeded dimensions", () => {
    const half: RegistryEntry = { ...E, limits: { rpd: 50 } };
    const row = formatStatusRow(half, { state: "ok" }, NOW,
      { day: "2026-08-22", requests: 3, tokensIn: 5, tokensOut: 5 });
    expect(row).toContain("req 3/50");
    expect(row).not.toContain("tok");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/unit/cli.test.ts` → FAIL.

- [ ] **Step 3: Implement in `src/cli.ts`**

```typescript
function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatStatusRow(
  e: RegistryEntry,
  msRaw: ModelState,
  now: number,
  usage?: UsageRecord,
): string {
  // ...existing state computation unchanged...
  let usageCol = "req -";
  if (e.limits && usage) {
    const parts: string[] = [];
    if (e.limits.rpd) parts.push(`req ${usage.requests}/${fmtCompact(e.limits.rpd)}`);
    if (e.limits.tpd) {
      parts.push(`tok ${fmtCompact(usage.tokensIn + usage.tokensOut)}/${fmtCompact(e.limits.tpd)}`);
    }
    usageCol = parts.length > 0 ? parts.join(" · ") : "req -";
  }
  return [
    e.id.padEnd(50),
    `t${e.tier}`,
    e.speed.padEnd(7),
    e.tools ? "tools" : "-",
    String(e.context).padStart(7),
    state.padEnd(28),
    usageCol.padEnd(18),
    e.tags.join(","),
  ].join("  ");
}
```

In `printStatus`: `const usageMap = loadUsage(defaultUsagePath());` and pass `usageMap.get(entry.id)` as 4th arg. Import `loadUsage` from `./usage.js` and `defaultUsagePath` from `./config.js`. Also apply `applyModelLimits(REGISTRY, cfg.modelLimits)` where REGISTRY is used here.

- [ ] **Step 4: Run tests** — `npx vitest run test/unit/cli.test.ts` → PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/cli.ts test/unit/cli.test.ts
git commit -m "feat: status shows daily request/token spend against seeded caps"
```

---

### Task 9: Documentation + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README** — after the "Transparency" section add:

```markdown
## Quota harvest

Freeroll tracks how much of each model's free-tier daily allowance you have spent
(today, UTC) and uses it in routing:

- same-tier candidates are tried least-used first, so no single model burns out by noon;
- models whose remaining daily budget cannot fit your request are skipped without a wasted call;
- provider-wide pools (e.g. OpenRouter's account-level 50 free requests/day) are respected across all their models;
- a model that hits its cap is parked until the UTC reset, exactly like a 429 would.

Spend shows up in `freeroll status` (`req 12/50 · tok 84k/1M`). Caps come from
curated seeds in `registry.json`/`providers.json`; override or extend them per
model or provider in `~/.freeroll/config.json`:

    { "harvest": false,                       // revert to v0 routing entirely
      "modelLimits":   { "google::gemini-2.5-pro": { "rpd": 100 } },
      "providerLimits": { "openrouter": { "rpd": 1000 } } }

Token counts use provider-reported usage when available and an input-size
estimate otherwise.
```

Also update the Configuration section's config example keys list.

- [ ] **Step 2: Full verification**

Run: `npm test; if ($?) { npm run build }`
Expected: all suites pass, clean strict compile.

Manual smoke (optional but recommended, needs real keys):

```powershell
node dist/cli.js status     # spend columns render; 5/6 providers as before
node dist/cli.js serve      # send one chat request, re-run status, see counters move
```

- [ ] **Step 3: Commit**

```powershell
git add README.md
git commit -m "docs: quota harvest mode - spread routing, caps seeds, config overrides"
```

---

## Self-review notes (resolved during planning)

- Pooled fraction never double-counts the served request: model level and provider pool level are checked independently (Task 2 Step 1 correction).
- `sseUsageCapture` slices `"data: ".length` (6), verified against frame format (Task 5 note).
- Parity guarantee lives in two places: `resolve` ignores usage for entries without limits even under harvest (Task 4 parity test), and `config.harvest === false` skips both filter and rotation (Task 4 implementation + Task 6 wiring passes the flag).








