# Local Fallback Tier Implementation Plan (Phase 2 — Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When every cloud candidate for an alias is in a non-OK state, route the request to a local OpenAI-compatible server (Ollama by default) instead of returning `503 all_models_exhausted` — and stay completely silent/inert when no local server is configured.

**Architecture:** A synthetic `"local"` provider def + one synthetic registry entry are built at runtime from `~/.maxout/config.json` (`local` block) — nothing enters `providers.json`/`registry.json`. The existing executor attempts it like any provider once the server appends it as the sole candidate behind a strict gate: resolve() returned zero candidates AND every tag/tools-eligible cloud model's effective state is non-OK AND a lazy 60s-memo probe says the endpoint answers. Unreachable/disabled ⇒ tier does not exist.

**Tech Stack:** TypeScript (strict, ESM, Node >= 20), Fastify, vitest (fully offline — probes and upstreams are injected `fetch` mocks).

**Spec:** `docs/superpowers/specs/2026-08-25-phase2-resilience-design.md` (§1)

## Global Constraints

- Node >= 20; TypeScript strict; ESM; local imports end in `.js`.
- Tests are fully offline: never hit real endpoints; inject fake `fetchImpl`.
- No timers: probe memo uses timestamp comparison, not `setInterval`.
- File persistence uses write-to-tmp + `renameSync` atomic replace.
- Comments sparse, explain *why* only.
- Commit messages: `feat:` / `fix:` / `docs:` / `test:` prefixes, imperative mood.
- Shell is Windows PowerShell: `$env:X="y"`, chain with `if ($?) { }`.
- Full suite: `npm test`. Single file: `npx vitest run <file>`. Build check: `npm run build`.
- Model ids are `<provider>::<upstream>`; the local tier obeys this: id is `local::<model>`.
- Naming: product is **maxout** (renamed from freeroll) — paths are `~/.maxout/...`, commands are `maxout ...`.

## Deviations from spec (intentional)

1. Spec §1 "On startup, freeroll probes" → implemented as **lazy probe with 60 s memo**, first taken when the fallback gate first needs it (plus each `status` run). A blocking startup probe delays `listen()` and punishes slow-booting local servers; lazy probing gives the same silence without boot cost. Documented in spec §1 Design.
2. If the alias-eligible cloud set is empty (degenerate config), local is NOT substituted (spec §1 documents this conservative choice).

## File Structure (final state)

| File | Responsibility |
|---|---|
| `src/config.ts` | `LocalConfig` + defaults + lenient parse + `mergeConfigPatch` |
| `src/local.ts` | NEW — synthetic entry/provider builders + `probeLocal` |
| `src/quirks/index.ts` | `local` quirk (shared base rules, else rate cooldown) |
| `src/router.ts` | export `aliasCandidates` (tag+tools filter), refactor `resolve` to reuse it |
| `src/server.ts` | local provider injection + fallback gate after resolve |
| `src/cli.ts` | `formatLocalLine` + status line + serve wiring |
| `src/setup.ts` | optional skippable "configure local fallback" wizard step |
| `test/unit/local-config.test.ts` | config parse + merge patch |
| `test/unit/local.test.ts` | builders + probe |
| `test/integration/local-fallback.test.ts` | routing-gate behavior end to end |
| `test/unit/cli-local.test.ts` | status line formatting |
| `test/unit/setup-local.test.ts` | wizard step accept/skip |

---

### Task 1: Config plumbing

**Files:**
- Modify: `src/config.ts`
- Test: `test/unit/local-config.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `config.ts`: `interface LocalConfig { enabled: boolean; endpoint: string; model: string; contextWindow: number }`; `const DEFAULT_LOCAL: LocalConfig`; `AppConfig.local?: LocalConfig` (optional field — existing config literals stay valid; `loadConfig` always populates it with defaults); `mergeConfigPatch(configPath: string, patch: Record<string, unknown>): void`

- [ ] **Step 1: Write failing tests**

Create `test/unit/local-config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, mergeConfigPatch, DEFAULT_LOCAL } from "../../src/config.js";

