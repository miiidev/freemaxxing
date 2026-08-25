# Opt-in Hybrid Mode Implementation Plan (Phase 2 — Plan E)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When every free AND local candidate is exhausted, let opted-in users keep working on a paid model — bounded by a hard UTC-daily USD cap that survives restarts and never trips implicitly.

**Architecture:** The paid model enters as ONE synthetic candidate appended LAST to the resolved list — position-at-end *is* the trigger condition ("every free and local candidate exhausted"), reusing the entire execute/failover/streaming path with zero new transport code. Actual spend lands in `~/.maxout/spend.json` (`{day, spentUSD}`, UTC rollover, atomic writes): provider-reported `usage.cost` when present, else tokens × configured prices. The cap is checked before injection; the ledger persists, so restarting cannot evade it. Disabled (the default) ⇒ the feature is structurally inert.

**Tech Stack:** TypeScript (strict, ESM, Node >= 20), Fastify, vitest (fully offline).

**Spec:** `docs/superpowers/specs/2026-08-25-phase2-resilience-design.md` (§5)

## Global Constraints

- Node >= 20; TypeScript strict; ESM; local imports end in `.js`.
- Tests fully offline; inject fake `fetchImpl`; **never** construct a `SpendStore` backed by the real home directory in tests.
- No timers; persistence stays write-to-tmp + `renameSync`.
- Comments sparse, explain *why* only.
- Commits: `feat:` / `fix:` / `docs:` / `test:` prefixes, imperative mood.
- Shell is Windows PowerShell: `$env:X="y"`, chain with `if ($?) { }`.
- Full suite: `npm test`. Single file: `npx vitest run <file>`. Build check: `npm run build`.

## Dependencies & execution notes

- Assumes Plans A–C landed: `server.ts` has the merged `providers` binding (local-aware), hoisted `aliasDef`, and `let candidates` mutation point. The injection below slots in directly after the session-affinity block.
- `AppConfig.hybrid` is an **optional** field populated with defaults by `loadConfig` — existing `const CFG: AppConfig = {...}` literals in tests stay valid untouched.

## Deviations from spec (intentional)

1. Spec §5 says hybrid fires "when every free and local candidate is exhausted". Implemented positionally (append last) rather than by inspecting exhaustion states: identical observable behavior, no duplicated state logic, and mid-request failover into paid works even when exhaustion was discovered lazily by the executor rather than marked in state.
2. Concurrent in-flight paid requests can overshoot the cap slightly before their costs land (spec §5 documents this accepted v1 limitation).
3. Malformed-output validation/reliability scoring are skipped for paid responses (spec §5 "Serving differences").

## File Structure (final state)

| File | Responsibility |
|---|---|
| `src/config.ts` | `HybridConfig` + defaults + lenient parse + `defaultSpendPath()` |
| `src/spend.ts` | NEW — ledger IO + injectable `SpendStore` factory |
| `src/hybrid.ts` | NEW — synthetic paid entry + cost extraction |
| `src/server.ts` | last-position injection, paid-serving branch, spend recording |
| `src/cli.ts` | `formatHybridLine` + status display + serve wiring |
| `test/unit/hybrid-config.test.ts` | NEW — config parse + ledger semantics |
| `test/unit/hybrid.test.ts` | NEW — entry builder + cost extraction |
| `test/integration/hybrid.test.ts` | NEW — end-to-end gating, capping, accounting |
| `test/unit/cli-hybrid.test.ts` | NEW — status formatting |

---

### Task 1: Config + spend ledger

**Files:**
- Modify: `src/config.ts`
- Create: `src/spend.ts`
- Test: `test/unit/hybrid-config.test.ts` (new)

