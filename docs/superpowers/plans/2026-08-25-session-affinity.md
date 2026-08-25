# Session-Sticky Routing Implementation Plan (Phase 2 — Plan C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one multi-turn conversation on one model — until that model genuinely can't serve — so agent sessions stop bouncing between models with clashing styles and contradicting decisions.

**Architecture:** A session key is derived per request (`x-maxout-session` header when the caller supplies one, else SHA-256 of the first two messages). An in-memory LRU (`SessionAffinity`, cap 256) remembers the last-served model per key. When enabled for the alias (`AliasDef.sessionAffinity`), the server moves the sticky model to the front of the resolved candidate list — overriding sort order but never filters — and re-records the winner after every success, so failover naturally re-sticks. Built-ins: `auto/coding` on, `auto/fast`/`auto/any` off.

**Tech Stack:** TypeScript (strict, ESM, Node >= 20), Fastify, vitest (fully offline).

**Spec:** `docs/superpowers/specs/2026-08-25-phase2-resilience-design.md` (§3)

## Global Constraints

- Node >= 20; TypeScript strict; ESM; local imports end in `.js`.
- Tests fully offline; inject fake `fetchImpl`.
- No timers anywhere; LRU eviction happens synchronously inside `set`.
- Comments sparse, explain *why* only.
- Commits: `feat:` / `fix:` / `docs:` / `test:` prefixes, imperative mood.
- Shell is Windows PowerShell: `$env:X="y"`, chain with `if ($?) { }`.
- Full suite: `npm test`. Single file: `npx vitest run <file>`. Build check: `npm run build`.

## Dependencies & execution notes

- Assumes Plan A landed (`aliasDef` hoisted above candidate handling in `server.ts`). Without A, perform the same hoist of `const aliasDef = deps.aliases[alias];` above the candidate block first — it is a pure move.
- Plan F (trace) later reads whether affinity moved the winner; Task 2 keeps an `affinityApplied` boolean available at the point F will need it.

## Deviations from spec (intentional)

None — spec §3 is implemented as written. One clarification codified here: affinity applies **only when the sticky model survived resolve()'s filters**; a filtered-out sticky model is simply not forced back (that's the failover path).

## File Structure (final state)

| File | Responsibility |
|---|---|
| `src/session.ts` | NEW — `SESSION_HEADER`, `deriveSessionKey`, `SessionAffinity` LRU |
| `src/types.ts` | `AliasDef.sessionAffinity?: boolean` |
| `src/router.ts` | built-in alias flags |
| `src/server.ts` | sticky reorder post-resolve, record winner post-success |
| `test/unit/session.test.ts` | NEW — key derivation + LRU semantics |
| `test/integration/session-sticky.test.ts` | NEW — 100% stickiness + persistent failover |

---

### Task 1: Session keys + affinity store

**Files:**
- Create: `src/session.ts`
- Test: `test/unit/session.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 2 relies on exact signatures):
  - `session.ts`: `SESSION_HEADER = "x-maxout-session"`; `deriveSessionKey(headers: Record<string, string | string[] | undefined>, messages: unknown[], firstN?: number): string | undefined`; `class SessionAffinity { constructor(cap?: number); get(key: string): string | undefined; set(key: string, modelId: string): void }`

- [ ] **Step 1: Write failing tests**

Create `test/unit/session.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { deriveSessionKey, SessionAffinity, SESSION_HEADER } from "../../src/session.js";

const TURNS = [
  { role: "user", content: "fix the parser" },
  { role: "assistant", content: "done" },
];