describe("local config block", () => {
  it("defaults to disabled localhost ollama", () => {
    const cfg = loadConfig(null);
    expect(cfg.local).toEqual(DEFAULT_LOCAL);
    expect(DEFAULT_LOCAL.enabled).toBe(false);
    expect(DEFAULT_LOCAL.endpoint).toBe("http://localhost:11434");
    expect(DEFAULT_LOCAL.model).toBe("qwen2.5-coder:7b");
    expect(DEFAULT_LOCAL.contextWindow).toBe(32768);
  });

  it("parses a full local block", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-cfg-")), "config.json");
    fs.writeFileSync(file, JSON.stringify({
      local: { enabled: true, endpoint: "http://127.0.0.1:8080", model: "llama3.1:8b", contextWindow: 8192 },
    }));
    const cfg = loadConfig(file);
    expect(cfg.local).toEqual({ enabled: true, endpoint: "http://127.0.0.1:8080", model: "llama3.1:8b", contextWindow: 8192 });
  });

  it("rejects garbage fields but keeps valid ones", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-cfg-")), "config.json");
    fs.writeFileSync(file, JSON.stringify({
      local: { enabled: "yes", endpoint: 42, model: "", contextWindow: -5 },
    }));
    const cfg = loadConfig(file);
    expect(cfg.local).toEqual({ ...DEFAULT_LOCAL, enabled: false, model: "qwen2.5-coder:7b" });
  });

  it("keeps other config keys untouched", () => {
    const cfg = loadConfig(null);
    expect(cfg.harvest).toBe(true);
    expect(cfg.port).toBe(8787);
  });
});

describe("mergeConfigPatch", () => {
  it("creates a config file when missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-merge-"));
    const file = path.join(dir, "config.json");
    mergeConfigPatch(file, { local: { enabled: true } });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ local: { enabled: true } });
  });

  it("preserves sibling keys on patch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-merge-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ port: 9999, harvest: false }));
    mergeConfigPatch(file, { local: { enabled: true, model: "m" } });
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(parsed.port).toBe(9999);
    expect(parsed.local).toEqual({ enabled: true, model: "m" });
  });

  it("survives a corrupt base file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-merge-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "{not json");
    mergeConfigPatch(file, { local: { enabled: true } });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).local).toEqual({ enabled: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/local-config.test.ts`
Expected: FAIL — `DEFAULT_LOCAL` not exported / `cfg.local` undefined / `mergeConfigPatch` not exported.

- [ ] **Step 3: Implement**

In `src/config.ts`, add after `ReliabilityConfig` import section:

```typescript
export interface LocalConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  contextWindow: number;
}

export const DEFAULT_LOCAL: LocalConfig = {
  enabled: false,
  endpoint: "http://localhost:11434",
  model: "qwen2.5-coder:7b",
  contextWindow: 32768,
};
```

Add `local?: LocalConfig;` to the `AppConfig` interface (after `reliability`) and initialize in `loadConfig`'s default object:

```typescript
    reliability: { ...DEFAULT_RELIABILITY },
    local: { ...DEFAULT_LOCAL },
```

Inside the `if (raw.reliability ...)` region of `loadConfig`, add alongside the other blocks:

```typescript
    if (raw.local && typeof raw.local === "object") {
      const l = raw.local as Partial<LocalConfig>;
      if (typeof l.enabled === "boolean") cfg.local.enabled = l.enabled;
      if (typeof l.endpoint === "string" && l.endpoint.startsWith("http")) cfg.local.endpoint = l.endpoint;
      if (typeof l.model === "string" && l.model.length > 0) cfg.local.model = l.model;
      if (typeof l.contextWindow === "number" && l.contextWindow > 0) {
        cfg.local.contextWindow = Math.floor(l.contextWindow);
      }
    }
```

Add at the end of `src/config.ts`:

```typescript
// Setup-wizard escape hatch: JSON-merge one patch into config.json atomically.
export function mergeConfigPatch(configPath: string, patch: Record<string, unknown>): void {
  let base: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      base = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  const merged = { ...base, ...patch };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, configPath);
}
```

Note: `loadConfig(null)` must not change behavior for configs lacking `local` — the default object already carries it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/local-config.test.ts test/unit/config.test.ts`
Expected: all PASS (existing config tests prove no regression).