**Interfaces:**
- Consumes: `utcDayKey` from `src/usage.ts`.
- Produces:
  - `config.ts`: `interface HybridConfig { enabled: boolean; dailyCapUSD: number; provider: string; model: string; priceInPerMTok: number; priceOutPerMTok: number }`; `DEFAULT_HYBRID`; `AppConfig.hybrid?: HybridConfig`; `defaultSpendPath(): string`
  - `spend.ts`: `interface SpendLedger { day: string; spentUSD: number }`; `interface SpendStore { spentToday(now: number): number; record(usd: number, now: number): void }`; `fileSpendStore(filePath: string | null): SpendStore`; `loadSpend(f: string, now?: number): SpendLedger | null`; `saveLedger(f: string, l: SpendLedger): void`

- [ ] **Step 1: Write failing tests**

Create `test/unit/hybrid-config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, mergeConfigPatch, DEFAULT_HYBRID, defaultSpendPath } from "../../src/config.js";
import { fileSpendStore, saveLedger, loadSpend } from "../../src/spend.js";

const T = Date.UTC(2026, 7, 25, 12, 0, 0);

describe("hybrid config block", () => {
  it("defaults to disabled with sane prices", () => {
    const cfg = loadConfig(null);
    expect(cfg.hybrid).toEqual(DEFAULT_HYBRID);
    expect(DEFAULT_HYBRID.enabled).toBe(false);
    expect(DEFAULT_HYBRID.dailyCapUSD).toBe(2);
    expect(DEFAULT_HYBRID.provider).toBe("openrouter");
  });

  it("parses overrides and keeps garbage out", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-hcfg-")), "config.json");
    fs.writeFileSync(file, JSON.stringify({
      hybrid: { enabled: true, dailyCapUSD: 5, provider: "groq", model: "m", priceInPerMTok: -3, dailyCapUSDExtra: 9 },
    }));
    const cfg = loadConfig(file);
    expect(cfg.hybrid?.enabled).toBe(true);
    expect(cfg.hybrid?.dailyCapUSD).toBe(5);
    expect(cfg.hybrid?.provider).toBe("groq");
    expect(cfg.hybrid?.priceInPerMTok).toBe(DEFAULT_HYBRID.priceInPerMTok);
  });

  it("exposes the ledger path under ~/.maxout", () => {
    expect(defaultSpendPath().replace(/\\/g, "/")).toMatch(/\.maxout\/spend\.json$/);
  });
});

describe("spend ledger", () => {
  it("accumulates within the day and rolls over at UTC midnight", () => {
    const store = fileSpendStore(null);
    store.record(0.42, T);
    store.record(0.08, T + 1000);
    expect(store.spentToday(T + 2000)).toBeCloseTo(0.50, 10);
    const nextDay = T + 24 * 60 * 60 * 1000;
    expect(store.spentToday(nextDay)).toBe(0);
  });

  it("persists and reloads through a file, surviving restarts", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-spend-")), "spend.json");
    const writer = fileSpendStore(file);
    writer.record(1.25, T);
    const reader = fileSpendStore(file); // fresh process, same file
    expect(reader.spentToday(T)).toBeCloseTo(1.25, 10);
  });

  it("ignores stale days and corrupt files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-spend-"));
    const stale = path.join(dir, "stale.json");
    saveLedger(stale, { day: "2026-08-24", spentUSD: 99 });
    expect(loadSpend(stale, T)).toBeNull();
    const corrupt = path.join(dir, "corrupt.json");
    fs.writeFileSync(corrupt, "{nope");
    expect(loadSpend(corrupt, T)).toBeNull();
  });

  it("treats the cap as strictly-under-to-route", () => {
    const store = fileSpendStore(null);
    store.record(1.99, T);
    expect(store.spentToday(T) < 2).toBe(true);
    store.record(0.01, T);
    expect(store.spentToday(T) < 2).toBe(false);
  });
});

describe("mergeConfigPatch interplay", () => {
  it("can enable hybrid without losing siblings", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-hmerge-")), "config.json");
    mergeConfigPatch(file, { harvest: false });
    mergeConfigPatch(file, { hybrid: { enabled: true } });
    const cfg = loadConfig(file);
    expect(cfg.harvest).toBe(false);
    expect(cfg.hybrid?.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/hybrid-config.test.ts`
