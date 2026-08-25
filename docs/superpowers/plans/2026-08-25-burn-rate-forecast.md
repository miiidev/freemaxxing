# Quota Burn-Rate Forecasting Implementation Plan (Phase 2 — Plan D)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `maxout status` from reactive (`32/50 used`) into predictive (`· projected exhaustion ~15:40 UTC`) so users see the wall coming before they hit it mid-task.

**Architecture:** Per-model `UsageRecord`s gain a bounded `reqTs` timestamp ring (newest 500 kept, dropped at day rollover) so request history exists without unbounded growth. A pure function `projectExhaustion` does deterministic linear extrapolation from UTC day start over the pool's aggregated counters, suppressed below 5 samples or 15 elapsed minutes ("insufficient data" beats a wrong guess). The `[pool]` status line grows an optional forecast fragment.

**Tech Stack:** TypeScript (strict, ESM, Node >= 20), vitest (fully offline).

**Spec:** `docs/superpowers/specs/2026-08-25-phase2-resilience-design.md` (§4)

## Global Constraints

- Node >= 20; TypeScript strict; ESM; local imports end in `.js`.
- Tests fully offline; fixed clocks via arguments, never `Date.now()` inside logic under test.
- No timers; persistence stays write-to-tmp + `renameSync`.
- Comments sparse, explain *why* only.
- Commits: `feat:` / `fix:` / `docs:` / `test:` prefixes, imperative mood.
- Shell is Windows PowerShell: `$env:X="y"`, chain with `if ($?) { }`.
- Full suite: `npm test`. Single file: `npx vitest run <file>`. Build check: `npm run build`.

## Deviations from spec (intentional)