- [ ] **Step 5: Commit**

```powershell
git add src/config.ts test/unit/local-config.test.ts
git commit -m "feat: local-fallback config block and atomic config merge"
```

---

### Task 2: `src/local.ts` builders + probe, and the `local` quirk

**Files:**
- Create: `src/local.ts`
- Modify: `src/quirks/index.ts`
- Test: `test/unit/local.test.ts` (new)

**Interfaces:**
- Consumes: `LocalConfig` from Task 1.
- Produces (later tasks rely on exact signatures):
  - `local.ts`: `joinURL(base: string, part: string): string`; `localModelId(cfg: Pick<LocalConfig, "model">): string`; `localEntry(cfg: LocalConfig): RegistryEntry`; `localProviderDef(cfg: Pick<LocalConfig, "endpoint">): ActiveProvider`; `probeLocal(cfg: Pick<LocalConfig, "enabled" | "endpoint">, fetchImpl?: typeof fetch, timeoutMs?: number): Promise<boolean>`
  - `quirks/index.ts`: `QUIRKS.local` registered.

- [ ] **Step 1: Write failing tests**

Create `test/unit/local.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { localModelId, localEntry, localProviderDef, probeLocal } from "../../src/local.js";
import { DEFAULT_LOCAL } from "../../src/config.js";

describe("synthetic local objects", () => {
  it("builds a namespaced model id", () => {
    expect(localModelId({ model: "qwen2.5-coder:7b" })).toBe("local::qwen2.5-coder:7b");
  });

  it("builds a registry entry obeying <provider>::<upstream>", () => {
    const entry = localEntry(DEFAULT_LOCAL);
    expect(entry.id).toBe("local::qwen2.5-coder:7b");
    expect(entry.provider).toBe("local");
    expect(entry.upstream).toBe("qwen2.5-coder:7b");
    expect(entry.tools).toBe(true);
    expect(entry.tier).toBe(9);
    expect(entry.speed).toBe("slow");
    expect(entry.tags).toContain("coding");
    expect(entry.context).toBe(32768);
  });

  it("points the provider at <endpoint>/v1 with dummy auth", () => {
    const def = localProviderDef({ endpoint: "http://localhost:11434/" });
    expect(def.baseURL).toBe("http://localhost:11434/v1");
    expect(def.quirks).toBe("local");
    expect(def.auth).toBe("bearer");
    expect(def.resetProfile).toEqual({ kind: "daily-utc-midnight" });
  });
});

describe("probeLocal", () => {
  it("is false when disabled without touching the network", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    await expect(probeLocal({ enabled: false, endpoint: "http://x" }, fetchImpl)).resolves.toBe(false);
    expect(calls).toBe(0);
  });

  it("is true on HTTP 200 from <endpoint>/v1/models", async () => {
    let seenUrl = "";
    const fetchImpl = (async (url: string | URL) => {
      seenUrl = String(url);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(probeLocal({ enabled: true, endpoint: "http://localhost:11434" }, fetchImpl)).resolves.toBe(true);
    expect(seenUrl).toBe("http://localhost:11434/v1/models");
  });

  it("is false on non-2xx", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(probeLocal({ enabled: true, endpoint: "http://x" }, fetchImpl)).resolves.toBe(false);
  });

  it("is false when the endpoint hangs past the timeout", async () => {
    const fetchImpl = ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    await expect(probeLocal({ enabled: true, endpoint: "http://x" }, fetchImpl, 10)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/local.test.ts`
Expected: FAIL — module `../../src/local.js` not found.

- [ ] **Step 3: Implement**

Create `src/local.ts`:

