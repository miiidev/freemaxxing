# Agent-Aware Tool-Call Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch malformed/truncated tool-call payloads from flaky free models before they reach a coding agent — silently failing over when nothing has been sent yet, and surfacing a `freeroll_error` frame when corruption is only detectable mid-stream — while logging every event as the raw feed for reliability scoring.

**Architecture:** A pure validator (`src/toolcall.ts`) checks parsed completions against the request's `tools` schemas (cutoff signals, name/arguments/required-field integrity). The executor gains an `inspect` hook run on cloned non-streaming responses so a failed inspection continues failover inside `execute()`. Streaming requests get an SSE transform (`sseToolCallGuard`) that reassembles tool-call deltas, holds back `[DONE]`, and appends a terminal error frame on failure. Events append one JSON line each to `~/.freeroll/malformed.jsonl` (reason codes only — never content).

**Tech Stack:** TypeScript (strict, ESM, Node >= 20), Fastify, vitest (fully offline).

**Spec:** `docs/superpowers/specs/2026-08-24-next-level-design.md` (§3, §8 decisions 5 & 7)

## Global Constraints

- Node >= 20; TypeScript strict; ESM; local imports end in `.js`.
- Tests fully offline; inject fake `fetchImpl`.
- No timers anywhere.
- Persistence: append-only for `malformed.jsonl`; atomic tmp+rename if ever rewritten.
- **Failover boundary is frozen:** silent model switching only before the first byte reaches the client. Mid-stream = annotate, never switch.
- **Leniency rule:** prose-only replies to tools-carrying requests are VALID. Malformed requires present-but-broken structure or a cutoff signal (spec §8 decision 5).
- Comments sparse, explain *why*.
- Commits: `feat:` / `fix:` / `docs:` / `test:` prefixes, imperative mood.
- PowerShell shell; chain with `if ($?) { }`.
- Full suite: `npm test`. Single file: `npx vitest run <file>`. Build: `npm run build`.

## Deviations from spec (intentional)

1. Spec says "empty diff" fixtures must be rejected; semantic diff-quality is unknowable generically. Implemented as: truncation/cutoff detection (`finish_reason:"length"` + unparseable arguments) covers the mechanically-detectable subset of "truncated mid-diff". Documented in Task 1 tests.
2. Executor `inspect` runs only when `args.body.stream !== true`. Streaming validation lives entirely in the guard transform (spec §7 decision).
3. The guard holds `[DONE]` until its flush so the error frame lands BEFORE `[DONE]` (client SSE parsers stop at `[DONE]`; an error frame after it would never be read). Bytes are otherwise forwarded unchanged.

## File Structure (final state)

| File | Responsibility |
|---|---|
| `src/toolcall.ts` (new) | pure validator over parsed completions |
| `src/malformed.ts` (new) | bind/append/load `malformed.jsonl` |
| `src/executor.ts` | `inspect?` / `onMalformed?` hooks, non-streaming only |
| `src/server.ts` | build inspect closure when tools needed; insert guard into stream pipeline |
| `src/sse.ts` | + `sseToolCallGuard()` transform |
| `src/cli.ts` | `serve` binds malformed file |
| `README.md` | document validation behavior |

---

### Task 1: Validator core

**Files:**
- Create: `src/toolcall.ts`
- Create: `test/unit/toolcall.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface ToolSpec { type?: string; function: { name: string; parameters?: { required?: string[] } } }`
  - `interface ToolCallVerdict { ok: boolean; reason?: string }`
  - `validateCompletion(resp: Record<string, unknown>, tools?: ToolSpec[]): ToolCallVerdict`
  - Reason vocabulary (later tasks/tests match these): `"empty-choices"`, `"cutoff-length"`, `"tool_calls[i]:missing-name"`, `"tool_calls[i]:unknown-tool:<name>"`, `"tool_calls[i]:missing-arguments"`, `"tool_calls[i]:arguments-not-json"`, `"tool_calls[i]:arguments-not-object"`, `"tool_calls[i]:missing-arg:<key>"`

- [ ] **Step 1: Write failing tests**

