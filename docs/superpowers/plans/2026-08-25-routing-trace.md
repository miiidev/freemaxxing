# Routing Decision Traces Implementation Plan (Phase 2 — Plan F)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every routing decision inspectable — `maxout trace <request-id>` shows who was considered, why each loser lost (phase-1 taxonomy + `context-too-small`), and why the winner won — with bounded retention and zero prompt/response content ever touching the log.

**Architecture:** `resolve()` stops discarding its reasoning: every scanned entry gets a first-failing-predicate skip reason (`tags → tools → context-too-small → cooldown/exhausted/retired → provider-blocked → budget`) into `ResolveResult.considered`, and comparators become a labeled chain so `winnerReason` can't drift from behavior. The server assembles a `TraceRecord` per request (adding session-affinity / local-fallback / hybrid-paid reasons plus executor attempts), echoes a `x-maxout-request-id` header, and appends to a 500-record ring at `~/.maxout/traces.json`. CLI reads it back human-first, `--json` machine-readable.

**Tech Stack:** TypeScript (strict, ESM, Node >= 20), Fastify, vitest (fully offline).

**Spec:** `docs/superpowers/specs/2026-08-25-phase2-resilience-design.md` (§6)

## Global Constraints

- Node >= 20; TypeScript strict; ESM; local imports end in `.js`.
- Tests fully offline; inject fake `fetchImpl`.
- **Privacy invariant:** trace structures carry only ids, enum-ish reason strings, and numbers. Never add free-text fields derived from body content.
- No timers; persistence stays write-to-tmp + `renameSync`.
- Comments sparse, explain *why* only.
- Commits: `feat:` / `fix:` / `docs:` / `test:` prefixes, imperative mood.
- Shell is Windows PowerShell: `$env:X="y"`, chain with `if ($?) { }`.
- Full suite: `npm test`. Single file: `npx vitest run <file>`. Build check: `npm run build`.
- Module-global binds (`bindTraceFile`) leak between tests — every trace test resets with `bindTraceFile(null)` in `afterEach`.

## Dependencies & execution notes

- Lands LAST (handoff sequencing): consumes Plans A (`local-fallback`), B (`widened`, context skip), C (`affinityApplied`, `sKey`), E (`paidEntry`, `paid`).
- Skip-reason strings here are the contract surface for plans A–E outputs; none of them renamed anything — this plan owns the vocabulary.

## Deviations from spec (intentional)

None — spec §6 implemented as written. Recording is always-on once `serve` binds the trace file (bounded retention makes it safe); `--trace` adds live stderr lines rather than gating persistence.

## File Structure (final state)

| File | Responsibility |
|---|---|
| `src/router.ts` | `SkipReason`, `ConsideredCandidate`, labeled comparator chain, `considered` + `winnerReason` in result |
| `src/config.ts` | `defaultTracePath()` |
| `src/trace.ts` | NEW — `TraceRecord`, 500-ring append/load, formatters |
| `src/server.ts` | request ids, record assembly, header echo, optional live logging |
| `src/cli.ts` | `maxout trace [<id> | --last N] [--json]`, `serve --trace` |
| `test/unit/router-considered.test.ts` | NEW — skip-reason precedence + winner reasons |
| `test/unit/trace.test.ts` | NEW — ring, persistence, privacy allowlist |
| `test/integration/routing-trace.test.ts` | NEW — end-to-end scenario fidelity + content absence |
| `test/unit/cli-trace.test.ts` | NEW — command UX |

---

### Task 1: `resolve()` exposes its reasoning

**Files:**
- Modify: `src/router.ts`
- Test: `test/unit/router-considered.test.ts` (new)

**Interfaces:**
- Consumes: Plans A–B structure (`aliasCandidates`, `loopInput`, widen-back).
- Produces:
  - `router.ts`: `type SkipReason = "tags" | "tools" | "context-too-small" | "cooldown" | "exhausted" | "retired" | "provider-blocked" | "budget"`; `interface ConsideredCandidate { id: string; excludedBy?: SkipReason }`; `ResolveResult.considered: ConsideredCandidate[]`; `ResolveResult.winnerReason: string` (`"reliability-demoted" | "speed" | "tier" | "headroom" | "limited" | "id-tiebreak" | "sole-candidate"`)

- [ ] **Step 1: Write failing tests**