```typescript
import type { ActiveProvider, LocalConfig } from "./config.js";
import type { RegistryEntry } from "./types.js";

export function joinURL(base: string, pathPart: string): string {
  return base.replace(/\/+$/, "") + pathPart;
}

export function localModelId(cfg: Pick<LocalConfig, "model">): string {
  return `local::${cfg.model}`;
}

// Tier 9 / slow keeps the synthetic entry last under any static sort; it only
// ever reaches the executor via the explicit fallback gate in server.ts.
export function localEntry(cfg: LocalConfig): RegistryEntry {
  return {
    id: localModelId(cfg),
    provider: "local",
    upstream: cfg.model,
    tags: ["coding", "chat", "fast", "long-context"],
    tier: 9,
    speed: "slow",
    context: cfg.contextWindow,
    tools: true,
  };
}

// Ollama and llama.cpp server both ignore Authorization headers; the dummy
// key satisfies ActiveProvider without leaking anything real.
export function localProviderDef(cfg: Pick<LocalConfig, "endpoint">): ActiveProvider {
  return {
    baseURL: joinURL(cfg.endpoint, "/v1"),
    auth: "bearer",
    quirks: "local",
    resetProfile: { kind: "daily-utc-midnight" },
    apiKey: "local",
  };
}

const PROBE_TIMEOUT_MS = 1500;

export async function probeLocal(
  cfg: Pick<LocalConfig, "enabled" | "endpoint">,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!cfg.enabled) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(joinURL(cfg.endpoint, "/v1/models"), { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
```

In `src/quirks/index.ts`, add next to `cerebras`:

```typescript
const local: Quirk = {
  classifyFailure(status, body, headers, now) {
    return base(status, body, headers, now) ?? RATE_60S;
  },
};
```

and register it:

```typescript
export const QUIRKS: Record<string, Quirk> = {
  openrouter,
  groq,
  google,
  mistral,
  github,
  cerebras,
  local,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/local.test.ts test/unit/quirks.test.ts test/unit/quirks-404.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/local.ts src/quirks/index.ts test/unit/local.test.ts
git commit -m "feat: local-tier synthetic provider/model builders and endpoint probe"
```

---

### Task 3: Fallback gate in the server

**Files:**
- Modify: `src/router.ts` (extract + export `aliasCandidates`)
- Modify: `src/server.ts` (inject local provider; gate after resolve)
- Test: `test/integration/local-fallback.test.ts` (new)
- Test: `test/unit/router.test.ts` (add `aliasCandidates` coverage)

**Interfaces:**
- Consumes: `localEntry`, `localProviderDef`, `probeLocal` (Task 2); `LocalConfig` (Task 1).
- Produces:
  - `router.ts`: `aliasCandidates(def: AliasDef, registry: RegistryEntry[], hasTools: boolean): RegistryEntry[]`
  - `server.ts`: `ServerDeps.localCfg?: LocalConfig` — when enabled+gate conditions met, requests route to `local::<model>`; otherwise behavior identical to today.

- [ ] **Step 1: Write failing tests**

Append to `test/unit/router.test.ts`:

```typescript
describe("aliasCandidates", () => {
  it("returns tag- and tools-eligible entries ignoring state and budget", () => {
    const out = aliasCandidates(BUILT_IN_ALIASES["auto/coding"], REG, true);
    expect(out.map((x) => x.id)).toEqual(["a::one", "b::two"]);
  });

  it("skips non-tool models when tools are required", () => {
    const reg = [...REG, e({ id: "d::four", provider: "d", upstream: "four", tags: ["coding"], tier: 0, tools: false })];
    expect(aliasCandidates(BUILT_IN_ALIASES["auto/coding"], reg, true).map((x) => x.id))
      .toEqual(["a::one", "b::two"]);
  });

  it("matches resolve()'s pre-context candidate set", () => {
    const def = BUILT_IN_ALIASES["auto/fast"];
    const a = aliasCandidates(def, REG, false).map((x) => x.id);
    const b = resolve("auto/fast", BUILT_IN_ALIASES, REG, () => OK, CTX).candidates.map((x) => x.id);
    expect(a).toEqual(b);
  });
});
```