Expected: FAIL — `DEFAULT_HYBRID`/`defaultSpendPath`/spend module missing.

- [ ] **Step 3: Implement**

In `src/config.ts`, add near `LocalConfig`:

```typescript
export interface HybridConfig {
  enabled: boolean;
  dailyCapUSD: number;
  provider: string;
  model: string;
  priceInPerMTok: number;
  priceOutPerMTok: number;
}

export const DEFAULT_HYBRID: HybridConfig = {
  enabled: false,
  dailyCapUSD: 2,
  provider: "openrouter",
  model: "deepseek/deepseek-chat-v3.1",
  priceInPerMTok: 0.27,
  priceOutPerMTok: 1.1,
};
```

Add `hybrid?: HybridConfig;` to `AppConfig`; initialize in `loadConfig`'s default object with `hybrid: { ...DEFAULT_HYBRID },`; extend the parse blocks:

```typescript
    if (raw.hybrid && typeof raw.hybrid === "object") {
      const h = raw.hybrid as Partial<HybridConfig>;
      if (typeof h.enabled === "boolean") cfg.hybrid!.enabled = h.enabled;
      if (typeof h.dailyCapUSD === "number" && h.dailyCapUSD > 0) cfg.hybrid!.dailyCapUSD = h.dailyCapUSD;
      if (typeof h.provider === "string" && h.provider.length > 0) cfg.hybrid!.provider = h.provider;
      if (typeof h.model === "string" && h.model.length > 0) cfg.hybrid!.model = h.model;
      if (typeof h.priceInPerMTok === "number" && h.priceInPerMTok >= 0) cfg.hybrid!.priceInPerMTok = h.priceInPerMTok;
      if (typeof h.priceOutPerMTok === "number" && h.priceOutPerMTok >= 0) cfg.hybrid!.priceOutPerMTok = h.priceOutPerMTok;
    }
```

Add alongside the other path helpers:

```typescript
export function defaultSpendPath(): string {
  return path.join(os.homedir(), ".maxout", "spend.json");
}
```

Create `src/spend.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { utcDayKey } from "./usage.js";

export interface SpendLedger {
  day: string;
  spentUSD: number;
}

export interface SpendStore {
  spentToday(now: number): number;
  record(usd: number, now: number): void;
}

export function saveLedger(target: string, l: SpendLedger): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2));
  fs.renameSync(tmp, target);
}

export function loadSpend(f: string, now: number = Date.now()): SpendLedger | null {
  if (!fs.existsSync(f)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<SpendLedger>;
    // stale days are money already un-spent again
    if (raw.day !== utcDayKey(now) || typeof raw.spentUSD !== "number") return null;
    return { day: raw.day, spentUSD: raw.spentUSD };
  } catch {
    return null;
  }
}

// filePath null = memory-only (tests, dry inspection); a real path makes the
// cap restart-proof within its UTC day.
export function fileSpendStore(filePath: string | null): SpendStore {
  let mem: SpendLedger | null = null;
  const read = (now: number): SpendLedger | null =>
    filePath ? loadSpend(filePath, now) : mem && mem.day === utcDayKey(now) ? mem : null;
  return {
    spentToday(now) {
      return read(now)?.spentUSD ?? 0;
    },
    record(usd, now) {
      const day = utcDayKey(now);
      const cur = read(now);
      const next: SpendLedger =
        cur && cur.day === day ? { day, spentUSD: cur.spentUSD + usd } : { day, spentUSD: usd };
      mem = next;
      if (filePath) saveLedger(filePath, next);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/hybrid-config.test.ts test/unit/config.test.ts test/unit/local-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/config.ts src/spend.ts test/unit/hybrid-config.test.ts
git commit -m "feat: hybrid config block and restart-proof spend ledger"
```

---

### Task 2: Paid entry + cost extraction

**Files:**
- Create: `src/hybrid.ts`
- Test: `test/unit/hybrid.test.ts` (new)

