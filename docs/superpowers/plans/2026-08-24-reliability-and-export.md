# Reliability Scoring, Export-Stats & Privacy Positioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-curated tier list's blind spots with a self-healing signal — a rolling per-model reliability window that demotes flaky models — expose it via `freeroll status --reliability`, let users share anonymized snapshots with `freeroll export-stats`, and state freeroll's local-first/privacy story plainly in the README.

**Architecture:** `src/reliability.ts` stores per-model outcome events (`ok`, latency, kind) in `~/.freeroll/reliability.json`, pruned lazily to `min(windowSize, last 7 days)` on every write (no timers — project pattern). The server records outcomes at its two commit points (response validated / stream closed). `resolve()` prepends a demotion term to both alias comparators when a model has enough samples and a score under `demoteBelow`. Export is a pure projection over the same store with an allowlisted field set; it runs only when invoked.

**Tech Stack:** TypeScript (strict, ESM, Node >= 20), Fastify, vitest (fully offline).

**Spec:** `docs/superpowers/specs/2026-08-24-next-level-design.md` (§4, §5, §6, §8 decision 6)

## Global Constraints

- Node >= 20; TypeScript strict; ESM; local imports end in `.js`.
- Tests fully offline; inject fake `fetchImpl`.
- No timers: pruning happens on read/write against a passed `now`.
- Persistence: atomic tmp+rename (pattern in `state.ts`).
- Latency is tracked/display-only — never part of the score.
- Demotion reorders candidates; it never removes them.
- `export-stats` must be inert unless invoked; output fields are allowlisted (`id`, `score`, `samples`, `avgLatencyMs`) plus top-level metadata.
- Comments sparse, explain *why*.
- Commits: `feat:` / `feat!:` avoided / `docs:` / `test:` prefixes, imperative mood.
- PowerShell shell; chain with `if ($?) { }`.
- Full suite: `npm test`. Single file: `npx vitest run <file>`. Build: `npm run build`.

## Deviations from spec (intentional)

1. Spec's example window is "last 200 requests or last 7 days, whichever is smaller". Implemented as an AND-prune (keep events satisfying both constraints) evaluated on every write with the caller's clock.
2. `status --reliability` renders a dedicated table (not extra columns on the health table) so the two views stay independently parseable.
3. Plan B dependency: malformed outcomes arrive through the same `onMalformed` hook Plan B introduced. Without Plan B executed yet, everything else (success/stream-error outcomes, scoring, demotion, export) works; scores simply never see `kind:"malformed"`.

## File Structure (final state)

| File | Responsibility |
|---|---|
| `src/reliability.ts` (new) | store, prune, stats, demotion predicate, snapshot builder |
| `src/config.ts` | `reliability` config block; `defaultReliabilityPath()` |
| `src/router.ts` + `src/types.ts` | ctx hooks `getReliability` / `reliabilityCfg`; demotion-first comparators |
| `src/server.ts` | outcome recording at commit points; `deps.reliabilityMap` |
| `src/cli.ts` | serve binds file; `status --reliability`; `export-stats [--out]` |
| `README.md` | reliability + local-first/privacy sections |

---

### Task 1: Reliability store, stats, demotion predicate

**Files:**
- Create: `src/reliability.ts`
- Create: `test/unit/reliability.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (exact names later tasks rely on):
  - `interface OutcomeEvent { ts: number; ok: boolean; latencyMs?: number; kind?: string }`
  - `type ReliabilityMap = Map<string, OutcomeEvent[]>`
  - `interface ReliabilityConfig { windowSize: number; minSamples: number; demoteBelow: number }`
  - `DEFAULT_RELIABILITY: ReliabilityConfig` = `{ windowSize: 200, minSamples: 10, demoteBelow: 0.85 }`
  - `bindReliabilityFile(file: string | null): void`, `loadReliability(file: string, now?: number, cfg?: ReliabilityConfig): ReliabilityMap`, `saveReliability(file: string, map: ReliabilityMap, cfg?: ReliabilityConfig, now?: number): void`, `recordOutcome(map: ReliabilityMap, modelId: string, ev: OutcomeEvent, cfg?: ReliabilityConfig, now?: number): void`
  - `pruneEvents(events: OutcomeEvent[], cfg: ReliabilityConfig, now: number): OutcomeEvent[]`
  - `stats(events: OutcomeEvent[]): { score: number | null; samples: number; avgLatencyMs: number | null }`
  - `isDemoted(s: { score: number | null; samples: number }, cfg: Pick<ReliabilityConfig, "minSamples" | "demoteBelow">): boolean`

- [ ] **Step 1: Write failing tests**

Create `test/unit/reliability.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_RELIABILITY, bindReliabilityFile, loadReliability,
  recordOutcome, saveReliability, pruneEvents, stats, isDemoted,
  type ReliabilityMap, type ReliabilityConfig, type OutcomeEvent,
} from "../../src/reliability.js";

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const CFG: ReliabilityConfig = { windowSize: 3, minSamples: 2, demoteBelow: 0.85 };
const ev = (over: Partial<OutcomeEvent>): OutcomeEvent => ({ ts: T0, ok: true, ...over });