Create `test/unit/router-considered.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolve, BUILT_IN_ALIASES } from "../../src/router.js";
import type { RegistryEntry, ModelState, DailyCaps } from "../../src/types.js";

const OK: ModelState = { state: "ok" };
const COOL: ModelState = { state: "cooldown", until: Number.MAX_SAFE_INTEGER };
const EXH: ModelState = { state: "exhausted", until: Number.MAX_SAFE_INTEGER };
const CTX = { hasTools: false, estTokens: 1000 };
const DAY = Date.UTC(2026, 7, 25, 10, 0, 0);

function e(partial: Partial<RegistryEntry>): RegistryEntry {
  return {
    id: partial.id ?? `${partial.provider ?? "p"}::${partial.upstream ?? "m"}`,
    provider: partial.provider ?? "p",
    upstream: partial.upstream ?? "m",
    tags: partial.tags ?? ["chat"],
    tier: partial.tier ?? 2,
    speed: partial.speed ?? "medium",
    context: partial.context ?? 128000,
    maxOutput: partial.maxOutput,
    tools: partial.tools ?? true,
    limits: partial.limits,
  };
}

describe("considered list", () => {
  it("records first-failing predicate with the documented precedence", () => {
    const reg = [
      e({ id: "z::wrongtag", tags: ["vision"] }),
      e({ id: "z::notools", tools: false }),
      e({ id: "z::toosmall", context: 200 }),
      e({ id: "z::cool", provider: "q", upstream: "cool" }),
      e({ id: "z::pooldead", provider: "deadpool", upstream: "pd" }),
      e({ id: "z::spent", provider: "sp", upstream: "sp", limits: { rpd: 5 } }),
      e({ id: "z::kept", provider: "kp", upstream: "k", tier: 3 }),
    ];
    const states: Record<string, ModelState> = { "z::cool": COOL };
    const usage: Record<string, { day: string; requests: number; tokensIn: number; tokensOut: number }> = {
      "z::spent": { day: "2026-08-25", requests: 5, tokensIn: 0, tokensOut: 0 },
    };
    const out = resolve("auto/coding", BUILT_IN_ALIASES, reg, (id) => states[id] ?? OK, {
      ...CTX,
      harvest: true,
      now: DAY,
      getUsage: (id) => usage[id],
      getProviderState: (p) => (p === "deadpool" ? EXH : undefined),
    });
    const byId = Object.fromEntries(out.considered.map((c) => [c.id, c.excludedBy]));
    expect(byId["z::wrongtag"]).toBe("tags");
    expect(byId["z::notools"]).toBe("tools");
    expect(byId["z::toosmall"]).toBe("context-too-small");
    expect(byId["z::cool"]).toBe("cooldown");
    expect(byId["z::pooldead"]).toBe("provider-blocked");
    expect(byId["z::spent"]).toBe("budget");
    expect(byId["z::kept"]).toBeUndefined();
    // kept candidates appear rank-first
    expect(out.considered[0]).toEqual({ id: "z::kept" });
  });

  it("prefers model-state attribution over provider-blocked", () => {
    const reg = [e({ id: "q::dual", provider: "deadpool", upstream: "d" })];
    const out = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => COOL, {
      ...CTX,
      getProviderState: () => EXH,
    });
    expect(out.considered[0].excludedBy).toBe("cooldown");
  });

  it("reports retired distinctly", () => {
    const reg = [e({ id: "q::old", provider: "q", upstream: "o" })];
    const out = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => ({ state: "retired", since: 0 }), CTX);
    expect(out.considered[0].excludedBy).toBe("retired");
  });

  it("clears exclusions for candidates re-admitted by widen-back", () => {
    const reg = [
      e({ id: "t::a", provider: "t1", upstream: "a", tags: ["coding"], context: 2000, tier: 1 }),
      e({ id: "t::b", provider: "t2", upstream: "b", tags: ["coding"], context: 1500, tier: 2 }),
    ];
    const out = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, { hasTools: false, estTokens: 1800 });
    expect(out.widened).toBe(true);
    expect(out.candidates.map((c) => c.id)).toEqual(["t::a", "t::b"]);
    expect(out.considered.every((c) => c.excludedBy === undefined)).toBe(true);
  });
});

describe("winnerReason", () => {
  it("credits tier when that decides", () => {
    const reg = [
      e({ id: "a::one", tags: ["coding"], tier: 1 }),
      e({ id: "b::two", tags: ["coding"], tier: 2 }),
    ];
    expect(resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, CTX).winnerReason).toBe("tier");
  });

  it("credits reliability demotion over static tier", () => {
    const lim = (rpd: number): DailyCaps => ({ rpd });
    const reg = [
      e({ id: "a::one", tags: ["coding"], tier: 1, limits: lim(100) }),
      e({ id: "b::two", tags: ["coding"], tier: 2, limits: lim(100) }),
    ];
    const out = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, {
      ...CTX,
      harvest: true,
      now: DAY,
      getReliability: (id) => (id === "a::one" ? { score: 0.5, samples: 9 } : undefined),
      reliabilityCfg: { minSamples: 2, demoteBelow: 0.85 },
    });
    expect(out.winnerReason).toBe("reliability-demoted");
    expect(out.candidates[0].id).toBe("b::two");
  });

  it("credits speed for preferSpeed aliases", () => {
    const reg = [
      e({ id: "s::slowpoke", speed: "slow", tier: 1 }),
      e({ id: "s::quick", speed: "fast", tier: 4 }),
    ];
    expect(resolve("auto/fast", BUILT_IN_ALIASES, reg, () => OK, CTX).winnerReason).toBe("speed");
  });

  it("says sole-candidate when there is no contest", () => {
    const reg = [e({ id: "only::one", tags: ["coding"] })];
    expect(resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, CTX).winnerReason).toBe("sole-candidate");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/router-considered.test.ts`