**Interfaces:**
- Consumes: `HybridConfig` (Task 1).
- Produces:
  - `hybrid.ts`: `paidId(h: HybridConfig): string`; `isPaidEntry(e: Pick<RegistryEntry, "id">, h: HybridConfig): boolean`; `hybridEntry(h: HybridConfig): RegistryEntry`; `extractCost(json: Record<string, unknown>, h: HybridConfig): number`

- [ ] **Step 1: Write failing tests**

Create `test/unit/hybrid.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { paidId, isPaidEntry, hybridEntry, extractCost } from "../../src/hybrid.js";
import { DEFAULT_HYBRID } from "../../src/config.js";

const H = { ...DEFAULT_HYBRID };

describe("paid entry", () => {
  it("obeys <provider>::<upstream> naming", () => {
    expect(paidId(H)).toBe("openrouter::deepseek/deepseek-chat-v3.1");
    expect(isPaidEntry({ id: paidId(H) }, H)).toBe(true);
    expect(isPaidEntry({ id: "openrouter::other" }, H)).toBe(false);
  });

  it("sorts last under any static ordering and claims tools", () => {
    const e = hybridEntry(H);
    expect(e.tier).toBe(99);
    expect(e.speed).toBe("slow");
    expect(e.tools).toBe(true);
    expect(e.upstream).toBe(H.model);
  });
});

describe("extractCost", () => {
  it("prefers provider-reported cost", () => {
    expect(extractCost({ usage: { cost: 0.07, prompt_tokens: 999999 } }, H)).toBe(0.07);
  });

  it("falls back to tokens times configured prices", () => {
    const json = { usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } };
    expect(extractCost(json, H)).toBeCloseTo(0.27 + 0.55, 10);
  });

  it("returns zero when nothing usable is present", () => {
    expect(extractCost({}, H)).toBe(0);
    expect(extractCost({ usage: {} }, H)).toBe(0);
    expect(extractCost({ usage: { prompt_tokens: "many" } }, H)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/hybrid.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/hybrid.ts`:

```typescript
import type { HybridConfig } from "./config.js";
import type { RegistryEntry } from "./types.js";

export function paidId(h: HybridConfig): string {
  return `${h.provider}::${h.model}`;
}

export function isPaidEntry(e: Pick<RegistryEntry, "id">, h: HybridConfig): boolean {
  return e.id === paidId(h);
}

// Tier 99/slow is cosmetic insurance — the entry reaches the executor only
// via last-position injection, never by winning a sort.
export function hybridEntry(h: HybridConfig): RegistryEntry {
  return {
    id: paidId(h),
    provider: h.provider,
    upstream: h.model,
    tags: ["coding", "chat", "fast", "long-context"],
    tier: 99,
    speed: "slow",
    context: 200000,
    maxOutput: 8192,
    tools: true,
  };
}

// Provider-reported cost wins; token math is the documented approximation.
export function extractCost(json: Record<string, unknown>, h: HybridConfig): number {
  const usage = json.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return 0;
  if (typeof usage.cost === "number") return usage.cost;
  const pt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const ct = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  if (pt === undefined && ct === undefined) return 0;
  return ((pt ?? 0) / 1e6) * h.priceInPerMTok + ((ct ?? 0) / 1e6) * h.priceOutPerMTok;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/hybrid.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/hybrid.ts test/unit/hybrid.test.ts
git commit -m "feat: synthetic paid candidate and cost extraction"
```

---

### Task 3: Server integration — inject, serve, account

**Files:**
- Modify: `src/server.ts`
- Test: `test/integration/hybrid.test.ts` (new)