describe("pruneEvents", () => {
  it("keeps only the newest windowSize events", () => {
    const events = [
      ev({ ts: T0 }), ev({ ts: T0 + 1 }), ev({ ts: T0 + 2 }), ev({ ts: T0 + 3 }),
    ];
    expect(pruneEvents(events, CFG, T0 + 4)).toEqual([
      ev({ ts: T0 + 1 }), ev({ ts: T0 + 2 }), ev({ ts: T0 + 3 }),
    ]);
  });

  it("drops events older than 7 days even when window not full", () => {
    const events = [ev({ ts: T0 - 8 * DAY }), ev({ ts: T0 - DAY })];
    expect(pruneEvents(events, DEFAULT_RELIABILITY, T0)).toEqual([ev({ ts: T0 - DAY })]);
  });
});

describe("recordOutcome", () => {
  let map: ReliabilityMap;
  beforeEach(() => {
    map = new Map();
    bindReliabilityFile(null);
  });

  it("appends under the model id and prunes", () => {
    recordOutcome(map, "m::a", ev({}), CFG, T0);
    recordOutcome(map, "m::a", ev({ ts: T0 + 1, ok: false }), CFG, T0 + 2);
    expect(map.get("m::a")).toHaveLength(2);
    for (let i = 0; i < 4; i++) recordOutcome(map, "m::a", ev({ ts: T0 + 10 + i }), CFG, T0 + 20);
    expect(map.get("m::a")).toHaveLength(CFG.windowSize);
  });

  it("persists through bindReliabilityFile and reloads", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-rel-")), "reliability.json");
    bindReliabilityFile(file);
    recordOutcome(map, "m::a", ev({ latencyMs: 120 }), DEFAULT_RELIABILITY, T0);
    expect(loadReliability(file, T0 + DAY).get("m::a")).toEqual([ev({ latencyMs: 120 })]);
  });
});

describe("stats", () => {
  it("empty events -> nulls", () => {
    expect(stats([])).toEqual({ score: null, samples: 0, avgLatencyMs: null });
  });
  it("computes success fraction and average latency over timed events", () => {
    const events = [
      ev({ ts: T0, ok: true, latencyMs: 100 }),
      ev({ ts: T0 + 1, ok: false }),
      ev({ ts: T0 + 2, ok: true, latencyMs: 300 }),
    ];
    expect(stats(events)).toEqual({ score: 2 / 3, samples: 3, avgLatencyMs: 200 });
  });
});

describe("isDemoted", () => {
  it("false under minSamples regardless of score", () => {
    expect(isDemoted({ score: 0.1, samples: CFG.minSamples - 1 }, CFG)).toBe(false);
  });
  it("true when enough samples and strictly below demoteBelow", () => {
    expect(isDemoted({ score: 0.84, samples: CFG.minSamples }, CFG)).toBe(true);
  });
  it("boundary: score exactly at demoteBelow stays undemoted", () => {
    expect(isDemoted({ score: 0.85, samples: CFG.minSamples }, CFG)).toBe(false);
  });
});

describe("persistence edge cases", () => {
  beforeEach(() => bindReliabilityFile(null));

  it("corrupt file loads empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-rel2-"));
    fs.writeFileSync(path.join(dir, "reliability.json"), "{nope");
    expect(loadReliability(path.join(dir, "reliability.json"), T0).size).toBe(0);
  });

  it("saveReliability writes atomically-replaced valid JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-rel3-"));
    const file = path.join(dir, "nested", "reliability.json");
    const map: ReliabilityMap = new Map([["m::a", [ev({})]]]);
    saveReliability(file, map, DEFAULT_RELIABILITY, T0);
    expect(loadReliability(file, T0 + DAY).get("m::a")).toEqual([ev({})]);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/reliability.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/reliability.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";

export interface OutcomeEvent {
  ts: number;
  ok: boolean;
  latencyMs?: number;
  kind?: string;
}

export type ReliabilityMap = Map<string, OutcomeEvent[]>;

export interface ReliabilityConfig {
  windowSize: number;
  minSamples: number;
  demoteBelow: number;
}