Expected: FAIL — `considered`/`winnerReason` undefined on result.

- [ ] **Step 3: Implement**

In `src/router.ts`:

1. Types and result extension:

```typescript
export type SkipReason =
  | "tags" | "tools" | "context-too-small"
  | "cooldown" | "exhausted" | "retired"
  | "provider-blocked" | "budget";

export interface ConsideredCandidate {
  id: string;
  excludedBy?: SkipReason;
}

export interface ResolveResult {
  candidates: RegistryEntry[];
  skippedByBudget: RegistryEntry[];
  skippedByContext: RegistryEntry[];
  considered: ConsideredCandidate[];
  winnerReason: string;
  widened: boolean;
}
```

2. Inside `resolve`, replace the collection loop (Plan B's version) with a single attributed pass over the FULL registry:

```typescript
  const stateReason = (e: RegistryEntry): SkipReason | undefined => {
    if (effective(getState(e.id), now).state !== "ok") {
      const ms = effective(getState(e.id), now);
      if (ms.state === "cooldown") return "cooldown";
      if (ms.state === "exhausted") return "exhausted";
      return "retired";
    }
    const ps = ctx.getProviderState?.(e.provider);
    if (ps && effective(ps, now).state !== "ok") return "provider-blocked";
    return undefined;
  };

  const kept: RegistryEntry[] = [];
  const skippedByBudget: RegistryEntry[] = [];
  const skippedByContext: RegistryEntry[] = [];
  const considered: ConsideredCandidate[] = [];

  const tagOk = (e: RegistryEntry) =>
    !def.tags?.length || (def.tags as string[]).some((t) => e.tags.includes(t));
  const needsTools = def.requireTools === true || ctx.hasTools;

  for (const entry of registry) {
    let excludedBy: SkipReason | undefined;
    if (!tagOk(entry)) excludedBy = "tags";
    else if (needsTools && !entry.tools) excludedBy = "tools";
    else if (!contextOk(entry)) excludedBy = "context-too-small";
    else excludedBy = stateReason(entry);

    if (excludedBy) {
      if (excludedBy === "context-too-small") skippedByContext.push(entry);
      considered.push({ id: entry.id, excludedBy });
      continue;
    }
    if (!budgetOk(entry)) {
      skippedByBudget.push(entry);
      considered.push({ id: entry.id, excludedBy: "budget" });
      continue;
    }
    kept.push(entry);
    considered.push({ id: entry.id });
  }
```

(Note: `loopInput`/`aliasCandidates` remain exported for Plan A's gate, but are no longer the loop source — delete `loopInput` if it becomes unused.)

3. Widen-back gains bookkeeping so re-admitted ids lose their exclusion mark:

```typescript
  let widened = false;
  if (kept.length === 0 && skippedByContext.length > 0) {
    const reAdmitted = new Set<string>();
    for (const entry of skippedByContext) {
      if (stateReason(entry) !== undefined) continue;
      if (budgetOk(entry)) {
        kept.push(entry);
        reAdmitted.add(entry.id);
      } else {
        skippedByBudget.push(entry);
      }
    }
    widened = kept.length > 0;
    if (widened) {
      skippedByContext.length = 0;
      for (let i = 0; i < considered.length; i++) {
        if (considered[i].excludedBy === "context-too-small" && reAdmitted.has(considered[i].id)) {
          considered[i] = { id: considered[i].id };
        }
      }
    }
  }
```

4. Replace the anonymous `cmp` with a labeled chain and derive `winnerReason`:

```typescript
  type LabeledCmp = [label: string, fn: (a: RegistryEntry, b: RegistryEntry) => number];
  const chain: LabeledCmp[] = def.preferSpeed
    ? [
        ["reliability-demoted", (a, b) => demoted(a) - demoted(b)],
        ["speed", (a, b) => SPEED_RANK[a.speed] - SPEED_RANK[b.speed]],
        ["headroom", (a, b) => headroom(a) - headroom(b)],
        ["limited", (a, b) => limitedKey(a) - limitedKey(b)],
        ["tier", (a, b) => a.tier - b.tier],
      ]
    : [
        ["reliability-demoted", (a, b) => demoted(a) - demoted(b)],
        ["tier", (a, b) => a.tier - b.tier],
        ["headroom", (a, b) => headroom(a) - headroom(b)],
        ["limited", (a, b) => limitedKey(a) - limitedKey(b)],
        ["speed", (a, b) => SPEED_RANK[a.speed] - SPEED_RANK[b.speed]],
      ];
  chain.push(["id-tiebreak", (a, b) => a.id.localeCompare(b.id)]);

  kept.sort((a, b) => chain.reduce((acc, [, fn]) => acc || fn(a, b), 0));

  let winnerReason = "sole-candidate";
  if (kept.length > 1) {
    winnerReason = chain.find(([, fn]) => fn(kept[0], kept[1]) !== 0)?.[0] ?? "id-tiebreak";
  }

  return { candidates: kept, skippedByBudget, skippedByContext, considered, winnerReason, widened };
```

(The old `cmp` ternary and final `return` are deleted.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS everywhere — result fields are additive and ordering math is identical (the reduce IS the old chained `||` composition).

- [ ] **Step 5: Commit**

```powershell
git add src/router.ts test/unit/router-considered.test.ts
git commit -m "feat: resolve reports per-candidate skip reasons and winner rationale"
```

---

### Task 2: Trace ring buffer + formatters

**Files:**
- Create: `src/trace.ts`
- Modify: `src/config.ts` (`defaultTracePath`)
- Test: `test/unit/trace.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `config.ts`: `defaultTracePath(): string` (`~/.maxout/traces.json`)
  - `trace.ts`: `TRACE_CAP = 500`; `TraceRecord` (shape below); `bindTraceFile(f: string | null)`; `appendTrace(r: TraceRecord): TraceRecord[]`; `loadTraces(f: string): TraceRecord[]`; `tracesEnabled(): boolean`; `formatTrace(r: TraceRecord): string`; `formatTraceList(rs: TraceRecord[]): string[]`

```typescript
export interface TraceRecord {
  requestId: string;
  ts: number;
  alias: string;
  sessionKey?: string;
  estTokens: number;
  widened: boolean;
  considered: Array<{ id: string; excludedBy?: string }>;
  picked?: string;
  pickedReason: string;
  attempts: Array<{ model: string; reason: string }>;
  servedBy?: string;
}
```

- [ ] **Step 1: Write failing tests**

Create `test/unit/trace.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TRACE_CAP, bindTraceFile, appendTrace, loadTraces,
  formatTrace, formatTraceList, tracesEnabled, type TraceRecord,
} from "../../src/trace.js";

afterEach(() => bindTraceFile(null));

const T0 = Date.UTC(2026, 7, 25, 12, 0, 0);

function rec(i: number): TraceRecord {
  return {
    requestId: `r${i}-abc123`,
    ts: T0 + i,
    alias: "auto/coding",
    estTokens: 1200,
    widened: false,
    considered: [
      { id: "groq::a" },
      { id: "openrouter::x", excludedBy: "cooldown" },
      { id: "cerebras::y", excludedBy: "provider-blocked" },
    ],
    picked: "groq::a",
    pickedReason: "tier",
    attempts: [{ model: "groq::a", reason: "ok" }],
    servedBy: "groq::a",
  };
}

describe("ring buffer", () => {
  it("starts disabled", () => {
    expect(tracesEnabled()).toBe(false);
  });

  it("caps retention at TRACE_CAP newest records", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-trace-")), "traces.json");
    bindTraceFile(file);
    for (let i = 0; i < TRACE_CAP + 7; i++) appendTrace(rec(i));
    const all = loadTraces(file);
    expect(all).toHaveLength(TRACE_CAP);
    expect(all[0]?.requestId).toBe("r7-abc123");
    expect(all[TRACE_CAP - 1]?.requestId).toBe(`r${TRACE_CAP + 6}-abc123`);
  });

  it("returns empty on corrupt or missing files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-trace-"));
    expect(loadTraces(path.join(dir, "missing.json"))).toEqual([]);
    const corrupt = path.join(dir, "corrupt.json");
    fs.writeFileSync(corrupt, "{oops");
    expect(loadTraces(corrupt)).toEqual([]);
  });

  it("appends nothing anywhere while unbound", () => {
    expect(appendTrace(rec(1))).toHaveLength(1);
  });
});