1. Spec §4 notes timestamps are stored though v1's formula consumes only the day counters (rate from UTC-midnight linear extrapolation). This is the explicit handoff requirement ("retain request timestamps for a bounded recent window") plus hand-checkable math; trailing-window rates are a documented follow-up, and the stored ring makes that a non-migrating upgrade.
2. Pools without an `rpd` cap (cerebras' `tpd`) get **no** forecast this iteration — token-based projection needs an output-token assumption the current data can't justify. Spec §4 documents this.

## File Structure (final state)

| File | Responsibility |
|---|---|
| `src/types.ts` | `UsageRecord.reqTs?: number[]` |
| `src/usage.ts` | `MAX_REQ_TS`, `utcDayStart`, ts capture/sanitize, `MIN_FORECAST_SAMPLES`, `Forecast`, `projectExhaustion` |
| `src/cli.ts` | `formatPoolLine(..., forecast?)` fragment + `printStatus` wiring |
| `test/unit/burn-forecast.test.ts` | NEW — retention, sanitizing, math, suppression, formatting |

---

### Task 1: Bounded timestamp retention

**Files:**
- Modify: `src/types.ts`
- Modify: `src/usage.ts`
- Test: `test/unit/burn-forecast.test.ts` (new, first half)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `types.ts`: `UsageRecord.reqTs?: number[]`
  - `usage.ts`: `MAX_REQ_TS = 500`; `utcDayStart(now: number): number`; `recordUsage` appends `now` to `rec.reqTs` when `delta.requests > 0`, capped at `MAX_REQ_TS`; `loadUsage` drops malformed `reqTs` values.

- [ ] **Step 1: Write failing tests**

Create `test/unit/burn-forecast.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordUsage, loadUsage, saveUsage, bindUsageFile,
  utcDayStart, MAX_REQ_TS, type UsageMap,
} from "../../src/usage.js";

const DAY_START = Date.UTC(2026, 7, 25, 0, 0, 0);

describe("utcDayStart", () => {
  it("snaps to UTC midnight", () => {
    expect(utcDayStart(Date.UTC(2026, 7, 25, 10, 30, 15))).toBe(DAY_START);
    expect(utcDayStart(DAY_START)).toBe(DAY_START);
  });
});

describe("request timestamp retention", () => {
  it("appends one timestamp per counted request", () => {
    const map: UsageMap = new Map();
    recordUsage(map, "groq::a", { requests: 1 }, DAY_START + 60_000);
    recordUsage(map, "groq::a", { tokensIn: 10 }, DAY_START + 90_000); // no request -> no ts
    expect(map.get("groq::a")?.reqTs).toEqual([DAY_START + 60_000]);
  });

  it("keeps only the newest MAX_REQ_TS entries", () => {
    const map: UsageMap = new Map();
    for (let i = 1; i <= MAX_REQ_TS + 5; i++) {
      recordUsage(map, "groq::a", { requests: 1 }, DAY_START + i * 1000);
    }
    const ts = map.get("groq::a")?.reqTs ?? [];
    expect(ts).toHaveLength(MAX_REQ_TS);
    expect(ts[ts.length - 1]).toBe(DAY_START + (MAX_REQ_TS + 5) * 1000);
  });

  it("survives a persist/reload round-trip", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-burn-")), "usage.json");
    bindUsageFile(file);
    const map: UsageMap = new Map();
    recordUsage(map, "groq::a", { requests: 2 }, DAY_START + 1000);
    recordUsage(map, "groq::a", { requests: 1 }, DAY_START + 2000);
    bindUsageFile(null);
    const reloaded = loadUsage(file, DAY_START + 3000);
    expect(reloaded.get("groq::a")?.reqTs).toEqual([DAY_START + 1000, DAY_START + 2000]);
  });

  it("sanitizes corrupt persisted timestamps", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-burn-")), "usage.json");
    fs.writeFileSync(file, JSON.stringify({
      "groq::a": { day: "2026-08-25", requests: 2, tokensIn: 0, tokensOut: 0, reqTs: [DAY_START, "oops", null, 42] },
      "groq::b": { day: "2026-08-25", requests: 1, tokensIn: 0, tokensOut: 0, reqTs: "junk" },
    }));
    const map = loadUsage(file, DAY_START + 5000);
    expect(map.get("groq::a")?.reqTs).toEqual([DAY_START, 42]);
    expect(map.get("groq::b")?.reqTs).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/burn-forecast.test.ts`
Expected: FAIL — `utcDayStart`/`MAX_REQ_TS` not exported; `reqTs` never populated.

- [ ] **Step 3: Implement**

In `src/types.ts`:

```typescript
export interface UsageRecord {
  day: string; // "YYYY-MM-DD" (UTC) this record belongs to
  requests: number;
  tokensIn: number;
  tokensOut: number;
  reqTs?: number[]; // bounded arrival-time ring feeding burn-rate forecasts
}
```

In `src/usage.ts`:

```typescript
// Newest-wins cap keeps per-record growth bounded; rollover drops the rest.
export const MAX_REQ_TS = 500;

export function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
```

In `recordUsage`, after the counter increments and before `map.set(id, rec)`:

```typescript
  if ((delta.requests ?? 0) > 0) {
    rec.reqTs = [...(rec.reqTs ?? []), now].slice(-MAX_REQ_TS);
  }
```

In `loadUsage`, replace the loop body:

```typescript
    for (const [id, rec] of Object.entries(raw)) {
      // stale days are dropped on sight — counters only ever describe today
      if (isUsageRecord(rec) && rec.day === day) {
        if (Array.isArray(rec.reqTs)) {
          rec.reqTs = rec.reqTs.filter((t): t is number => typeof t === "number").slice(-MAX_REQ_TS);
        } else {
          delete rec.reqTs;
        }
        map.set(id, rec);
      }
    }
```

(`saveUsage` needs no change — `JSON.stringify` carries the optional field.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/burn-forecast.test.ts test/unit/usage.test.ts`
Expected: PASS (existing usage tests prove counters unaffected).

- [ ] **Step 5: Commit**

```powershell
git add src/types.ts src/usage.ts test/unit/burn-forecast.test.ts
git commit -m "feat: bounded request-timestamp ring in usage records"
```

---

### Task 2: Projection + status fragment

**Files:**
- Modify: `src/usage.ts` (`projectExhaustion`)
- Modify: `src/cli.ts` (`formatPoolLine`, `printStatus`)
- Test: `test/unit/burn-forecast.test.ts` (second half)

**Interfaces:**
- Consumes: `aggregateProvider`, `utcDayStart` (Task 1).
- Produces:
  - `usage.ts`: `MIN_FORECAST_SAMPLES = 5`; `interface Forecast { projectedAt: number }`; `projectExhaustion(provider: string, caps: DailyCaps | undefined, map: UsageMap, now: number): Forecast | null`
  - `cli.ts`: `formatPoolLine(provider, caps, totals, msRaw, modelCount, now, forecast?)` — 7th optional param appends ` · projected exhaustion ~HH:MM UTC`.

- [ ] **Step 1: Write failing tests**

Append to `test/unit/burn-forecast.test.ts` (extend the existing import list from `../../src/usage.js` to include `projectExhaustion`, `aggregateProvider`, `MIN_FORECAST_SAMPLES`; extend the `../../src/cli.js` import for `formatPoolLine`):

```typescript
import { formatPoolLine } from "../../src/cli.js";
import type { DailyCaps } from "../../src/types.js";

const CAPS: DailyCaps = { rpd: 50 };
const T10 = Date.UTC(2026, 7, 25, 10, 0, 0); // 600 minutes into the day

function seeded(requests: number, lastAtMin = 9 * 60): UsageMap {
  const map: UsageMap = new Map();
  map.set("groq::a", {
    day: "2026-08-25", requests, tokensIn: 0, tokensOut: 0,
    reqTs: Array.from({ length: Math.min(requests, 3) }, (_, i) => DAY_START + (i + 1) * 60_000),
  });
  map.set("groq::b", {
    day: "2026-08-25", requests: requests - Math.min(requests, 3), tokensIn: 0, tokensOut: 0,
  });
  return map;
}

describe("projectExhaustion", () => {
  it("matches manual linear extrapolation exactly on a clean fixture", () => {
    // 30 requests by 10:00 UTC at 50/day: rate 30/600min, remaining 20 -> 400min -> 16:40
    const f = projectExhaustion("groq", CAPS, seeded(30), T10);
    expect(f?.projectedAt).toBe(Date.UTC(2026, 7, 25, 16, 40));
  });

  it("suppresses below the minimum sample threshold", () => {
    const f = projectExhaustion("groq", CAPS, seeded(MIN_FORECAST_SAMPLES - 1), T10);
    expect(f).toBeNull();
  });

  it("suppresses when too little of the day has elapsed", () => {
    const f = projectExhaustion("groq", CAPS, seeded(6), DAY_START + 10 * 60_000);
    expect(f).toBeNull();
  });

  it("returns null for pools without an rpd cap", () => {
    expect(projectExhaustion("cerebras", { tpd: 1_000_000 }, seeded(30), T10)).toBeNull();
    expect(projectExhaustion("mystery", undefined, seeded(30), T10)).toBeNull();
  });

  it("returns null once the pool is already exhausted", () => {
    expect(projectExhaustion("groq", CAPS, seeded(50), T10)).toBeNull();
  });
});

describe("pool-line forecast fragment", () => {
  const totals = { requests: 32, tokensIn: 0, tokensOut: 0 };

  it("appends the projection time when a forecast exists", () => {
    const line = formatPoolLine("openrouter", CAPS, totals, { state: "ok" }, 12, T10, { projectedAt: Date.UTC(2026, 7, 25, 15, 40) });
    expect(line).toContain("projected exhaustion ~15:40 UTC");
  });

  it("stays byte-identical to the old format without a forecast", () => {
    const args = ["openrouter", CAPS, totals, { state: "ok" }, 12, T10] as const;
    expect(formatPoolLine(...args, null)).toBe(formatPoolLine(...args));
    expect(formatPoolLine(...args)).not.toContain("projected");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/burn-forecast.test.ts`
Expected: FAIL — `projectExhaustion`/`MIN_FORECAST_SAMPLES` missing; `formatPoolLine` arity.

- [ ] **Step 3: Implement**

In `src/usage.ts`, append:

```typescript
// Below this, a "projection" would just be noise.
export const MIN_FORECAST_SAMPLES = 5;
const MIN_FORECAST_ELAPSED_MIN = 15;

export interface Forecast {
  projectedAt: number;
}

// Linear-from-day-start by design: simple enough to verify by hand, which is
// the point of showing a prediction to the user.
export function projectExhaustion(
  provider: string,
  caps: DailyCaps | undefined,
  map: UsageMap,
  now: number,
): Forecast | null {
  if (!caps?.rpd) return null;
  const totals = aggregateProvider(map, provider);
  if (totals.requests < MIN_FORECAST_SAMPLES) return null;
  const elapsedMin = (now - utcDayStart(now)) / 60_000;
  if (elapsedMin < MIN_FORECAST_ELAPSED_MIN) return null;
  const remaining = caps.rpd - totals.requests;
  if (remaining <= 0) return null;
  const ratePerMs = totals.requests / (elapsedMin * 60_000);
  return { projectedAt: Math.round((now + remaining / ratePerMs) / 60_000) * 60_000 };
}
```

In `src/cli.ts`, `formatPoolLine` gains the parameter and fragment:

```typescript
export function formatPoolLine(
  provider: string,
  caps: DailyCaps,
  totals: ProviderTotals,
  msRaw: ModelState,
  modelCount: number,
  now: number,
  forecast?: { projectedAt: number } | null,
): string {
```

with the reset column built as:

```typescript
  const fc = forecast ? ` · projected exhaustion ~${new Date(forecast.projectedAt).toISOString().slice(11, 16)} UTC` : "";
  const st = msRaw.state === "ok" || msRaw.state === "exhausted" ? msRaw.state : String(msRaw.state);
  return [
    `[pool] ${provider.padEnd(12)}`,
    spent.padEnd(10),
    `${st} · resets ${resetAt} UTC${fc}`,
    `shared by ${modelCount} model${modelCount === 1 ? " " : "s"}`,
  ].join("  ");
```

In `printStatus`, compute and pass it:

```typescript
    if (caps) {
      console.log(formatPoolLine(
        provider, caps, aggregateProvider(usageMap, provider),
        states.get(poolKey(provider)) ?? { state: "ok" }, entries.length, now,
        projectExhaustion(provider, caps, usageMap, now),
      ));
    }
```

and extend the config import block at the top of `cli.ts`:

```typescript
import { aggregateProvider, bindUsageFile, loadUsage, projectExhaustion, type ProviderTotals } from "./usage.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`; then `npm run build`. Expected: green, clean compile.

- [ ] **Step 5: Commit**

```powershell
git add src/usage.ts src/cli.ts test/unit/burn-forecast.test.ts
git commit -m "feat: project pool exhaustion time in maxout status"
```