Create `test/unit/toolcall.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateCompletion, type ToolSpec } from "../../src/toolcall.js";

const PATCH: ToolSpec = {
  type: "function",
  function: {
    name: "apply_patch",
    parameters: { type: "object", required: ["path", "diff"] },
  },
};

const completion = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  choices: [{ finish_reason: "tool_calls", message: { tool_calls: [] } }],
  ...overrides,
});

const call = (name: string, args: unknown) => ({
  id: "c1",
  type: "function",
  function: { name, arguments: args },
});

describe("validateCompletion", () => {
  it("accepts valid OpenAI-style string arguments", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [call("apply_patch", JSON.stringify({ path: "a.ts", diff: "@@" }))] },
        }],
      }),
      [PATCH],
    );
    expect(v).toEqual({ ok: true });
  });

  it("accepts object-form arguments (Google-compat shape)", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "stop",
          message: { tool_calls: [call("apply_patch", { path: "a.ts", diff: "@@" })] },
        }],
      }),
      [PATCH],
    );
    expect(v).toEqual({ ok: true });
  });

  it("accepts parallel tool calls", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [
            call("apply_patch", JSON.stringify({ path: "a.ts", diff: "@@" })),
            call("read_file", JSON.stringify({ path: "b.ts" })),
          ] },
        }],
      }),
      [PATCH, { function: { name: "read_file", parameters: { required: ["path"] } } }],
    );
    expect(v).toEqual({ ok: true });
  });

  it("rejects truncated argument JSON", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [call("apply_patch", '{"path":"a.ts","diff":')] }],
        }],
      }),
      [PATCH],
    );
    expect(v.ok).toBe(false);
  });

  it("rejects missing required argument", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [call("apply_patch", JSON.stringify({ path: "a.ts" }))] },
        }],
      }),
      [PATCH],
    );
    expect(v).toEqual({ ok: false, reason: "tool_calls[0]:missing-arg:diff" });
  });

  it("rejects empty-string required argument values", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [call("apply_patch", JSON.stringify({ path: "", diff: "@@" }))] },
        }],
      }),
      [PATCH],
    );
    expect(v).toEqual({ ok: false, reason: "tool_calls[0]:missing-arg:path" });
  });

  it("rejects unknown tool names when tools were requested", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [call("rm_rf", "{}")] },
        }],
      }),
      [PATCH],
    );
    expect(v.reason).toBe("tool_calls[0]:unknown-tool:rm_rf");
  });

  it("rejects empty tool name", () => {
    const v = validateCompletion(
      completion({
        choices: [{ finish_reason: "tool_calls", message: { tool_calls: [call("", "{}")] } }],
      }),
      [PATCH],
    );
    expect(v.reason).toBe("tool_calls[0]:missing-name");
  });

  it("rejects cutoff regardless of payload validity", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "length",
          message: { tool_calls: [call("apply_patch", JSON.stringify({ path: "a.ts", diff: "@@" }))] },
        }],
      }),
      [PATCH],
    );
    expect(v).toEqual({ ok: false, reason: "cutoff-length" });
  });

  it("LENIENCY: prose reply to a tools request is valid", () => {
    const v = validateCompletion(
      completion({
        choices: [{ finish_reason: "stop", message: { content: "Which file?" } }],
      }),
      [PATCH],
    );
    expect(v).toEqual({ ok: true });
  });

  it("no tools requested: cutoff still fails, plain answers pass", () => {
    expect(validateCompletion(completion({
      choices: [{ finish_reason: "length", message: { content: "half a sen" } }],
    })).reason).toBe("cutoff-length");
    expect(validateCompletion(completion({
      choices: [{ finish_reason: "stop", message: { content: "done" } }],
    }), undefined)).toEqual({ ok: true });
  });

  it("rejects empty choices array", () => {
    expect(validateCompletion({ choices: [] }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/toolcall.test.ts`
Expected: FAIL — module `../../src/toolcall.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/toolcall.ts`:

```typescript
export interface ToolSpec {
  type?: string;
  function: { name: string; parameters?: { required?: string[] } };
}

export interface ToolCallVerdict {
  ok: boolean;
  reason?: string;
}

// Pure structural check of a parsed chat.completion. Prose replies are always
// fine — agents legitimately get clarifying text even when they sent tools;
// only present-but-broken tool calls and provider-side cutoffs fail here.
export function validateCompletion(
  resp: Record<string, unknown>,
  tools?: ToolSpec[],
): ToolCallVerdict {
  const choices = resp.choices as Array<Record<string, unknown>> | undefined;
  const c0 = choices?.[0];
  if (!c0) return { ok: false, reason: "empty-choices" };

  if (c0.finish_reason === "length") return { ok: false, reason: "cutoff-length" };

  const msg = c0.message as Record<string, unknown> | undefined;
  const tcs = msg?.tool_calls as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tcs) || tcs.length === 0) return { ok: true };

  const byName = new Map((tools ?? []).map((t) => [t.function.name, t]));
  for (let i = 0; i < tcs.length; i++) {
    const tc = tcs[i];
    const fn = tc.function as { name?: unknown; arguments?: unknown } | undefined;
    const label = `tool_calls[${i}]`;
    if (!fn || typeof fn.name !== "string" || fn.name.length === 0) {
      return { ok: false, reason: `${label}:missing-name` };
    }
    if ((tools?.length ?? 0) > 0 && !byName.has(fn.name)) {
      return { ok: false, reason: `${label}:unknown-tool:${fn.name}` };
    }

    let args: unknown;
    if (typeof fn.arguments === "string") {
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        return { ok: false, reason: `${label}:arguments-not-json` };
      }
    } else if (fn.arguments !== undefined) {
      args = fn.arguments;
    } else {
      return { ok: false, reason: `${label}:missing-arguments` };
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return { ok: false, reason: `${label}:arguments-not-object` };
    }

    const required = byName.get(fn.name)?.function.parameters?.required ?? [];
    for (const key of required) {
      const v = (args as Record<string, unknown>)[key];
      if (v === undefined || v === null || v === "") {
        return { ok: false, reason: `${label}:missing-arg:${key}` };
      }
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/toolcall.test.ts && npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```powershell
git add src/toolcall.ts test/unit/toolcall.test.ts
git commit -m "feat: structural validator for agent tool-call responses"
```

---

### Task 2: Malformed-event log

**Files:**
- Create: `src/malformed.ts`
- Create: `test/unit/malformed.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `bindMalformedFile(file: string | null): void`, `recordMalformed(modelId: string, reason: string, now?: number): void` (inert when unbound), `loadMalformed(file: string): MalformedEvent[]` with `interface MalformedEvent { ts: number; model: string; reason: string }`.

- [ ] **Step 1: Write failing tests**

Create `test/unit/malformed.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindMalformedFile, recordMalformed, loadMalformed } from "../../src/malformed.js";

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);

describe("malformed event log", () => {
  beforeEach(() => bindMalformedFile(null));

  it("inert when unbound", () => {
    expect(() => recordMalformed("m::x", "cutoff-length", T0)).not.toThrow();
  });

  it("appends one JSON line per event and loads them back", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-mal-")), "malformed.jsonl");
    bindMalformedFile(file);
    recordMalformed("groq::a", "tool_calls[0]:arguments-not-json", T0);
    recordMalformed("or::b", "cutoff-length", T0 + 5);
    expect(loadMalformed(file)).toEqual([
      { ts: T0, model: "groq::a", reason: "tool_calls[0]:arguments-not-json" },
      { ts: T0 + 5, model: "or::b", reason: "cutoff-length" },
    ]);
  });

  it("stores reason codes only — no response content API exists", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-mal2-")), "malformed.jsonl");
    bindMalformedFile(file);
    recordMalformed("m::x", "missing-arg:path", T0);
    const raw = fs.readFileSync(file, "utf8");
    expect(Object.keys(JSON.parse(raw))).toEqual(["ts", "model", "reason"]);
  });

  it("loadMalformed tolerates missing file and corrupt lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-mal3-"));
    expect(loadMalformed(path.join(dir, "nope.jsonl"))).toEqual([]);
    const bad = path.join(dir, "bad.jsonl");
    fs.writeFileSync(bad, "{oops\n");
    expect(loadMalformed(bad)).toEqual([]);
  });
});
```

Note: `recordMalformed`'s third parameter defaults to `Date.now()` — tests pass `T0` explicitly for determinism.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/malformed.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/malformed.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";

export interface MalformedEvent {
  ts: number;
  model: string;
  reason: string;
}

let file: string | null = null;

export function bindMalformedFile(f: string | null): void {
  file = f;
}

// Append-only audit of quality failures. Reason codes only — response
// content must never touch this file (it feeds anonymized exports later).
export function recordMalformed(modelId: string, reason: string, now: number = Date.now()): void {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts: now, model: modelId, reason })}\n`);
}

export function loadMalformed(f: string): MalformedEvent[] {
  if (!fs.existsSync(f)) return [];
  try {
    const out: MalformedEvent[] = [];
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as MalformedEvent);
      } catch {
        // skip corrupt line
      }
    }
    return out;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/malformed.test.ts && npm run build`
Expected: PASS; clean build.

- [ ] **Step 5: Commit**

```powershell
git add src/malformed.ts test/unit/malformed.test.ts
git commit -m "feat: append-only malformed-output event log"
```