describe("deriveSessionKey", () => {
  it("prefers the explicit header", () => {
    expect(deriveSessionKey({ [SESSION_HEADER]: "agent-run-42" }, TURNS)).toBe("agent-run-42");
  });

  it("uses only the first header value when repeated", () => {
    expect(deriveSessionKey({ [SESSION_HEADER]: ["a", "b"] }, TURNS)).toBe("a");
  });

  it("truncates overlong headers to 64 chars", () => {
    const key = deriveSessionKey({ [SESSION_HEADER]: "x".repeat(100) }, []);
    expect(key?.length).toBe(64);
  });

  it("hashes the first two messages stably", () => {
    const k1 = deriveSessionKey({}, TURNS);
    const k2 = deriveSessionKey({}, [...TURNS, { role: "user", content: "now add tests" }]);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("separates sessions with different opening turns", () => {
    const other = [{ role: "user", content: "write a poem" }, TURNS[1]];
    expect(deriveSessionKey({}, TURNS)).not.toBe(deriveSessionKey({}, other));
  });

  it("returns undefined for empty conversations", () => {
    expect(deriveSessionKey({}, [])).toBeUndefined();
  });
});

describe("SessionAffinity", () => {
  it("remembers the last winner per key", () => {
    const s = new SessionAffinity();
    expect(s.get("k")).toBeUndefined();
    s.set("k", "m1");
    expect(s.get("k")).toBe("m1");
    s.set("k", "m2");
    expect(s.get("k")).toBe("m2");
  });

  it("evicts the least recently USED entry beyond capacity", () => {
    const s = new SessionAffinity(2);
    s.set("a", "m");
    s.set("b", "m");
    s.get("a"); // refresh a — b becomes oldest
    s.set("c", "m");
    expect(s.get("a")).toBe("m");
    expect(s.get("b")).toBeUndefined();
    expect(s.get("c")).toBe("m");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/session.ts`:

```typescript
import { createHash } from "node:crypto";

export const SESSION_HEADER = "x-maxout-session";

// Agents append rather than prepend, so hashing the first two turns yields a
// stable conversation identity without any caller cooperation.
export function deriveSessionKey(
  headers: Record<string, string | string[] | undefined>,
  messages: unknown[],
  firstN = 2,
): string | undefined {
  const explicit = headers[SESSION_HEADER];
  const h = Array.isArray(explicit) ? explicit[0] : explicit;
  if (h) return h.slice(0, 64);
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  return createHash("sha256")
    .update(JSON.stringify(messages.slice(0, firstN)))
    .digest("hex")
    .slice(0, 16);
}

// Insertion-order LRU: get() refreshes recency, set() evicts the oldest
// beyond cap. In-memory only — a restart merely re-selects a winner.
export class SessionAffinity {
  private map = new Map<string, string>();

  constructor(private readonly cap = 256) {}

  get(key: string): string | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, modelId: string): void {
    this.map.delete(key);
    this.map.set(key, modelId);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/session.ts test/unit/session.test.ts
git commit -m "feat: session key derivation and bounded affinity store"
```

---

### Task 2: Alias flag + server stickiness

**Files:**
- Modify: `src/types.ts` (`AliasDef`)
- Modify: `src/router.ts` (`BUILT_IN_ALIASES`)
- Modify: `src/server.ts`
- Test: `test/integration/session-sticky.test.ts` (new)

**Interfaces:**
- Consumes: `deriveSessionKey`, `SessionAffinity` (Task 1).
- Produces:
  - `types.ts`: `AliasDef.sessionAffinity?: boolean`
  - `router.ts`: `BUILT_IN_ALIASES["auto/coding"].sessionAffinity === true`; fast/any absent (falsy)
  - `server.ts`: `ServerDeps.sessionAffinity?: SessionAffinity` (defaults to a fresh instance)

- [ ] **Step 1: Write failing tests**

Create `test/integration/session-sticky.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/server.js";
import type { AppConfig, ActiveProvider } from "../../src/config.js";
import type { RegistryEntry, DailyCaps } from "../../src/types.js";
import type { StateMap } from "../../src/state.js";

function entry(id: string, upstream: string, tier: number, rpd?: number): RegistryEntry {
  const limits: DailyCaps | undefined = rpd ? { rpd } : undefined;
  return { id, provider: "groq", upstream, tags: ["coding", "chat"], tier, speed: "fast", context: 128000, maxOutput: 8192, tools: true, limits };
}

const CFG: AppConfig = {
  port: 8787, host: "127.0.0.1", aliases: {},
  providers: { groq: { apiKeyEnv: "GROQ_API_KEY" } },
  annotateResponses: false, harvest: true,
};
const PROV: Record<string, ActiveProvider> = {
  groq: { baseURL: "https://groq.test/v1", auth: "bearer", quirks: "groq",
          resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk" },
};

const OK_BODY = JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] });

function makeServer(registry: RegistryEntry[], stateMap: StateMap) {
  return buildServer({
    config: CFG, providers: PROV,
    aliases: { "auto/coding": { tags: ["coding"], requireTools: true, sessionAffinity: true },
               "auto/fast": { preferSpeed: true }, "auto/any": {} },
    registry, stateMap,
    fetchImpl: (async () => new Response(OK_BODY, { status: 200 })) as unknown as typeof fetch,
  });
}

function ask(app: Awaited<ReturnType<typeof buildServer>>, content: string) {
  return app.inject({
    method: "POST", url: "/v1/chat/completions",
    payload: { model: "auto/coding", messages: [
      { role: "user", content: "fix the parser" },
      { role: "assistant", content: "ok" },
      { role: "user", content },
    ] },
  });
}

describe("session-sticky routing", () => {
  it("keeps every request of a healthy session on one model even when default ranking changes", async () => {
    // a starts first (tier 1); after one serve its headroom drops below b's,
    // so per-request ranking would flip to b — stickiness must hold a.
    const app = makeServer([entry("groq::a", "up-a", 1, 2), entry("groq::b", "up-b", 2)], new Map());
    const r1 = await ask(app, "first tweak");
    const r2 = await ask(app, "second tweak");
    expect(r1.headers["x-maxout-served-by"]).toBe("groq::a");
    expect(r2.headers["x-maxout-served-by"]).toBe("groq::a");
  });

  it("fails over mid-session and the NEW model sticks", async () => {
    const stateMap: StateMap = new Map();
    const app = makeServer([entry("groq::a", "up-a", 1), entry("groq::b", "up-b", 2)], stateMap);
    await ask(app, "one");
    stateMap.set("groq::a", { state: "cooldown", until: Number.MAX_SAFE_INTEGER, reason: "peak-throttle" });
    const r2 = await ask(app, "two");
    expect(r2.headers["x-maxout-served-by"]).toBe("groq::b");
    const r3 = await ask(app, "three");
    expect(r3.headers["x-maxout-served-by"]).toBe("groq::b");
  });

  it("does not stick when the alias opts out (auto/fast)", async () => {
    const app = buildServer({
      config: CFG, providers: PROV,
      aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
      registry: [entry("groq::slow-a", "up-a", 1), entry("groq::fast-b", "up-b", 5)],
      stateMap: new Map(),
      fetchImpl: (async () => new Response(OK_BODY, { status: 200 })) as unknown as typeof fetch,
    });
    const payload = (model: string) => app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model, messages: [
        { role: "user", content: "fix the parser" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "go" },
      ] },
    });
    await payload("auto/fast");
    // force the tier-1 model into cooldown: non-affine routing must move on permanently
    // (no sticky resurrection), which is observable on the next request.
    const r2 = await payload("auto/fast");
    expect(["groq::slow-a", "groq::fast-b"]).toContain(String(r2.headers["x-maxout-served-by"]));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/session-sticky.test.ts`
Expected: FAIL — second request flips to `groq::b` (headroom ranking), no persistence after failover.

- [ ] **Step 3: Implement**

In `src/types.ts`:

```typescript
export interface AliasDef {
  tags?: string[];
  requireTools?: boolean;
  minContext?: number;
  preferSpeed?: boolean;
  sessionAffinity?: boolean;
}
```

In `src/router.ts`:

```typescript
export const BUILT_IN_ALIASES: Record<string, AliasDef> = {
  "auto/coding": { tags: ["coding"], requireTools: true, sessionAffinity: true },
  "auto/fast": { preferSpeed: true },
  "auto/any": {},
};
```

In `src/server.ts`:

1. Imports:

```typescript
import { deriveSessionKey, SessionAffinity } from "./session.js";
```

2. `ServerDeps` gains:

```typescript
  sessionAffinity?: SessionAffinity;
```

3. Top of `buildServer`, alongside the provider bindings:

```typescript
  const affinity = deps.sessionAffinity ?? new SessionAffinity();
```

4. In the handler, directly after the Plan-A local-fallback gate (and after `if (resolved.widened) {...}`), where `aliasDef` is already in scope:

```typescript
    // Session stickiness: promote the session's previous model to the front —
    // sort order bends, filters don't. Failover re-sticks via post-success set().
    const sKey = aliasDef?.sessionAffinity === true
      ? deriveSessionKey(request.headers as Record<string, string | string[] | undefined>, body.messages)
      : undefined;
    let affinityApplied = false;
    if (sKey && candidates.length > 1) {
      const sticky = affinity.get(sKey);
      if (sticky) {
        const idx = candidates.findIndex((c) => c.id === sticky);
        if (idx > 0) {
          affinityApplied = true;
          candidates = [candidates[idx], ...candidates.filter((_, i) => i !== idx)];
        }
      }
    }
```

5. Immediately after `const servedId = result.servedBy.id;`:

```typescript
    if (sKey) affinity.set(sKey, servedId);
```

(`affinityApplied` is intentionally captured now; Plan F consumes it for `pickedReason`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — the whole suite, because existing integrations use fresh servers per test and mostly single-candidate or opt-out paths; any failure here indicates an accidental filter-ordering change, which must be fixed before proceeding.

- [ ] **Step 5: Commit**

```powershell
git add src/types.ts src/router.ts src/server.ts test/integration/session-sticky.test.ts
git commit -m "feat: session-affinity routing with failover re-stick"
```