Update the import line at the top of that file:

```typescript
import { resolve, estimateTokens, BUILT_IN_ALIASES, UnknownAliasError, aliasCandidates } from "../../src/router.js";
```

Create `test/integration/local-fallback.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/server.js";
import { DEFAULT_LOCAL } from "../../src/config.js";
import type { AppConfig, ActiveProvider } from "../../src/config.js";
import type { RegistryEntry, ModelState } from "../../src/types.js";
import type { StateMap } from "../../src/state.js";

function entry(id: string, upstream: string): RegistryEntry {
  return { id, provider: "groq", upstream, tags: ["coding", "chat"], tier: 1, speed: "fast", context: 128000, tools: true };
}

const CFG: AppConfig = {
  port: 8787, host: "127.0.0.1", aliases: {},
  providers: { groq: { apiKeyEnv: "GROQ_API_KEY" } },
  annotateResponses: false, harvest: true,
  local: { ...DEFAULT_LOCAL, enabled: true, endpoint: "http://127.0.0.1:9101", model: "test-local-model" },
};
const PROV: Record<string, ActiveProvider> = {
  groq: { baseURL: "https://groq.test/v1", auth: "bearer", quirks: "groq",
          resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk" },
};

const EXH: ModelState = { state: "exhausted", until: Number.MAX_SAFE_INTEGER };

function makeServer(
  fetchImpl: typeof fetch,
  opts?: { stateMap?: StateMap; registry?: RegistryEntry[]; localEnabled?: boolean },
) {
  return buildServer({
    config: { ...CFG, local: { ...CFG.local, enabled: opts?.localEnabled ?? true } },
    providers: PROV,
    aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
    registry: opts?.registry ?? [entry("groq::a", "up-a"), entry("groq::b", "up-b")],
    stateMap: opts?.stateMap ?? new Map(),
    fetchImpl,
  });
}

const OK_BODY = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "hi" } }],
});

function recordingFetch(hits: Array<{ url: string; model?: string }>, localUp = true): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1:9101")) {
      hits.push({ url: u, model: init?.body ? (JSON.parse(String(init.body)) as { model: string }).model : undefined });
      if (!localUp) throw new Error("ECONNREFUSED");
      if (u.endsWith("/models")) return new Response("{\"data\":[]}", { status: 200 });
      return new Response(OK_BODY, { status: 200 });
    }
    hits.push({ url: u, model: init?.body ? (JSON.parse(String(init.body)) as { model: string }).model : undefined });
    return new Response("{}", { status: 429 });
  }) as unknown as typeof fetch;
}

describe("local fallback gate", () => {
  it("routes to the local tier once every eligible cloud model is non-ok", async () => {
    const hits: Array<{ url: string; model?: string }> = [];
    const stateMap: StateMap = new Map([
      ["groq::a", EXH], ["groq::b", EXH], ["pool::groq", EXH],
    ]);
    const app = makeServer(recordingFetch(hits), { stateMap });
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding", messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-maxout-served-by"]).toBe("local::test-local-model");
    const completionHits = hits.filter((h) => h.url.endsWith("/chat/completions"));
    expect(completionHits).toHaveLength(1);
    expect(completionHits[0].url).toContain("127.0.0.1:9101");
    expect(completionHits[0].model).toBe("test-local-model");
  });

  it("never prefers local while any cloud candidate is ok", async () => {
    const hits: Array<{ url: string; model?: string }> = [];
    const app = makeServer(recordingFetch(hits));
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding", messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["x-maxout-served-by"])).toMatch(/^groq::/);
    expect(hits.some((h) => h.url.includes("127.0.0.1:9101"))).toBe(false);
  });

  it("with the local server unreachable, returns today's unchanged exhaustion error", async () => {
    const hits: Array<{ url: string; model?: string }> = [];
    const stateMap: StateMap = new Map([["groq::a", EXH], ["groq::b", EXH]]);
    const app = makeServer(recordingFetch(hits, false), { stateMap });
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding", messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.type).toBe("all_models_exhausted");
    expect(Array.isArray(res.json().error.attempts)).toBe(true);
  });

  it("does nothing local when disabled (default config shape)", async () => {
    const hits: Array<{ url: string; model?: string }> = [];
    const stateMap: StateMap = new Map([["groq::a", EXH], ["groq::b", EXH]]);
    const app = makeServer(recordingFetch(hits), { stateMap, localEnabled: false });
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding", messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(503);
    expect(hits.some((h) => h.url.includes("127.0.0.1:9101"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/router.test.ts test/integration/local-fallback.test.ts`