---

### Task 3: Executor `inspect` hook (silent pre-byte failover)

**Files:**
- Modify: `src/executor.ts`
- Modify: `test/integration/executor.test.ts` (append)

**Interfaces:**
- Consumes: `validateCompletion` result contract (Task 1 — executor is agnostic; it just propagates a reason string).
- Produces:
  - `ExecuteArgs.inspect?: (entry: RegistryEntry, response: Response) => Promise<string | undefined>`
  - `ExecuteArgs.onMalformed?: (modelId: string, reason: string) => void`
  - Contract: `inspect` runs ONLY when `args.body.stream !== true`, against a `response.clone()`. A returned reason pushes attempt `{model, reason:"malformed <reason>"}`, fires `onMalformed`, and continues the candidate loop (NO state-map writes — quality signal, not health). Inspect throwing must never break serving.

- [ ] **Step 1: Write failing tests**

Append to `test/integration/executor.test.ts` (helpers `jsonResponse`, `A`, `B`, `P_GROQ` exist):

```typescript
describe("inspect hook (malformed output)", () => {
  const bodyWithTools = {
    messages: [],
    tools: [{ type: "function", function: { name: "patch" } }],
  };

  it("fails over silently when inspection rejects the response", async () => {
    let inspected = 0;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      return jsonResponse(200, { id: sent.model, choices: [] });
    }) as unknown as typeof fetch;

    const res = await execute({
      candidates: [A, B], providers: { groq: P_GROQ },
      body: bodyWithTools, stateMap: new Map(), fetchImpl,
      inspect: async (_entry, response) => {
        inspected++;
        const j = await response.json() as { id: string };
        return j.id === "a" ? "tool_calls[0]:arguments-not-json" : undefined;
      },
      onMalformed: () => {},
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.servedBy.id).toBe("groq::b");
    expect(inspected).toBe(2);
    expect(res.attempts.map((a) => a.reason)).toEqual(["malformed tool_calls[0]:arguments-not-json"]);
  });

  it("does not write health state for malformed output", async () => {
    const stateMap = new Map();
    const fetchImpl = (async () => jsonResponse(200, { id: "x", choices: [] })) as unknown as typeof fetch;
    await execute({
      candidates: [A], providers: { groq: P_GROQ },
      body: bodyWithTools, stateMap, fetchImpl,
      inspect: async () => "cutoff-length",
    });
    expect(stateMap.size).toBe(0);
  });

  it("skips inspection for streaming requests", async () => {
    let inspected = 0;
    const fetchImpl = (async () => jsonResponse(200, { id: "x", choices: [] })) as unknown as typeof fetch;
    await execute({
      candidates: [A], providers: { groq: P_GROQ },
      body: { ...bodyWithTools, stream: true }, stateMap: new Map(), fetchImpl,
      inspect: async () => { inspected++; return "cutoff-length"; },
    });
    expect(inspected).toBe(0);
  });

  it("an inspect crash serves the response anyway", async () => {
    const fetchImpl = (async () => jsonResponse(200, { id: "x", choices: [] })) as unknown as typeof fetch;
    const res = await execute({
      candidates: [A], providers: { groq: P_GROQ },
      body: bodyWithTools, stateMap: new Map(), fetchImpl,
      inspect: async () => { throw new Error("boom"); },
    });
    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/executor.test.ts`
Expected: FAIL — `inspect`/`onMalformed` not implemented (first test fails on servedBy/attempts).

- [ ] **Step 3: Implement**

In `src/executor.ts`, extend `ExecuteArgs`:

```typescript
  inspect?: (entry: RegistryEntry, response: Response) => Promise<string | undefined>;
  onMalformed?: (modelId: string, reason: string) => void;
```

Inside `execute()`'s candidate loop, replace the first-success block:

```typescript
    const first = await attemptOnce(entry, provider, args.body, fetchImpl, ttfb);
    if (first.kind === "ok") {
      // Quality gate runs only where failover is still legal: no bytes sent.
      if (args.inspect && args.body.stream !== true) {
        try {
          const reason = await args.inspect(entry, first.response.clone());
          if (reason !== undefined) {
            args.onMalformed?.(entry.id, reason);
            attempts.push({ model: entry.id, reason: `malformed ${reason}` });
            continue;
          }
        } catch {
          // a broken inspector must not break serving
        }
      }
      return { ok: true, response: first.response, servedBy: entry, attempts };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/executor.test.ts && npm test && npm run build`