export const DEFAULT_RELIABILITY: ReliabilityConfig = {
  windowSize: 200,
  minSamples: 10,
  demoteBelow: 0.85,
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let file: string | null = null;

export function bindReliabilityFile(f: string | null): void {
  file = f;
}

// Rolling window = newest `windowSize` events AND nothing older than 7 days.
// Evaluated on every write against the caller's clock — no timers anywhere.
export function pruneEvents(
  events: OutcomeEvent[],
  cfg: ReliabilityConfig,
  now: number,
): OutcomeEvent[] {
  const cutoff = now - SEVEN_DAYS_MS;
  const fresh = events.filter((e) => e.ts > cutoff);
  return fresh.slice(Math.max(0, fresh.length - cfg.windowSize));
}

export function saveReliability(
  fileTarget: string,
  map: ReliabilityMap,
  cfg: ReliabilityConfig = DEFAULT_RELIABILITY,
  now: number = Date.now(),
): void {
  fs.mkdirSync(path.dirname(fileTarget), { recursive: true });
  const obj: Record<string, OutcomeEvent[]> = {};
  for (const [id, events] of map) {
    const pruned = pruneEvents(events, cfg, now);
    if (pruned.length > 0) obj[id] = pruned;
  }
  const tmp = `${fileTarget}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, fileTarget);
}

function isValidEvent(v: unknown): v is OutcomeEvent {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.ts === "number" && typeof e.ok === "boolean";
}

export function loadReliability(
  f: string,
  now: number = Date.now(),
  cfg: ReliabilityConfig = DEFAULT_RELIABILITY,
): ReliabilityMap {
  const map: ReliabilityMap = new Map();
  if (!fs.existsSync(f)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return map;
    for (const [id, events] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(events)) continue;
      const valid = events.filter(isValidEvent);
      if (valid.length > 0) map.set(id, pruneEvents(valid, cfg, now));
    }
  } catch {
    // corrupt snapshot: start fresh
  }
  return map;
}

export function recordOutcome(
  map: ReliabilityMap,
  modelId: string,
  e: OutcomeEvent,
  cfg: ReliabilityConfig = DEFAULT_RELIABILITY,
  now: number = Date.now(),
): void {
  const events = map.get(modelId) ?? [];
  events.push(e);
  map.set(modelId, pruneEvents(events, cfg, Math.max(now, e.ts)));
  if (file) saveReliability(file, map, cfg, now);
}

export interface ReliabilityStats {
  score: number | null;
  samples: number;
  avgLatencyMs: number | null;
}

export function stats(events: OutcomeEvent[]): ReliabilityStats {
  if (events.length === 0) return { score: null, samples: 0, avgLatencyMs: null };
  const successes = events.filter((e) => e.ok).length;
  const timed = events.filter((e) => typeof e.latencyMs === "number");
  const avg = timed.length
    ? timed.reduce((sum, e) => sum + (e.latencyMs ?? 0), 0) / timed.length
    : null;
  return { score: successes / events.length, samples: events.length, avgLatencyMs: avg };
}

// Display-only metric: latency informs humans, never the demotion decision.
export function isDemoted(
  s: { score: number | null; samples: number },
  cfg: Pick<ReliabilityConfig, "minSamples" | "demoteBelow">,
): boolean {
  if (s.samples < cfg.minSamples) return false;
  if (s.score === null) return false;
  return s.score < cfg.demoteBelow;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/reliability.test.ts && npm run build`
Expected: PASS; clean build.

- [ ] **Step 5: Commit**

```powershell
git add src/reliability.ts test/unit/reliability.test.ts
git commit -m "feat: rolling-window reliability store and scoring primitives"
```

---

### Task 2: Config surface

**Files:**
- Modify: `src/config.ts`
- Modify: `test/unit/reliability.test.ts` (append config describe)

**Interfaces:**
- Consumes: `ReliabilityConfig`, `DEFAULT_RELIABILITY` (Task 1).
- Produces:
  - `AppConfig.reliability: ReliabilityConfig` (defaults merged per-field from file overrides)
  - `defaultReliabilityPath(): string` → `~/.freeroll/reliability.json`

- [ ] **Step 1: Write failing tests**

Append to `test/unit/reliability.test.ts`:

```typescript
import { loadConfig, defaultReliabilityPath } from "../../src/config.js";

describe("config reliability block", () => {
  it("defaults when absent", () => {
    const cfg = loadConfig(null);
    expect(cfg.reliability).toEqual(DEFAULT_RELIABILITY);
  });

  it("merges per-field from file with defaults for missing keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-cfg-rel-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ reliability: { demoteBelow: 0.5 } }));
    const cfg = loadConfig(file);
    expect(cfg.reliability).toEqual({ windowSize: 200, minSamples: 10, demoteBelow: 0.5 });
  });

  it("ignores invalid values instead of throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-cfg-rel2-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ reliability: { windowSize: -5, minSamples: "x" } }));
    const cfg = loadConfig(file);
    expect(cfg.reliability).toEqual(DEFAULT_RELIABILITY);
  });

  it("defaultReliabilityPath lands in ~/.freeroll", () => {
    expect(defaultReliabilityPath().replace(/\\/g, "/")).toMatch(/\.freeroll\/reliability\.json$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/reliability.test.ts`
Expected: FAIL — `cfg.reliability` undefined; `defaultReliabilityPath` missing.

- [ ] **Step 3: Implement**

In `src/config.ts`:

```typescript
import { DEFAULT_RELIABILITY, type ReliabilityConfig } from "./reliability.js";
```

Add to `AppConfig`:

```typescript
  reliability: ReliabilityConfig;
```

Initialize in `loadConfig`'s default object:

```typescript
    reliability: { ...DEFAULT_RELIABILITY },
```

Merge overrides before the closing `return cfg;`:

```typescript
    if (raw.reliability && typeof raw.reliability === "object") {
      const r = raw.reliability as Partial<ReliabilityConfig>;
      if (typeof r.windowSize === "number" && r.windowSize > 0) cfg.reliability.windowSize = r.windowSize;
      if (typeof r.minSamples === "number" && r.minSamples >= 0) cfg.reliability.minSamples = r.minSamples;
      if (typeof r.demoteBelow === "number" && r.demoteBelow > 0 && r.demoteBelow <= 1) {
        cfg.reliability.demoteBelow = r.demoteBelow;
      }
    }
```

Add the path helper beside the others:

```typescript
export function defaultReliabilityPath(): string {
  return path.join(os.homedir(), ".freeroll", "reliability.json");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/reliability.test.ts && npm test && npm run build`
Expected: PASS everywhere (`loadConfig(null)` callers in other suites gain the default harmlessly).

- [ ] **Step 5: Commit**

```powershell
git add src/config.ts test/unit/reliability.test.ts
git commit -m "feat: reliability tuning block in config"
```

---

### Task 3: Router demotion sort

**Files:**
- Modify: `src/types.ts` (ctx fields)
- Modify: `src/router.ts`
- Modify: `test/unit/router.test.ts` (append)

**Interfaces:**
- Consumes: `stats`/`isDemoted` semantics (Task 1) — router consumes pre-computed `{score, samples}` via ctx to stay pure.
- Produces: `RequestCtx.getReliability?: (id: string) => { score: number | null; samples: number } | undefined` and `RequestCtx.reliabilityCfg?: Pick<ReliabilityConfig, "minSamples" | "demoteBelow">`. Demoted models order AFTER all undemoted ones in BOTH comparators; relative order among equally-demoted models follows the existing chain.

- [ ] **Step 1: Write failing tests**

Append to `test/unit/router.test.ts`:

```typescript
describe("reliability demotion", () => {
  const REL_CTX = (
    scores: Record<string, { score: number | null; samples: number }>,
    cfg = { minSamples: 2, demoteBelow: 0.85 },
  ) => ({
    ...CTX,
    harvest: true as const,
    now: DAY,
    getUsage: () => undefined,
    getReliability: (id: string) => scores[id],
    reliabilityCfg: cfg,
  });

  it("low-score tier-1 model sinks below fresh tier-3 model", () => {
    const scores = { "a::one": { score: 0.5, samples: 9 } };
    const { candidates } = resolve("auto/coding", BUILT_IN_ALIASES, LIMITED, () => OK, REL_CTX(scores));
    expect(candidates.map((x) => x.id)).toEqual(["b::two", "a::one"]);
  });

  it("under-sampled models keep static ranking (no new-model penalty)", () => {
    const scores = { "a::one": { score: 0.5, samples: 1 } };
    const { candidates } = resolve("auto/coding", BUILT_IN_ALIASES, LIMITED, () => OK, REL_CTX(scores));
    expect(candidates.map((x) => x.id)).toEqual(["a::one", "b::two"]);
  });

  it("no reliability data at all -> untouched ordering", () => {
    const { candidates } = resolve("auto/coding", BUILT_IN_ALIASES, LIMITED, () => OK, REL_CTX({}));
    expect(candidates.map((x) => x.id)).toEqual(["a::one", "b::two"]);
  });
});
```

(`LIMITED` gives `a::one` tier 1 and `b::two` tier 2 with equal rpd caps — already defined above in this file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/router.test.ts`
Expected: FAIL — ctx hooks ignored, original order kept.

- [ ] **Step 3: Implement**

`src/types.ts` — extend `RequestCtx`:

```typescript
  getReliability?: (id: string) => { score: number | null; samples: number } | undefined;
  reliabilityCfg?: { minSamples: number; demoteBelow: number };
```

`src/router.ts` — add above the comparator definitions inside `resolve()`:

```typescript
  // Self-healing override: proven-flaky models sink below everyone, whatever
  // their static tier; under-sampled models are never penalized.
  const demoted = (e: RegistryEntry): number => {
    if (!ctx.getReliability || !ctx.reliabilityCfg) return 0;
    const s = ctx.getReliability(e.id);
    if (!s || s.samples < ctx.reliabilityCfg.minSamples || s.score === null) return 0;
    return s.score < ctx.reliabilityCfg.demoteBelow ? 1 : 0;
  };

  const cmp = def.preferSpeed
    ? (a: RegistryEntry, b: RegistryEntry) =>
        demoted(a) - demoted(b) ||
        SPEED_RANK[a.speed] - SPEED_RANK[b.speed] ||
        headroom(a) - headroom(b) ||
        limitedKey(a) - limitedKey(b) ||
        a.tier - b.tier ||
        a.id.localeCompare(b.id)
    : (a: RegistryEntry, b: RegistryEntry) =>
        demoted(a) - demoted(b) ||
        a.tier - b.tier ||
        headroom(a) - headroom(b) ||
        limitedKey(a) - limitedKey(b) ||
        SPEED_RANK[a.speed] - SPEED_RANK[b.speed] ||
        a.id.localeCompare(b.id);
```

(replacing the current `cmp` definition wholesale).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/router.test.ts && npm test && npm run build`
Expected: PASS everywhere (callers passing neither hook behave identically).

- [ ] **Step 5: Commit**

```powershell
git add src/types.ts src/router.ts test/unit/router.test.ts
git commit -m "feat: demote proven-unreliable models below static tiers"
```

---

### Task 4: Server outcome recording

**Files:**
- Modify: `src/server.ts`
- Modify: `test/integration/server.test.ts` (append)

**Interfaces:**
- Consumes: `recordOutcome`, `ReliabilityMap`, `ReliabilityConfig` (Task 1); `onMalformed` hook (Plan B Task 3); `sseToolCallGuard.onVerdict` (Plan B Task 5).
- Produces:
  - `ServerDeps.reliabilityMap?: ReliabilityMap` (optional; absent ⇒ no recording, existing tests untouched).
  - Recording contract:
    - malformed verdict (either path) → `{ ts, ok:false, kind:"malformed" }`
    - non-streaming success → `{ ts, ok:true, latencyMs }`
    - streaming close clean → `{ ts, ok:true, latencyMs }`
    - mid-stream upstream error → `{ ts, ok:false, kind:"stream-error", latencyMs }`

- [ ] **Step 1: Write failing tests**

Append to `test/integration/server.test.ts`:

```typescript
import { recordOutcome, type ReliabilityMap } from "../../src/reliability.js";

function relServer(fetchImpl: typeof fetch, relMap: ReliabilityMap) {
  return buildServer({
    config: CFG,
    providers: PROV,
    aliases: BUILT_IN_ALIASES,
    registry: [{ ...REGISTRY.find((e) => e.id === "groq::openai/gpt-oss-20b")! }],
    stateMap: new Map(),
    fetchImpl,
    reliabilityMap: relMap,
  });
}

describe("reliability recording", () => {
  it("records ok with latency on non-streaming success", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { choices: [{ finish_reason: "stop", message: { content: "hi" } }] })
    ) as unknown as typeof fetch;
    const relMap: ReliabilityMap = new Map();
    const app = relServer(fetchImpl, relMap);
    await app.inject({ method: "POST", url: "/v1/chat/completions",
      payload: { messages: [{ role: "user", content: "hello" }] } });
    const events = relMap.get("groq::openai/gpt-oss-20b")!;
    expect(events).toHaveLength(1);
    expect(events[0].ok).toBe(true);
    expect(typeof events[0].latencyMs).toBe("number");
  });

  it("records stream-error outcome when upstream dies mid-stream", async () => {
    const fetchImpl = (async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n'], 0)
    ) as unknown as typeof fetch;
    const relMap: ReliabilityMap = new Map();
    const app = relServer(fetchImpl, relMap);
    await app.inject({ method: "POST", url: "/v1/chat/completions",
      payload: { stream: true, messages: [{ role: "user", content: "hello" }] } });
    const events = relMap.get("groq::openai/gpt-oss-20b")!;
    expect(events[0].ok).toBe(false);
    expect(events[0].kind).toBe("stream-error");
  });

  it("records clean streaming close as ok", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const fetchImpl = (async () => sseResponse([sse])) as unknown as typeof fetch;
    const relMap: ReliabilityMap = new Map();
    const app = relServer(fetchImpl, relMap);
    await app.inject({ method: "POST", url: "/v1/chat/completions",
      payload: { stream: true, messages: [{ role: "user", content: "hello" }] } });
    expect(relMap.get("groq::openai/gpt-oss-20b")![0].ok).toBe(true);
  });
});
```

Note: `jsonResponse`/`sseResponse` helpers live in executor.test.ts / streaming.test.ts respectively — inline them here (server.test.ts has neither). Add at top of the new describes:

```typescript
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function sseResponse(chunks: string[], errorAfterIndex?: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < chunks.length; i++) {
        controller.enqueue(encoder.encode(chunks[i]));
        if (errorAfterIndex !== undefined && i === errorAfterIndex) {
          controller.error(new Error("boom"));
          return;
        }
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/server.test.ts`
Expected: FAIL — `reliabilityMap` dep unknown / no events recorded.

- [ ] **Step 3: Implement**

`src/server.ts` imports:

```typescript
import { recordOutcome, type ReliabilityMap } from "./reliability.js";
```

Extend `ServerDeps`:

```typescript
  reliabilityMap?: ReliabilityMap;
```

Inside `buildServer`, near the top:

```typescript
  const relMap = deps.reliabilityMap;
  const relCfg = deps.config.reliability;
  const note = (modelId: string, ok: boolean, startedAt: number, kind?: string) => {
    if (!relMap) return;
    recordOutcome(relMap, modelId, {
      ts: Date.now(),
      ok,
      ...(kind ? { kind } : {}),
      latencyMs: Date.now() - startedAt,
    }, relCfg);
  };
```

Non-streaming branch — record just before `return json;`:

```typescript
      note(servedId, true, started);
      return json;
```

(Place it immediately before the annotateResponses block is fine too — any point after successful parse; choose directly above `return json;` so annotation mutations cannot affect timing semantics of the outcome.)

The `onMalformed` closure built earlier gains the second write (full replacement):

```typescript
      onMalformed: needsTools
        ? (modelId, reason) => {
            recordMalformed(modelId, reason);
            if (relMap) {
              recordOutcome(relMap, modelId, {
                ts: Date.now(), ok: false, kind: "malformed", latencyMs: Date.now() - started,
              }, relCfg);
            }
          }
        : undefined,
```

Streaming section — track the two failure flags and record once at close (this REPLACES the simpler guard creation introduced by the tool-call-validation plan's streaming task — same position in the handler, same pipeline):

```typescript
    let streamVerdictBad: string | undefined;
    const guard = needsTools
      ? sseToolCallGuard({
          tools: requestedTools,
          onVerdict: (v) => {
            if (!v.ok) {
              streamVerdictBad = v.reason ?? "unknown";
              recordMalformed(servedId, streamVerdictBad);
            }
          },
        })
      : undefined;
    let upstreamDied = false;
```

In the unified per-link error loop (introduced by the tool-call-validation plan's streaming task), set the flag where the upstream frame is written:

```typescript
    for (const link of [upstream, rewriter, ...(guard ? [guard] : []), capture, ...(tail ? [tail] : [])]) {
      link.on("error", () => {
        if (!reply.raw.writableEnded) {
          if (link === upstream) {
            upstreamDied = true;
            reply.raw.write(`data: {"freeroll_error":"upstream_stream_failed"}\n\n`);
          }
          reply.raw.end();
        }
      });
    }
```

After the close-await Promise, before `recordServed(...)`:

```typescript
    note(servedId, !upstreamDied && streamVerdictBad === undefined, started,
      upstreamDied ? "stream-error" : streamVerdictBad !== undefined ? "malformed" : undefined);
```

`src/cli.ts` serve branch wiring:

```typescript
import { loadReliability, bindReliabilityFile } from "./reliability.js";
import { defaultReliabilityPath } from "./config.js";
```

```typescript
    bindReliabilityFile(defaultReliabilityPath()); // outcomes survive restarts like usage counters
```

and pass to `buildServer({...})`:

```typescript
      reliabilityMap: loadReliability(defaultReliabilityPath()),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/server.test.ts && npm test && npm run build`
Expected: PASS everywhere.

- [ ] **Step 5: Commit**

```powershell
git add src/server.ts src/cli.ts test/integration/server.test.ts
git commit -m "feat: record per-model reliability outcomes at serve points"
```

---

### Task 5: `status --reliability` and `export-stats`

**Files:**
- Modify: `src/cli.ts`
- Modify: `README.md` (brief command mentions)
- Create: `test/unit/export-stats.test.ts`

**Interfaces:**
- Consumes: `loadReliability`, `stats`, `isDemoted` (Task 1); `defaultReliabilityPath`, config (Task 2).
- Produces:
  - `buildExportSnapshot(cfg: AppConfig, entries: { id: string }[], map: ReliabilityMap, now: number): { generatedAt: string; window: ReliabilityConfig; models: Array<{ id: string; score: number | null; samples: number; avgLatencyMs: number | null }> }`
  - CLI: `freeroll status --reliability` prints the dedicated table; `freeroll export-stats [--out FILE]` prints JSON to stdout or writes FILE atomically.

- [ ] **Step 1: Write failing tests**

Create `test/unit/export-stats.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExportSnapshot } from "../../src/cli.js";
import { loadConfig } from "../../src/config.js";
import type { ReliabilityMap } from "../../src/reliability.js";

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);

describe("buildExportSnapshot", () => {
  it("allowlists fields and skips zero-sample models", () => {
    const map: ReliabilityMap = new Map([
      ["a::good", [
        { ts: NOW, ok: true, latencyMs: 100 },
        { ts: NOW + 1, ok: true, latencyMs: 300 },
        { ts: NOW + 2, ok: false },
      ]],
      ["b::empty", []],
    ]);
    const snap = buildExportSnapshot(loadConfig(null), [{ id: "a::good" }, { id: "b::empty" }, { id: "c::unseen" }], map, NOW);
    expect(snap.generatedAt).toBe(new Date(NOW).toISOString());
    expect(snap.models).toHaveLength(1);
    expect(Object.keys(snap.models[0]).sort()).toEqual(["avgLatencyMs", "id", "samples", "score"]);
    expect(snap.models[0]).toEqual({ id: "a::good", score: 2 / 3, samples: 3, avgLatencyMs: 200 });
  });

  it("carries the effective window config for consumers", () => {
    const snap = buildExportSnapshot(loadConfig(null), [], new Map(), NOW);
    expect(snap.window).toEqual(loadConfig(null).reliability);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/export-stats.test.ts`
Expected: FAIL — `buildExportSnapshot` not exported.

- [ ] **Step 3: Implement**

`src/cli.ts` imports:

```typescript
import { loadReliability, stats, isDemoted, type ReliabilityMap } from "./reliability.js";
import { defaultReliabilityPath } from "./config.js";
```

Add exported builder + renderers:

```typescript
export function buildExportSnapshot(
  cfg: AppConfig,
  registryIds: Array<{ id: string }>,
  map: ReliabilityMap,
  now: number,
): {
  generatedAt: string;
  window: AppConfig["reliability"];
  models: Array<{ id: string; score: number | null; samples: number; avgLatencyMs: number | null }>;
} {
  const models = registryIds
    .map(({ id }) => ({ id, ...stats(map.get(id) ?? []) }))
    .filter((m) => m.samples > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map(({ id, score, samples, avgLatencyMs }) => ({ id, score, samples, avgLatencyMs }));
  return { generatedAt: new Date(now).toISOString(), window: cfg.reliability, models };
}

async function printReliabilityTable(): Promise<void> {
  const cfg = loadConfig(defaultConfigPath());
  const map = loadReliability(defaultReliabilityPath(), Date.now(), cfg.reliability);
  console.log("freeroll reliability (rolling window)");
  console.log("");
  for (const entry of applyModelLimits(REGISTRY, cfg.modelLimits)) {
    const s = stats(map.get(entry.id) ?? []);
    const demoted = isDemoted(s, cfg.reliability) ? "  <-- DEMOTED" : "";
    const scoreCol = s.score === null ? "-" : s.score.toFixed(2);
    const latCol = s.avgLatencyMs === null ? "-" : `${Math.round(s.avgLatencyMs)}ms`;
    console.log(`${entry.id.padEnd(50)} score=${scoreCol}  n=${String(s.samples).padStart(4)}  avg=${latCol}${demoted}`);
  }
}

function exportStatsCmd(argv: string[]): number {
  const cfg = loadConfig(defaultConfigPath());
  const map = loadReliability(defaultReliabilityPath(), Date.now(), cfg.reliability);
  const snapshot = buildExportSnapshot(cfg, REGISTRY, map, Date.now());
  const json = JSON.stringify(snapshot, null, 2);
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  if (!outPath) {
    process.stdout.write(json + "\n");
    return 0;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, outPath);
  process.stderr.write(`wrote ${outPath}\n`);
  return 0;
}
```

Add `import fs from "node:fs"; import path from "node:path";` at the top of cli.ts if absent.

Routing updates in `runCli`:

```typescript
  if (cmd === "status") {
    if (argv.includes("--reliability")) {
      await printReliabilityTable();
    } else {
      await printStatus();
    }
    return 0;
  }

  if (cmd === "export-stats") {
    return exportStatsCmd(argv);
  }
```

Update the usage line: `[serve|status|export-stats|revive]`.

README — under "Quota harvest" add:

```markdown
## Reliability

Freeroll tracks how each model actually behaves for you (validation results,
truncations, latency) in a rolling local window and demotes proven-flaky
models beneath their static tier. See the numbers:

    node dist/cli.js status --reliability

Share an anonymized snapshot (model ids, rates, sample counts — nothing else)
when asked:

    node dist/cli.js export-stats --out freeroll-stats.json
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/export-stats.test.ts && npm test && npm run build`
Expected: PASS; clean build.

- [ ] **Step 5: Manual check**

Run: `node dist/cli.js export-stats`
Expected: JSON with empty `models` on a fresh machine; exit code 0.

- [ ] **Step 6: Commit**

```powershell
git add src/cli.ts README.md test/unit/export-stats.test.ts
git commit -m "feat: status --reliability view and opt-in export-stats"
```

---

### Task 6: Privacy acceptance test + README local-first section

**Files:**
- Modify: `test/unit/export-stats.test.ts` (append pipeline leak test)
- Modify: `README.md`

**Interfaces:**
- Consumes: full stack (server → malformed events → reliability map → snapshot).
- Produces: automated proof that sensitive strings never reach exports; README claims audited against actual persisted-data inventory.

- [ ] **Step 1: Write failing test**

Append to `test/unit/export-stats.test.ts`:

```typescript
import { buildServer } from "../../src/server.js";
import type { ActiveProvider } from "../../src/config.js";
import { BUILT_IN_ALIASES } from "../../src/router.js";
import { bindMalformedFile } from "../../src/malformed.js";

const SENTINEL_PROMPT = "SECRET_SENTINEL_PROMPT_42";
const SENTINEL_PATH = "C:/users/me/SECRET_FILE.txt";
const SENTINEL_KEY = "sk-SENTINEL-API-KEY";

describe("export privacy (pipeline leak test)", () => {
  it("prompt content, paths, and keys never reach the snapshot", async () => {
    const PROV: Record<string, ActiveProvider> = {
      p: { baseURL: "https://p.test/v1", auth: "bearer", quirks: "groq",
           resetProfile: { kind: "daily-utc-midnight" }, apiKey: SENTINEL_KEY },
    };
    const registry = [{
      id: "p::flaky", provider: "p", upstream: "flaky",
      tags: ["coding"], tier: 1, speed: "fast", context: 32000, tools: true,
    }];
    const fetchImpl = (async () =>
      new Response(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [{ function: { name: "patch", arguments: '{"path":' } }] },
        }],
      }), { status: 200 })) as unknown as typeof fetch;

    const relMap: ReliabilityMap = new Map();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-privacy-"));
    bindMalformedFile(path.join(dir, "m.jsonl"));
    const app = buildServer({
      config: { ...loadConfig(null), providers: { p: { apiKeyEnv: "P_KEY" } } },
      providers: PROV,
      aliases: BUILT_IN_ALIASES,
      registry,
      stateMap: new Map(),
      fetchImpl,
      reliabilityMap: relMap,
    });
    await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: {
        model: "auto/coding",
        messages: [{ role: "user", content: `fix ${SENTINEL_PROMPT} in ${SENTINEL_PATH}` }],
        tools: [{ type: "function", function: { name: "patch" } }],
      },
    });
    bindMalformedFile(null);

    const snapshot = JSON.stringify(buildExportSnapshot(loadConfig(null), registry, relMap, Date.now()));
    expect(snapshot).not.toContain(SENTINEL_PROMPT);
    expect(snapshot).not.toContain(SENTINEL_PATH);
    expect(snapshot).not.toContain(SENTINEL_KEY);

    const malformedRaw = fs.readFileSync(path.join(dir, "m.jsonl"), "utf8");
    expect(malformedRaw).not.toContain(SENTINEL_PROMPT);
    expect(malformedRaw).not.toContain(SENTINEL_PATH);
  });
});
```

This test should PASS already if Tasks 1–5 landed correctly — it exists to lock the guarantee. If it fails, fix the implementation, never weaken the assertion.

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/unit/export-stats.test.ts`
Expected: PASS.

- [ ] **Step 3: Add the README section**

Insert before "## Development":

```markdown
## Local-first & privacy

Freeroll is deliberately boring about your data:

- Your API keys live only in your environment (or `%USERPROFILE%\.freeroll\.env`)
  and go directly to the provider you called. Freeroll has no telemetry, no
  phoning home, and no third party in the middle — requests leave your machine
  straight for OpenRouter/Groq/Google/Mistral/Cerebras.
- Prompt and response bodies are never written to disk. What IS stored locally
  under `%USERPROFILE%\.freeroll\`: daily spend counters (`usage.json`), model
  health states (`state.json`), quality outcomes as numbers (`reliability.json`),
  rejection reason codes (`malformed.jsonl`), and console lines naming which
  model answered.
- `freeroll export-stats` is the ONLY feature that produces shareable data. It
  runs solely when you invoke it and emits an allowlisted, anonymized summary
  (see above). Nothing is sent anywhere unless you send it.
```

Accuracy audit before committing (do this, then tick the box):

- [ ] Confirmed `grep -ri "appendFileSync\|writeFileSync\|createWriteStream" src/` touches only: `usage.json`, `state.json`, `reliability.json`, `malformed.jsonl`, `.env` (setup phase), `--out` target.
- [ ] Confirmed no `fetch` calls exist outside `executor.ts`/`setup`-phase code paths toward non-provider URLs.
- [ ] Confirmed console logging (`log.ts`, server) emits model ids/status/duration only.

- [ ] **Step 4: Full verification**

Run: `npm test; if ($?) { npm run build }`
Expected: all green; build clean.

- [ ] **Step 5: Commit**

```powershell
git add test/unit/export-stats.test.ts README.md
git commit -m "docs+test: local-first privacy positioning backed by leak tests"
```

---

## Completion checklist (Plan C)

- [ ] `npm test` green; `npm run build` clean.
- [ ] Acceptance: `freeroll status --reliability` shows per-model success rate + sample count (Task 5).
- [ ] Acceptance: forced repeated failures drop a model below a higher-static-tier peer within the configured window (Task 3 test 1 drives the mechanism; drive the full-loop version via Task 4's malformed outcome if Plan B is present).
- [ ] Acceptance: export contains no prompt/path/key material — enforced by test, not review (Task 6).
- [ ] Feature inert unless invoked: no startup network calls; export only on command (Tasks 4–6).