Expected: FAIL — `aliasCandidates` not exported; `ServerDeps` has no `localCfg`.

- [ ] **Step 3: Implement**

In `src/router.ts`, extract the shared tag/tools filter and reuse it inside `resolve`. Add above `resolve`:

```typescript
// Tag+tools eligibility — also the server's local-fallback gate input, which
// must consider exactly the set resolve() would have considered pre-context.
export function aliasCandidates(
  def: AliasDef,
  registry: RegistryEntry[],
  hasTools: boolean,
): RegistryEntry[] {
  const tagOk = def.tags?.length
    ? (e: RegistryEntry) => (def.tags as string[]).some((t) => e.tags.includes(t))
    : (_e: RegistryEntry) => true;
  const needsTools = def.requireTools === true || hasTools;
  return registry.filter(tagOk).filter((e) => (needsTools ? e.tools : true));
}
```

In `resolve`, replace the inline `tagOk`/`needsTools`/`toolsOk` definitions and the loop head so the chain starts from the helper (behavior identical):

```typescript
  const loopInput = aliasCandidates(def, registry, ctx.hasTools);
```

and the loop becomes:

```typescript
  for (const entry of loopInput.filter(contextOk).filter(stateOk)) {
```

Delete the now-unused local `tagOk`, `needsTools`, `toolsOk` declarations from `resolve`.

In `src/server.ts`:

1. Extend imports:

```typescript
import { resolve, estimateTokens, UnknownAliasError, aliasCandidates } from "./router.js";
import { localEntry, localProviderDef, probeLocal } from "./local.js";
import type { LocalConfig } from "./config.js";
```

(`ActiveProvider, AppConfig` are already imported from `./config.js`.)

2. Add to `ServerDeps`:

```typescript
  localCfg?: LocalConfig;
```

3. At the top of `buildServer`, right after `const providerCaps = ...`:

```typescript
  // The local tier exists only when configured; its provider def rides along
  // so execute() can attempt it like any cloud provider.
  const providers: Record<string, ActiveProvider> = deps.localCfg?.enabled
    ? { ...deps.providers, local: localProviderDef(deps.localCfg) }
    : deps.providers;

  let localProbeMemo: { at: number; ok: boolean } | null = null;
  const LOCAL_PROBE_TTL_MS = 60_000;
  const localAvailable = async (now: number): Promise<boolean> => {
    const lc = deps.localCfg;
    if (!lc?.enabled) return false;
    if (localProbeMemo && now - localProbeMemo.at < LOCAL_PROBE_TTL_MS) return localProbeMemo.ok;
    const ok = await probeLocal(lc, deps.fetchImpl);
    localProbeMemo = { at: now, ok };
    return ok;
  };
```