**Interfaces:**
- Consumes: everything above; Plans A–C server structure (`providers` merged binding, hoisted `aliasDef`, `let candidates`).
- Produces: `ServerDeps.spend?: SpendStore` — absent or `hybrid.enabled:false` ⇒ behavior byte-for-byte unchanged (proven by Task's first test).

- [ ] **Step 1: Write failing tests**

Create `test/integration/hybrid.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/server.js";
import { DEFAULT_HYBRID, type AppConfig, type ActiveProvider } from "../../src/config.js";
import type { SpendStore } from "../../src/spend.js";
import type { StateMap } from "../../src/state.js";

const PAID_UPSTREAM = "deepseek/deepseek-chat-v3.1";
const PAID_ID = `openrouter::${PAID_UPSTREAM}`;

const EXH = { state: "exhausted" as const, until: Number.MAX_SAFE_INTEGER };

function baseCfg(hybridEnabled: boolean): AppConfig {
  return {
    port: 8787, host: "127.0.0.1", aliases: {},
    providers: { groq: { apiKeyEnv: "GROQ_API_KEY" } },
    annotateResponses: false, harvest: true,
    hybrid: { ...DEFAULT_HYBRID, enabled: hybridEnabled },
  };
}

const PROV: Record<string, ActiveProvider> = {
  groq: { baseURL: "https://groq.test/v1", auth: "bearer", quirks: "groq",
          resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk-g" },
  openrouter: { baseURL: "https://or.test/api/v1", auth: "bearer", quirks: "openrouter",
                resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk-o" },
};

function registry(): RegistryEntryLike[] {
  return [
    { id: "groq::a", provider: "groq", upstream: "up-a", tags: ["coding"], tier: 1, speed: "fast", context: 128000, maxOutput: 8192, tools: true },
  ];
}
type RegistryEntryLike = import("../../src/types.js").RegistryEntry;

function spyStore(records: number[] = [], spent = 0): SpendStore & { records: number[] } {
  return {
    records,
    spentToday: () => spent,
    record: (usd: number) => { records.push(usd); },
  };
}

function makeServer(opts: {
  hybridEnabled: boolean;
  spend?: SpendStore;
  stateMap?: StateMap;
}) {
  const hits: Array<{ url: string }> = [];
  const fetchImpl = (async (url: string | URL) => {
    hits.push({ url: String(url) });
    if (String(url).startsWith("https://or.test")) {
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "paid answer" } }],
        usage: { cost: 0.07, prompt_tokens: 100, completion_tokens: 50 },
      }), { status: 200 });
    }
    return new Response("{}", { status: 429 }); // groq dead
  }) as unknown as typeof fetch;
  const app = buildServer({
    config: baseCfg(opts.hybridEnabled),
    providers: PROV,
    aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
    registry: registry(),
    stateMap: opts.stateMap ?? new Map([["groq::a", EXH], ["pool::groq", EXH]]),
    fetchImpl,
    spend: opts.spend,
  });
  return { app, hits };
}

const PAYLOAD = { model: "auto/coding", messages: [{ role: "user", content: "hello" }] };

describe("hybrid mode", () => {
  it("disabled: byte-for-byte unchanged exhaustion behavior, no spend, no paid calls", async () => {
    const off = await makeServer({ hybridEnabled: false }).app.inject({ method: "POST", url: "/v1/chat/completions", payload: PAYLOAD });
    const absent = await buildServer({
      config: { ...baseCfg(false), hybrid: undefined },
      providers: PROV,
      aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
      registry: registry(),
      stateMap: new Map([["groq::a", EXH], ["pool::groq", EXH]]),
      fetchImpl: (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch,
    }).inject({ method: "POST", url: "/v1/chat/completions", payload: PAYLOAD });
    expect(off.statusCode).toBe(503);
    expect(off.body).toBe(absent.body);
  });

  it("enabled + under cap: routes to the paid model after free fails and books reported cost", async () => {
    const records: number[] = [];
    const { app, hits } = makeServer({ hybridEnabled: true, spend: spyStore(records) });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: PAYLOAD });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-maxout-served-by"]).toBe(PAID_ID);
    expect(res.json().model).toBe(PAID_ID);
    expect(hits.some((h) => h.url.startsWith("https://or.test"))).toBe(true);
    expect(records).toEqual([0.07]);
  });

  it("cap reached: hard stop for the rest of the day regardless of free-pool timing", async () => {
    const { app, hits } = makeServer({ hybridEnabled: true, spend: spyStore([], 2.0) });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: PAYLOAD });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.type).toBe("all_models_exhausted");
    expect(hits.some((h) => h.url.startsWith("https://or.test"))).toBe(false);
  });

  it("healthy free capacity is never displaced by paid candidates", async () => {
    const records: number[] = [];
    const { app, hits } = makeServer({ hybridEnabled: true, spend: spyStore(records), stateMap: new Map() });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: PAYLOAD });
    expect(String(res.headers["x-maxout-served-by"])).toBe("groq::a");
    expect(records).toEqual([]);
    expect(hits.every((h) => !h.url.startsWith("https://or.test"))).toBe(true);
  });

  it("streaming paid answers book captured-token cost", async () => {
    const records: number[] = [];
    const store = spyStore(records);
    const hits: Array<{ url: string }> = [];
    const app = buildServer({
      config: baseCfg(true),
      providers: PROV,
      aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
      registry: registry(),
      stateMap: new Map([["groq::a", EXH], ["pool::groq", EXH]]),
      fetchImpl: (async (url: string | URL) => {
        hits.push({ url: String(url) });
        if (String(url).startsWith("https://or.test")) {
          const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
          const body = [
            frame({ choices: [{ delta: { content: "hi" } }] }),
            frame({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } }),
            "data: [DONE]\n\n",
          ].join("");
          return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        return new Response("{}", { status: 429 });
      }) as unknown as typeof fetch,
      spend: store,
    });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { ...PAYLOAD, stream: true } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-maxout-served-by"]).toBe(PAID_ID);
    // wait one macrotask for the pipe chain to flush before asserting
    await new Promise((r) => setTimeout(r, 25));
    expect(store.records.length).toBe(1);
    expect(store.records[0]).toBeCloseTo((1000 / 1e6) * DEFAULT_HYBRID.priceInPerMTok + (100 / 1e6) * DEFAULT_HYBRID.priceOutPerMTok, 8);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/hybrid.test.ts`
Expected: FAIL — no paid routing (503 in test 2), `spend` dep unused.

- [ ] **Step 3: Implement**

In `src/server.ts`:

1. Imports:

```typescript
import { hybridEntry, isPaidEntry, extractCost } from "./hybrid.js";
import type { SpendStore } from "./spend.js";
```

2. `ServerDeps` gains:

```typescript
  spend?: SpendStore;
```

3. In the handler, directly after the session-affinity block (candidates now final for free/local):

```typescript
    // Hybrid tier rides LAST: position-at-end means it is attempted only once
    // every free and local candidate has failed. Cap checked BEFORE injecting.
    const hyb = deps.config.hybrid;
    const paidReady =
      hyb?.enabled === true &&
      deps.spend !== undefined &&
      deps.spend.spentToday(Date.now()) < hyb.dailyCapUSD &&
      providers[hyb.provider] !== undefined;
    const paidEntry = paidReady && hyb ? hybridEntry(hyb) : undefined;
    if (paidEntry && !candidates.some((c) => c.id === paidEntry.id)) {
      candidates.push(paidEntry);
    }
```

4. After the successful execute, where `const servedId = result.servedBy.id;` lives, add:

```typescript
    const paid = paidEntry !== undefined && isPaidEntry(result.servedBy, hyb!);
```

5. Guard the free-ledger side effects. In the NON-STREAMING branch, replace the unconditional `recordServed(result.servedBy, {...});` block with:

```typescript
      if (paid) {
        const cost = extractCost(json, hyb!);
        if (cost > 0 && deps.spend) deps.spend.record(cost, Date.now());
      } else {
        recordServed(result.servedBy, {
          tokensIn: num(u?.prompt_tokens) ?? num(u?.total_tokens) ?? estTokens,
          tokensOut: num(u?.completion_tokens) ?? 0,
        });
      }
```

and change the reliability call to `if (!paid) note(servedId, true, started);`.

6. In the STREAMING epilogue, replace `recordServed(result.servedBy, capturedUsage);` and the trailing `note(...)` with:

```typescript
    if (paid) {
      if (deps.spend && hyb) {
        const cost = extractCost(
          { usage: { prompt_tokens: capturedUsage?.tokensIn ?? 0, completion_tokens: capturedUsage?.tokensOut ?? 0 } },
          hyb,
        );
        if (cost > 0) deps.spend.record(cost, Date.now());
      }
    } else {
      recordServed(result.servedBy, capturedUsage);
      note(servedId, !upstreamDied && streamVerdictBad === undefined, started,
        upstreamDied ? "stream-error" : streamVerdictBad !== undefined ? "malformed" : undefined);
    }
```

(The original `note(...)` call above the epilogue — the one attached to the non-stream path — stays guarded per step 5; ensure the streaming `note(...)` is the one removed here.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — especially the pre-existing 503 test (unchanged behavior) and all four new scenarios.

- [ ] **Step 5: Commit**

```powershell
git add src/server.ts test/integration/hybrid.test.ts
git commit -m "feat: opt-in paid fallback behind a hard daily spend cap"
```

---

### Task 4: Status display + serve wiring

**Files:**
- Modify: `src/cli.ts`
- Test: `test/unit/cli-hybrid.test.ts` (new)

**Interfaces:**
- Consumes: `loadSpend` (Task 1), `defaultSpendPath` (Task 1), `fileSpendStore` (Task 1).
- Produces: `cli.ts`: `formatHybridLine(spentUSD: number, capUSD: number): string`; `printStatus` prints it only when `cfg.hybrid?.enabled`; `serve` passes `spend: fileSpendStore(defaultSpendPath())`.

- [ ] **Step 1: Write failing tests**

Create `test/unit/cli-hybrid.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatHybridLine } from "../../src/cli.js";

describe("formatHybridLine", () => {
  it("renders dollars spent against the cap", () => {
    expect(formatHybridLine(0.42, 2)).toBe("hybrid: $0.42 / $2.00 spent today");
  });

  it("shows the wall plainly when capped", () => {
    expect(formatHybridLine(2, 2)).toBe("hybrid: $2.00 / $2.00 spent today");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/cli-hybrid.test.ts`
Expected: FAIL — export missing.

- [ ] **Step 3: Implement**

In `src/cli.ts`:

1. Imports:

```typescript
import { loadSpend, fileSpendStore } from "./spend.js";
```

(`defaultSpendPath` joins the existing `defaultXPath` import group from `./config.js`.)

2. Near `formatLocalLine`:

```typescript
export function formatHybridLine(spentUSD: number, capUSD: number): string {
  return `hybrid: $${spentUSD.toFixed(2)} / $${capUSD.toFixed(2)} spent today`;
}
```

3. At the end of `printStatus` (after the local line):

```typescript
  if (cfg.hybrid?.enabled) {
    console.log(formatHybridLine(loadSpend(defaultSpendPath())?.spentUSD ?? 0, cfg.hybrid.dailyCapUSD));
  }
```

4. In `serve`'s `buildServer({...})` call:

```typescript
      spend: fileSpendStore(defaultSpendPath()),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`; then `npm run build`. Expected: green, clean compile.

- [ ] **Step 5: Docs touch + commit**

Add to `README.md`'s feature list (exact bullet):

```markdown
- **Opt-in paid fallback** — set `hybrid.enabled` in `~/.maxout/config.json` with a hard `dailyCapUSD`; free and local capacity is always used first, spend is tracked locally, and the cap holds across restarts.
```

```powershell
git add src/cli.ts test/unit/cli-hybrid.test.ts README.md
git commit -m "feat: show hybrid spend in maxout status and wire the ledger"
```