Expected: PASS everywhere (existing flows pass no `inspect`).

- [ ] **Step 5: Commit**

```powershell
git add src/executor.ts test/integration/executor.test.ts
git commit -m "feat: pre-byte malformed-output failover via executor inspect hook"
```

---

### Task 4: Server wiring — validate non-streaming responses, log events, bind file

**Files:**
- Modify: `src/server.ts`
- Modify: `src/cli.ts` (one line)
- Modify: `test/integration/server.test.ts` (append)

**Interfaces:**
- Consumes: `validateCompletion`, `ToolSpec` (Task 1); `bindMalformedFile`, `recordMalformed` (Task 2); executor hooks (Task 3).
- Produces: server behavior — for requests needing tools (alias `requireTools===true` OR non-empty `body.tools`): non-streaming malformed upstream responses trigger silent failover within the same HTTP request; every malformed verdict appends to the bound jsonl. `serve` command binds `~/.freeroll/malformed.jsonl`.

- [ ] **Step 1: Write failing tests**

Append to `test/integration/server.test.ts`:

```typescript
import { bindMalformedFile, loadMalformed } from "../../src/malformed.js";

function twoModelRegistry(): RegistryEntry[] {
  return [
    { id: "p::bad", provider: "p", upstream: "bad", tags: ["coding"], tier: 1, speed: "fast", context: 32000, tools: true },
    { id: "p::good", provider: "p", upstream: "good", tags: ["coding"], tier: 2, speed: "fast", context: 32000, tools: true },
  ];
}

const TOOL_BODY = {
  model: "auto/coding",
  messages: [{ role: "user", content: "edit files" }],
  tools: [{ type: "function", function: { name: "patch" } }],
};

describe("non-streaming tool-call validation", () => {
  it("silently fails over to the next candidate on malformed output", async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      const payload = sent.model === "bad"
        ? { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [
            { function: { name: "patch", arguments: '{"path":' } }] } }] }
        : { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [
            { function: { name: "patch", arguments: '{}' } }] } }] };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-srv-tv-"));
    bindMalformedFile(path.join(dir, "malformed.jsonl"));
    const app = buildServer({
      config: CFG,
      providers: { p: { baseURL: "https://p.test/v1", auth: "bearer", quirks: "groq", resetProfile: { kind: "daily-utc-midnight" }, apiKey: "k" } },
      aliases: BUILT_IN_ALIASES,
      registry: twoModelRegistry(),
      stateMap: new Map(),
      fetchImpl,
    });

    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: TOOL_BODY });
    bindMalformedFile(null);

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-freeroll-served-by"]).toBe("p::good");
    expect(loadMalformed(path.join(dir, "malformed.jsonl"))).toEqual([
      { ts: expect.any(Number), model: "p::bad", reason: "tool_calls[0]:arguments-not-json" },
    ]);
  });

  it("prose replies pass through without events", async () => {    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "hi" } }] }), { status: 200 })
    ) as unknown as typeof fetch;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-srv-tv2-"));
    bindMalformedFile(path.join(dir, "m.jsonl"));
    const app = buildServer({
      config: CFG,
      providers: { p: { baseURL: "https://p.test/v1", auth: "bearer", quirks: "groq", resetProfile: { kind: "daily-utc-midnight" }, apiKey: "k" } },
      aliases: BUILT_IN_ALIASES,
      registry: twoModelRegistry(),
      stateMap: new Map(),
      fetchImpl,
    });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: TOOL_BODY });
    bindMalformedFile(null);
    expect(res.statusCode).toBe(200);
    expect(loadMalformed(path.join(dir, "m.jsonl"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/server.test.ts`
Expected: FAIL — served-by stays `p::bad`; no malformed events recorded.

- [ ] **Step 3: Implement**

`src/server.ts` imports:

```typescript
import { validateCompletion, type ToolSpec } from "./toolcall.js";
import { recordMalformed } from "./malformed.js";
```

Inside the POST handler, after `alias` is derived and before `resolve(...)`, compute:

```typescript
    const aliasDef = deps.aliases[alias];
    const needsTools = aliasDef?.requireTools === true || (Array.isArray(body.tools) && body.tools.length > 0);
    const requestedTools = Array.isArray(body.tools) ? (body.tools as ToolSpec[]) : undefined;
```

Pass hooks into `execute({...})`:

```typescript
    const result = await execute({
      candidates,
      providers: deps.providers,
      body,
      stateMap: deps.stateMap,
      fetchImpl: deps.fetchImpl,
      inspect: needsTools
        ? async (_entry, upstreamResponse) => {
            const parsed = (await upstreamResponse.json()) as Record<string, unknown>;
            const verdict = validateCompletion(parsed, requestedTools);
            return verdict.ok ? undefined : verdict.reason;
          }
        : undefined,
      onMalformed: needsTools
        ? (modelId, reason) => recordMalformed(modelId, reason)
        : undefined,
    });
```

`src/cli.ts` — in the `serve` branch next to the other binds:

```typescript
import { bindUsageFile, aggregateProvider, recordUsage } from "./usage.js"; // existing
import { bindMalformedFile } from "./malformed.js";
import path from "node:path";
import os from "node:os";
```

Add under `defaultEnvPath()` in `src/config.ts`:

```typescript
export function defaultMalformedPath(): string {
  return path.join(os.homedir(), ".freeroll", "malformed.jsonl");
}
```

and in cli serve:

```typescript
    bindMalformedFile(defaultMalformedPath()); // quality events survive nothing — append-only log
```

(import `defaultMalformedPath` alongside the other config imports.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/server.test.ts && npm test && npm run build`
Expected: PASS; clean build.

- [ ] **Step 5: Commit**

```powershell
git add src/server.ts src/cli.ts src/config.ts test/integration/server.test.ts
git commit -m "feat: silent failover on malformed tool calls for non-streaming requests"
```

---

### Task 5: SSE tool-call guard transform

**Files:**
- Modify: `src/sse.ts`
- Create: `test/unit/sse-guard.test.ts`

**Interfaces:**
- Consumes: `validateCompletion`, `ToolSpec`, `ToolCallVerdict` (Task 1).
- Produces: `sseToolCallGuard(opts: { tools?: ToolSpec[]; onVerdict?: (v: ToolCallVerdict) => void }): Transform` — forwards frames byte-for-byte EXCEPT it withholds `data: [DONE]` until flush; at flush it reassembles streamed tool-call deltas, validates, and on failure emits `data: {"freeroll_error":"malformed_tool_call","detail":"<reason>"}\n\n` BEFORE the held `[DONE]`.

- [ ] **Step 1: Write failing tests**

Create `test/unit/sse-guard.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Transform } from "node:stream";
import { sseToolCallGuard } from "../../src/sse.js";
import type { ToolCallVerdict, ToolSpec } from "../../src/toolcall.js";

const PATCH: ToolSpec = { function: { name: "patch", parameters: { required: ["path"] } } };

async function run(frames: string[], opts?: { tools?: ToolSpec[] }): Promise<{ out: string; verdict?: ToolCallVerdict }> {
  let out = "";
  let verdict: ToolCallVerdict | undefined;
  const target = sseToolCallGuard({ tools: opts?.tools, onVerdict: (v) => { verdict = v; } });
  target.on("data", (d: Buffer) => { out += d.toString(); });
  for (const f of frames) target.write(f);
  await new Promise<void>((resolveDone) => target.end(() => resolveDone()));
  return { out, verdict };
}