describe("privacy allowlist", () => {
  it("serialized records contain only routing metadata keys", () => {
    const r = rec(9);
    const allowed = new Set([
      "requestId", "ts", "alias", "sessionKey", "estTokens", "widened",
      "considered", "picked", "pickedReason", "attempts", "servedBy",
    ]);
    const keysOf = (obj: unknown): string[] => {
      if (typeof obj !== "object" || obj === null) return [];
      return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
        Array.isArray(v) ? v.flatMap(keysOf) : typeof v === "object" && v !== null ? [k, ...keysOf(v)] : [k],
      );
    };
    for (const k of keysOf(JSON.parse(JSON.stringify(r)))) {
      expect(allowed.has(k)).toBe(true);
    }
  });
});

describe("formatters", () => {
  it("renders human-readable detail including taxonomy reasons", () => {
    const text = formatTrace(rec(3));
    expect(text).toContain("r3-abc123");
    expect(text).toContain("auto/coding");
    expect(text).toContain("picked=groq::a (tier)");
    expect(text).toContain("openrouter::x");
    expect(text).toContain("cooldown");
    expect(text).toContain("provider-blocked");
  });

  it("renders compact list lines", () => {
    const lines = formatTraceList([rec(1), rec(2)]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("r1-abc123");
    expect(lines[0]).toContain("-> groq::a");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/trace.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

In `src/config.ts`, with the other path helpers:

```typescript
export function defaultTracePath(): string {
  return path.join(os.homedir(), ".maxout", "traces.json");
}
```

Create `src/trace.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";

export interface TraceRecord {
  requestId: string;
  ts: number;
  alias: string;
  sessionKey?: string;
  estTokens: number;
  widened: boolean;
  considered: Array<{ id: string; excludedBy?: string }>;
  picked?: string;
  pickedReason: string;
  attempts: Array<{ model: string; reason: string }>;
  servedBy?: string;
}

// Bounded by design — routing forensics, not an audit archive.
export const TRACE_CAP = 500;

let file: string | null = null;

export function bindTraceFile(f: string | null): void {
  file = f;
}

export function tracesEnabled(): boolean {
  return file !== null;
}

export function loadTraces(f: string): TraceRecord[] {
  if (!fs.existsSync(f)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r): r is TraceRecord =>
        typeof r === "object" && r !== null &&
        typeof (r as TraceRecord).requestId === "string" &&
        typeof (r as TraceRecord).ts === "number" &&
        typeof (r as TraceRecord).alias === "string")
      .slice(-TRACE_CAP);
  } catch {
    return [];
  }
}

function saveTraces(target: string, records: TraceRecord[]): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records));
  fs.renameSync(tmp, target);
}

export function appendTrace(record: TraceRecord): TraceRecord[] {
  const all = file ? loadTraces(file) : [];
  const next = [...all, record].slice(-TRACE_CAP);
  if (file) saveTraces(file, next);
  return next;
}

export function formatTrace(t: TraceRecord): string {
  const lines: string[] = [];
  lines.push(`${t.requestId}  ${new Date(t.ts).toISOString()}  alias=${t.alias}  estTokens=${t.estTokens}`);
  if (t.sessionKey) lines.push(`session=${t.sessionKey}`);
  if (t.widened) lines.push("context filter widened (nothing fit)");
  lines.push(`picked=${t.picked ?? "-"} (${t.pickedReason})`);
  if (t.servedBy && t.servedBy !== t.picked) lines.push(`served=${t.servedBy}`);
  lines.push("considered:");
  t.considered.forEach((c, i) => {
    lines.push(`  ${c.excludedBy ? `skipped=${c.excludedBy}` : `candidate #${i + 1}`}  ${c.id}`);
  });
  if (t.attempts.length > 0) {
    lines.push("attempts:");
    for (const a of t.attempts) lines.push(`  ${a.model} -> ${a.reason}`);
  }
  return lines.join("\n");
}

export function formatTraceList(records: TraceRecord[]): string[] {
  return records.map(
    (r) => `${r.requestId}  ${new Date(r.ts).toISOString()}  ${r.alias}  -> ${r.picked ?? "-"} (${r.pickedReason})`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/trace.test.ts test/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/trace.ts src/config.ts test/unit/trace.test.ts
git commit -m "feat: bounded routing-trace store with metadata-only records"
```

---

### Task 3: Server assembly — ids, records, headers

**Files:**
- Modify: `src/server.ts`
- Test: `test/integration/routing-trace.test.ts` (new)

**Interfaces:**
- Consumes: `resolved.considered/winnerReason` (Task 1); `TraceRecord`/`appendTrace` (Task 2); Plans A/C/E locals (`candidates`, `sKey`, `affinityApplied`, `affinity`, `paidEntry`, `paid`, `hyb`).
- Produces: `ServerDeps.liveTraceLog?: boolean` — when true, one stderr line per request; response header `x-maxout-request-id` on every completion (JSON + streaming).

- [ ] **Step 1: Write failing tests**

Create `test/integration/routing-trace.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildServer } from "../../src/server.js";
import { bindTraceFile, loadTraces } from "../../src/trace.js";
import type { AppConfig, ActiveProvider } from "../../src/config.js";
import type { ModelState } from "../../src/types.js";
import type { StateMap } from "../../src/state.js";

afterEach(() => bindTraceFile(null));

const CFG: AppConfig = {
  port: 8787, host: "127.0.0.1", aliases: {},
  providers: { groq: { apiKeyEnv: "GROQ_API_KEY" } },
  annotateResponses: false, harvest: true,
};
const PROV: Record<string, ActiveProvider> = {
  groq: { baseURL: "https://groq.test/v1", auth: "bearer", quirks: "groq",
          resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk" },
};

const SECRET = "SECRET_TOKEN_ABC_DO_NOT_LOG";

function makeServer(stateMap: StateMap) {
  const traceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-rtrace-")), "traces.json");
  bindTraceFile(traceFile);
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    // echo the caller's secret back so we can prove it never lands in traces
    const echo = String(init?.body ?? "").includes(SECRET) ? SECRET : "clean";
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: `reply:${echo}` } }],
    }), { status: 200 });
  }) as unknown as typeof fetch;
  const app = buildServer({
    config: CFG, providers: PROV,
    aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
    registry: [
      { id: "groq::cooled", provider: "groq", upstream: "u-cooled", tags: ["coding", "chat"], tier: 1, speed: "fast", context: 128000, maxOutput: 8192, tools: true },
      { id: "groq::winner", provider: "groq", upstream: "u-winner", tags: ["coding", "chat"], tier: 2, speed: "fast", context: 128000, maxOutput: 8192, tools: true },
    ],
    stateMap,
    fetchImpl,
  });
  return { app, traceFile };
}

describe("routing traces", () => {
  it("matches the actual routing decision, skip reasons included", async () => {
    const stateMap: StateMap = new Map([
      ["groq::cooled", { state: "cooldown", until: Date.now() + 60_000, reason: "peak-throttle" }],
    ]);
    const { app, traceFile } = makeServer(stateMap);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding", messages: [{ role: "user", content: SECRET }] },
    });
    expect(res.statusCode).toBe(200);
    const rid = res.headers["x-maxout-request-id"];
    expect(typeof rid).toBe("string");

    const records = loadTraces(traceFile);
    expect(records).toHaveLength(1);
    const t = records[0];
    expect(t.requestId).toBe(rid);
    expect(t.picked).toBe("groq::winner");
    expect(t.servedBy).toBe("groq::winner");
    const byId = Object.fromEntries(t.considered.map((c) => [c.id, c.excludedBy]));
    expect(byId["groq::cooled"]).toBe("cooldown");
    expect(byId["groq::winner"]).toBeUndefined();
    expect(t.attempts.some((a) => a.model === "groq::winner")).toBe(true);
  });

  it("never records prompt or response content", async () => {
    const { app, traceFile } = makeServer(new Map());
    await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding", messages: [{ role: "user", content: SECRET }] },
    });
    const raw = fs.readFileSync(traceFile, "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("reply:"); // response-derived text stays out too
  });

  it("logs exhaustion decisions with pickedReason=all-exhausted", async () => {
    const traceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-rtrace-")), "traces.json");
    bindTraceFile(traceFile);
    const app = buildServer({
      config: CFG, providers: PROV,
      aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
      registry: [
        { id: "groq::only", provider: "groq", upstream: "u", tags: ["coding"], tier: 1, speed: "fast", context: 128000, maxOutput: 8192, tools: true },
      ],
      stateMap: new Map(),
      fetchImpl: (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch,
    });
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(503);
    const t = loadTraces(traceFile)[0];
    expect(t.picked).toBeUndefined();
    expect(t.pickedReason).toBe("all-exhausted");
    expect(t.attempts.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/routing-trace.test.ts`
Expected: FAIL — no `x-maxout-request-id` header; empty traces file.

- [ ] **Step 3: Implement**

In `src/server.ts`:

1. Imports:

```typescript
import { appendTrace, tracesEnabled, type TraceRecord } from "./trace.js";
```

2. `ServerDeps` gains `liveTraceLog?: boolean;`

3. In `buildServer`, extend the counter area:

```typescript
  let reqCounter = 0;
  const newRequestId = (): string => `r${++reqCounter}-${Math.random().toString(36).slice(2, 8)}`;
```

4. In the handler, right after `estTokens` is computed:

```typescript
    const requestId = newRequestId();
```

5. Capture stickiness before Plan C's post-success `set()`. In the success path, directly above the existing line `if (sKey) affinity.set(sKey, servedId);`, insert:

```typescript
    const wasSticky = sKey ? affinity.get(sKey) : undefined;
    if (sKey) affinity.set(sKey, servedId);
```

(The original `if (sKey) affinity.set(...)` is kept as shown; `wasSticky` feeds pickedReason below.)

6. Immediately after the `paid` determination and before the non-streaming branch, assemble and append:

```typescript
    if (tracesEnabled()) {
      const pickedReason = paid
        ? "hybrid-paid"
        : result.servedBy.provider === "local"
          ? "local-fallback"
          : affinityApplied || wasSticky === servedId
            ? "session-affinity"
            : resolved.winnerReason;
      const record: TraceRecord = {
        requestId,
        ts: started,
        alias,
        ...(sKey ? { sessionKey: sKey } : {}),
        estTokens,
        widened: resolved.widened,
        considered: resolved.considered.map((c) => ({ ...c })),
        picked: servedId,
        pickedReason,
        attempts: result.attempts.map((a) => ({ model: a.model, reason: a.reason })),
        servedBy: servedId,
      };
      appendTrace(record);
      if (deps.liveTraceLog) {
        console.error(`trace ${requestId}: ${pickedReason} -> ${servedId}`);
      }
    }
```

7. On the failure branch (`if (!result.ok) {`), prepend the record before the reply:

```typescript
      if (tracesEnabled()) {
        appendTrace({
          requestId,
          ts: started,
          alias,
          ...(sKey ? { sessionKey: sKey } : {}),
          estTokens,
          widened: resolved.widened,
          considered: resolved.considered.map((c) => ({ ...c })),
          pickedReason: "all-exhausted",
          attempts: result.attempts.map((a) => ({ model: a.model, reason: a.reason })),
        });
      }
      return reply.code(503).send(/* unchanged */);
```

8. Echo the id: add `reply.header("x-maxout-request-id", requestId);` next to the existing `x-maxout-served-by` header in the JSON branch, and extend the streaming `writeHead` headers object with `"x-maxout-request-id": requestId`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — including Plans A–E suites (header addition is additive; `inject()` surfaces it automatically).

- [ ] **Step 5: Commit**

```powershell
git add src/server.ts test/integration/routing-trace.test.ts
git commit -m "feat: assemble and persist per-request routing traces"
```

---

### Task 4: `maxout trace` command + `serve --trace`

**Files:**
- Modify: `src/cli.ts`
- Test: `test/unit/cli-trace.test.ts` (new)

**Interfaces:**
- Consumes: `loadTraces`, `formatTrace`, `formatTraceList` (Task 2); `defaultTracePath` (Task 2); `bindTraceFile` (Task 2).
- Produces: `runCli(["trace", ...])` dispatch; `serve --trace` enables `liveTraceLog`.

- [ ] **Step 1: Write failing tests**

Create `test/unit/cli-trace.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.js";
import { bindTraceFile, appendTrace, type TraceRecord } from "../../src/trace.js";

afterEach(() => bindTraceFile(null));

function seed(count = 2): TraceRecord[] {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-clitrace-")), "traces.json");
  bindTraceFile(file);
  const base: Omit<TraceRecord, "requestId"> = {
    ts: Date.UTC(2026, 7, 25, 12, 0, 0),
    alias: "auto/coding",
    estTokens: 900,
    widened: false,
    considered: [{ id: "groq::a" }],
    picked: "groq::a",
    pickedReason: "sole-candidate",
    attempts: [],
    servedBy: "groq::a",
  };
  const made = Array.from({ length: count }, (_, i) =>
    appendTrace({ ...base, requestId: `r${i + 1}-xyz` }));
  void made;
  return loadTraces(file);
}

describe("maxout trace", () => {
  it("prints a specific record by id (human-readable)", async () => {
    seed(1);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const code = await runCli(["trace", "r1-xyz"]);
    vi.restoreAllMocks();
    expect(code).toBe(0);
    expect(out.join("")).toContain("picked=groq::a (sole-candidate)");
  });

  it("lists recent records with --last and emits JSON with --json", async () => {
    seed(2);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const code = await runCli(["trace", "--last", "--json"]);
    vi.restoreAllMocks();
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].requestId).toBe("r1-xyz");
  });

  it("errors politely on unknown ids and missing args", async () => {
    seed(1);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    expect(await runCli(["trace", "nope"])).toBe(1);
    expect(await runCli(["trace"])).toBe(64);
    vi.restoreAllMocks();
    expect(err.join("")).toContain("no trace for 'nope'");
    expect(err.join("")).toContain("usage:");
  });
});
```

(`serve --trace` flag wiring is covered end-to-end by the Task 3 integration suite plus the existing server suites; it needs no dedicated unit test here.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/cli-trace.test.ts`
Expected: FAIL — `runCli` rejects `trace` (falls through to usage, exit 64).

- [ ] **Step 3: Implement**

In `src/cli.ts`:

1. Imports:

```typescript
import { loadTraces, formatTrace, formatTraceList, bindTraceFile } from "./trace.js";
```

2. New command function near `reviveCmd`:

```typescript
function traceCmd(argv: string[]): number {
  const json = argv.includes("--json");
  const records = loadTraces(defaultTracePath());
  if (argv.includes("--last")) {
    const lastIdx = argv.indexOf("--last");
    const nRaw = argv[lastIdx + 1];
    const n = nRaw && /^\d+$/.test(nRaw) ? Number(nRaw) : 20;
    const list = records.slice(-n);
    if (json) process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    else for (const line of formatTraceList(list)) console.log(line);
    return 0;
  }
  const id = argv.slice(1).find((a) => !a.startsWith("-"));
  if (!id) {
    process.stderr.write("usage: maxout trace <request-id | --last [N]> [--json]\n");
    return 64;
  }
  const rec = records.find((r) => r.requestId === id);
  if (!rec) {
    process.stderr.write(`no trace for '${id}'\n`);
    return 1;
  }
  if (json) process.stdout.write(`${JSON.stringify(rec, null, 2)}\n`);
  else console.log(formatTrace(rec));
  return 0;
}
```

3. Dispatch in `runCli`, next to `export-stats`:

```typescript
  if (cmd === "trace") {
    return traceCmd(argv);
  }
```

4. In the `serve` branch's `buildServer({...})` call:

```typescript
      liveTraceLog: argv.includes("--trace"),
```

and beside the other `bind*File` calls:

```typescript
    bindTraceFile(defaultTracePath());
```

5. Update the bottom usage string:

```typescript
  process.stderr.write("usage: maxout [serve|status|setup|trace|export-stats|revive]\n");
```

(`defaultTracePath` joins the `defaultXPath` import group from `./config.js`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`; then `npm run build`. Expected: green, clean compile.

- [ ] **Step 5: Docs touch + commit**

Add to `README.md`'s feature list (exact bullets):

```markdown
- **Routing you can audit** — every request gets an id (`x-maxout-request-id`); `maxout trace <id>` shows the full candidate list, each skip reason, and why the winner won. Last 500 requests kept locally; prompts and responses are never recorded.
- **Live trace** — run `maxout serve --trace` to stream one-line routing decisions to stderr while serving.
```

```powershell
git add src/cli.ts test/unit/cli-trace.test.ts README.md
git commit -m "feat: maxout trace command and serve --trace live logging"
```