4. Replace every use of `deps.providers` inside the `/v1/chat/completions` handler and the `execute(...)` call with the new `providers` binding (the `/v1/models` handler doesn't use providers).

5. In the handler, replace `const candidates = resolved.candidates;` and the later duplicate `const aliasDef = deps.aliases[alias];` line with:

```typescript
    let candidates = resolved.candidates;
    const aliasDef = deps.aliases[alias];

    // Local tier gate: only after EVERY tag/tools-eligible cloud model is in
    // a non-OK state — never preferred over available cloud capacity.
    if (candidates.length === 0 && deps.localCfg?.enabled && aliasDef) {
      const lc = deps.localCfg;
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const eligible = aliasCandidates(aliasDef, deps.registry, hasTools);
      const blocked = (e: RegistryEntry) =>
        liveState(e.id).state !== "ok" ||
        (() => { const ps = liveProviderState(e.provider); return !!ps && ps.state !== "ok"; })();
      if (eligible.length > 0 && eligible.every(blocked) && (await localAvailable(Date.now()))) {
        candidates = [localEntry(lc)];
      }
    }
```

(The later `needsTools` computation stays as-is; it reuses the same expression.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS — including the existing 503 integration test, which proves byte-for-byte unchanged behavior when `localCfg` is absent.

- [ ] **Step 5: Commit**

```powershell
git add src/router.ts src/server.ts test/unit/router.test.ts test/integration/local-fallback.test.ts
git commit -m "feat: route to local tier when every eligible cloud model is non-ok"
```

---

### Task 4: Status line + serve wiring

**Files:**
- Modify: `src/cli.ts`
- Test: `test/unit/cli-local.test.ts` (new)

**Interfaces:**
- Consumes: `formatStatusRow`-style display conventions; `probeLocal` (Task 2).
- Produces: `cli.ts`: `formatLocalLine(local: LocalConfig, reachable: boolean): string`; `printStatus()` prints the local line last; `serve` passes `localCfg: cfg.local` to `buildServer`.

- [ ] **Step 1: Write failing tests**

Create `test/unit/cli-local.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatLocalLine } from "../../src/cli.js";
import { DEFAULT_LOCAL } from "../../src/config.js";

describe("formatLocalLine", () => {
  it("says not configured when disabled", () => {
    expect(formatLocalLine({ ...DEFAULT_LOCAL, enabled: false }, true)).toBe("local — not configured");
  });

  it("labels port 11434 as ollama and shows availability", () => {
    expect(formatLocalLine({ ...DEFAULT_LOCAL, enabled: true }, true))
      .toBe("local (ollama) — qwen2.5-coder:7b — available");
  });

  it("labels custom endpoints and reports unreachability", () => {
    expect(formatLocalLine({ ...DEFAULT_LOCAL, enabled: true, endpoint: "http://192.168.1.10:8080" }, false))
      .toBe("local (custom) — qwen2.5-coder:7b — unreachable");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/cli-local.test.ts`
Expected: FAIL — `formatLocalLine` not exported.

- [ ] **Step 3: Implement**

In `src/cli.ts`, extend imports:

```typescript
import { probeLocal } from "./local.js";
import type { LocalConfig } from "./config.js";
```

Add near `formatPoolLine`:

```typescript
export function formatLocalLine(local: LocalConfig, reachable: boolean): string {
  if (!local.enabled) return "local — not configured";
  const flavor = local.endpoint.includes(":11434") ? "ollama" : "custom";
  return `local (${flavor}) — ${local.model} — ${reachable ? "available" : "unreachable"}`;
}
```

At the end of `printStatus` (after the provider-group loop), append:

```typescript
  console.log(formatLocalLine(cfg.local ?? DEFAULT_LOCAL, await probeLocal(cfg.local ?? DEFAULT_LOCAL)));
```

(`probeLocal` returns `false` immediately when disabled — no network, matches "not configured". Extend the existing `DEFAULT_LOCAL` import from `./config.js`.)

In the `serve` branch's `buildServer({...})` call, add:

```typescript
      localCfg: cfg.local,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/cli-local.test.ts test/unit/cli.test.ts`
Expected: PASS. Then `npm run build` — expected: clean compile.

- [ ] **Step 5: Commit**

```powershell
git add src/cli.ts test/unit/cli-local.test.ts
git commit -m "feat: surface local fallback tier in maxout status and wire serve"
```

---

### Task 5: Optional skippable setup step

**Files:**
- Modify: `src/setup.ts`
- Test: `test/unit/setup-local.test.ts` (new)

**Interfaces:**
- Consumes: `mergeConfigPatch`, `DEFAULT_LOCAL` (Task 1); `probeLocal` (Task 2).
- Produces: `SetupOptions.configPath?: string` — interactive runs may write the `local` block; non-interactive (`--provider/--key`) mode untouched.

- [ ] **Step 1: Write failing tests**

Create `test/unit/setup-local.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runSetup } from "../../src/setup.js";
import { DEFAULT_LOCAL } from "../../src/config.js";

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-setup-local-"));
  return { envPath: path.join(dir, ".env"), configPath: path.join(dir, "config.json") };
}

async function runWithInput(input: string, configPath: string, envPath: string): Promise<number> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const done = runSetup({
    envPath, configPath, interactive: true,
    input: stdin, output: stdout,
    openImpl: () => {},
  });
  stdin.end(input);
  return done;
}

describe("setup local-fallback step", () => {
  it("declining writes no config", async () => {
    const { envPath, configPath } = tmpPaths();
    await runWithInput("\n\nn\n", configPath, envPath);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("accepting with blank prompts saves enabled defaults", async () => {
    const { envPath, configPath } = tmpPaths();
    await runWithInput("\n\ny\n\n\n", configPath, envPath);
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(parsed.local).toEqual({ enabled: true, endpoint: DEFAULT_LOCAL.endpoint, model: DEFAULT_LOCAL.model });
  });

  it("accepting with custom values saves them", async () => {
    const { envPath, configPath } = tmpPaths();
    await runWithInput("\n\ny\nhttp://127.0.0.1:8080\nmy-model\n", configPath, envPath);
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(parsed.local).toEqual({ enabled: true, endpoint: "http://127.0.0.1:8080", model: "my-model" });
  });
});
```

(The leading `"\n\n"` accepts the recommended provider and skips bonus prompts so the flow reaches the local question quickly; adjust count if the wizard's prompt sequence differs — the assertions are what matter.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/setup-local.test.ts`
Expected: FAIL — no config written (option ignored).

- [ ] **Step 3: Implement**

In `src/setup.ts`, extend imports:

```typescript
import { mergeConfigPatch, DEFAULT_LOCAL } from "./config.js";
import { probeLocal } from "./local.js";
```

Extend `SetupOptions`:

```typescript
  configPath?: string;
```

In `runSetup`'s interactive branch, insert between the bonus-provider loop and the final `out(...)` summary:

```typescript
    if (opts.configPath && !inputClosed) {
      const wantsLocal = (await ask("Configure local fallback (Ollama)? [y/N]: ")).toLowerCase() === "y";
      if (wantsLocal) {
        const endpoint = (await ask(`Endpoint [${DEFAULT_LOCAL.endpoint}]: `)) || DEFAULT_LOCAL.endpoint;
        const model = (await ask(`Model [${DEFAULT_LOCAL.model}]: `)) || DEFAULT_LOCAL.model;
        const reachable = await probeLocal({ enabled: true, endpoint });
        mergeConfigPatch(opts.configPath, { local: { enabled: true, endpoint, model } });
        out(
          reachable
            ? `saved local fallback (${model} @ ${endpoint})`
            : `saved local fallback (${model} @ ${endpoint}) — couldn't reach it just now, saved anyway`,
        );
      }
    }
```

Non-interactive branch: unchanged (no `configPath` usage there).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/setup-local.test.ts test/unit/setup.test.ts test/unit/cli-autosetup.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification + commit**

Run: `npm test`; then `npm run build`. Expected: green, clean compile.

```powershell
git add src/setup.ts test/unit/setup-local.test.ts
git commit -m "feat: optional skippable local-fallback step in setup wizard"
```

---

## Final verification

- `npm test` — whole suite green.
- `npm run build` — clean.
- Manual smoke (optional): with `local.enabled=true` and no Ollama running, `maxout status` prints `local (ollama) — … — unreachable` and serving behaves exactly as before.