describe("sseToolCallGuard", () => {
  it("passes content-only streams through untouched", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { out, verdict } = await run(frames);
    expect(out).toBe(frames.join(""));
    expect(verdict?.ok).toBe(true);
  });

  it("validates reassembled tool-call deltas and passes good ones", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"patch","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { out, verdict } = await run(frames, { tools: [PATCH] });
    expect(verdict?.ok).toBe(true);
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(out.startsWith(frames[0])).toBe(true); // data frames forwarded unchanged
  });

  it("appends malformed_tool_call frame before DONE on truncated arguments", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"patch","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { out, verdict } = await run(frames, { tools: [PATCH] });
    expect(verdict?.ok).toBe(false);
    expect(out).toContain('"freeroll_error":"malformed_tool_call"');
    expect(out).toContain("arguments-not-json");
    const doneIdx = out.indexOf("data: [DONE]");
    const errIdx = out.indexOf('"freeroll_error":"malformed_tool_call"');
    expect(errIdx).toBeGreaterThan(-1);
    expect(errIdx).toBeLessThan(doneIdx);
  });

  it("flags finish_reason length mid-stream", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { out, verdict } = await run(frames);
    expect(verdict).toEqual({ ok: false, reason: "cutoff-length" });
    expect(out).toContain('"freeroll_error":"malformed_tool_call"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/sse-guard.test.ts`
Expected: FAIL — `sseToolCallGuard` not exported.

- [ ] **Step 3: Implement**

Append to `src/sse.ts`:

```typescript
import { validateCompletion, type ToolCallVerdict, type ToolSpec } from "./toolcall.js";

export interface ToolGuardOptions {
  tools?: ToolSpec[];
  onVerdict?: (v: ToolCallVerdict) => void;
}

// Reassembles streamed tool-call deltas, validates the assembled call at
// stream end, and on failure emits freeroll_error BEFORE the held [DONE] —
// SSE clients stop reading at [DONE], so the frame must land first.
export function sseToolCallGuard(opts: ToolGuardOptions): Transform {
  let buffer = "";
  let finishReason: string | undefined;
  const calls = new Map<number, { name: string; args: string }>();

  const absorb = (frame: string): void => {
    if (!frame.startsWith("data: ") || frame === "data: [DONE]") return;
    try {
      const parsed = JSON.parse(frame.slice(6)) as Record<string, unknown>;
      const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
      const c0 = choices?.[0];
      if (!c0) return;
      if (typeof c0.finish_reason === "string") finishReason = c0.finish_reason;
      const delta = c0.delta as Record<string, unknown> | undefined;
      const deltas = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
      for (const d of Array.isArray(deltas) ? deltas : []) {
        const idx = typeof d.index === "number" ? d.index : 0;
        const entry = calls.get(idx) ?? { name: "", args: "" };
        const fn = d.function as { name?: unknown; arguments?: unknown } | undefined;
        if (fn && typeof fn.name === "string") entry.name = fn.name;
        if (fn && typeof fn.arguments === "string") entry.args += fn.arguments;
        calls.set(idx, entry);
      }
    } catch {
      // malformed JSON — pass through
    }
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buffer += chunk.toString();
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        absorb(part);
        // hold [DONE] until the flush-time verdict
        if (part !== "data: [DONE]") this.push(part + "\n\n");
      }
      cb();
    },
    flush(cb) {
      if (buffer.length > 0) {
        absorb(buffer);
        if (buffer !== "data: [DONE]") this.push(buffer);
        buffer = "";
      }
      const assembled = {
        choices: [{
          finish_reason: finishReason,
          message: {
            tool_calls: [...calls.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, c]) => ({ function: { name: c.name, arguments: c.args } })),
          },
        }],
      };
      const verdict = validateCompletion(assembled, opts.tools);
      opts.onVerdict?.(verdict);
      if (!verdict.ok) {
        this.push(`data: ${JSON.stringify({
          freeroll_error: "malformed_tool_call",
          detail: verdict.reason,
        })}\n\n`);
      }
      this.push("data: [DONE]\n\n");
      cb();
    },
  });
}
```

Type note: move the `import` to the top of the file with the other imports (ESM hoists imports anyway, but style matters):

```typescript
import { validateCompletion, type ToolCallVerdict, type ToolSpec } from "./toolcall.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/sse-guard.test.ts && npx vitest run test/unit/sse.test.ts && npm run build`
Expected: PASS (existing SSE transforms untouched).

- [ ] **Step 5: Commit**

```powershell
git add src/sse.ts test/unit/sse-guard.test.ts
git commit -m "feat: streaming tool-call guard with terminal error frame"
```

---

### Task 6: Stream pipeline wiring + README

**Files:**
- Modify: `src/server.ts`
- Modify: `README.md`
- Modify: `test/integration/streaming.test.ts` (append)

**Interfaces:**
- Consumes: `sseToolCallGuard` (Task 5), `needsTools` computation (Task 4).
- Produces: streaming pipeline `upstream → rewriter → [guard?] → capture → [annotator?] → reply.raw`; guard's failed verdict records a malformed event. Close-listener sets include the guard when present.

- [ ] **Step 1: Write failing test**

Append to `test/integration/streaming.test.ts`:

```typescript
import { bindMalformedFile, loadMalformed } from "../../src/malformed.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("streaming tool-call guard", () => {
  it("appends freeroll_error frame and logs the event for truncated tool args", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-str-guard-"));
    bindMalformedFile(path.join(dir, "m.jsonl"));

    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"patch","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const fetchImpl = (async () => sseResponse([sse])) as unknown as typeof fetch;
    const usageMap: UsageMap = new Map();
    const app = makeStreamServer(fetchImpl, usageMap);

    const res = await post(app, {
      stream: true,
      messages: [{ role: "user", content: "edit" }],
      tools: [{ type: "function", function: { name: "patch", parameters: { required: ["path"] } } }],
    });
    bindMalformedFile(null);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"freeroll_error":"malformed_tool_call"');
    expect(res.body.indexOf('"freeroll_error":"malformed_tool_call"'))
      .toBeLessThan(res.body.indexOf("data: [DONE]"));
    expect(loadMalformed(path.join(dir, "m.jsonl"))).toEqual([
      { ts: expect.any(Number), model: "groq::openai/gpt-oss-20b", reason: "tool_calls[0]:arguments-not-json" },
    ]);
  });

  it("clean streams stay byte-identical", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const fetchImpl = (async () => sseResponse([sse])) as unknown as typeof fetch;
    const app = makeStreamServer(fetchImpl, new Map());
    const res = await post(app, {
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.body).not.toContain("freeroll_error");
    expect(res.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/streaming.test.ts`
Expected: FAIL — no guard wired; error frame absent.

- [ ] **Step 3: Implement**

`src/server.ts`: import the guard:

```typescript
import { sseModelRewriter, sseAnnotator, sseUsageCapture, sseToolCallGuard } from "./sse.js";
```

In the streaming section (after headers written, before piping), create the optional guard and rebuild both branches around a uniform chain:

```typescript
    const upstream = Readable.fromWeb(result.response.body as import("stream/web").ReadableStream);
    const rewriter = sseModelRewriter(servedId);
    const guard = needsTools
      ? sseToolCallGuard({
          tools: requestedTools,
          onVerdict: (v) => {
            if (!v.ok) recordMalformed(servedId, v.reason ?? "unknown");
          },
        })
      : undefined;
    let capturedUsage: { tokensIn: number; tokensOut: number } | undefined;
    const capture = sseUsageCapture((u) => { capturedUsage = u; });
```

Chain construction replacing both current pipe layouts (annotated flag picks the LAST link):

```typescript
    const head = guard ? rewriter.pipe(guard) : rewriter; // Transform
    const tail = deps.config.annotateResponses ? sseAnnotator(servedId) : null;
    const last = tail ?? capture;
    if (tail) {
      capture.pipe(tail);
    }
    head.pipe(capture);
    last.pipe(reply.raw);
    upstream.pipe(rewriter);

    for (const link of [upstream, rewriter, ...(guard ? [guard] : []), capture, ...(tail ? [tail] : [])]) {
      link.on("error", () => {
        if (!reply.raw.writableEnded) {
          if (link === upstream) {
            reply.raw.write(`data: {"freeroll_error":"upstream_stream_failed"}\n\n`);
          }
          reply.raw.end();
        }
      });
    }

    await new Promise<void>((resolveDone) => {
      for (const link of [reply.raw, upstream, rewriter, ...(guard ? [guard] : []), capture, ...(tail ? [tail] : [])]) {
        link.on("close", () => resolveDone());
      }
    });
```

This replaces BOTH existing branches wholesale (the old `if (deps.config.annotateResponses) {...} else {...}` block including their per-link listeners and the close-Promise). Keep the subsequent `recordServed(result.servedBy, capturedUsage);` line.

Type note: `head` unions `Transform | Readable`; `.pipe` exists on both — annotate explicitly:

```typescript
    const head: NodeJS.ReadableStream = guard ? rewriter.pipe(guard) : rewriter;
```

README — under "Transparency", append:

```markdown
For tool-carrying requests Freeroll validates tool-call payloads before your
agent sees them: broken or truncated calls fail over silently before the first
byte (non-streaming), or surface as a `{"freeroll_error":"malformed_tool_call"}`
SSE frame at stream end. Every rejection is logged locally as a reason code
(`~/.freeroll/malformed.jsonl`) — never the response content.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/streaming.test.ts && npm test && npm run build`
Expected: all PASS (existing streaming tests have no `tools` field → `needsTools` false → guard absent → identical pipeline).

- [ ] **Step 5: Commit**

```powershell
git add src/server.ts README.md test/integration/streaming.test.ts
git commit -m "feat: wire tool-call guard into streaming pipeline"
```

---

## Completion checklist (Plan B)

- [ ] `npm test` green; `npm run build` clean.
- [ ] Acceptance: known-bad fixtures (truncated JSON, missing required arg, cutoff) all rejected before reaching the client on non-streamed responses (Tasks 1 & 4).
- [ ] Acceptance: zero false positives across OpenAI/Google-compat/Groq-style corpora incl. prose leniency (Task 1).
- [ ] Failover boundary preserved: streaming never switches models; error frame precedes `[DONE]` (Task 5).
- [ ] `malformed.jsonl` contains ts/model/reason only (Task 2).
