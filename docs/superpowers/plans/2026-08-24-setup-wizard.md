# Onboarding Wizard (`freeroll setup`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a zero-key user from install to a working `auto/coding` request with one command and one provider signup — Groq first as the recommended easiest start, remaining providers offered afterward as optional bonus capacity.

**Architecture:** `src/setup.ts` holds a small provider catalog (signup URL, env var, OpenAI-compatible base URL), a key validator that does one `GET /models` bearer call against an injectable `fetch`, an env-file merge that preserves unknown lines while upserting keys into `~/.freeroll/.env`, and a `runSetup()` flow with two entry paths: fully scripted flags (`--provider/--key`) for tests/CI, and an interactive readline loop over injectable input/output streams. GitHub Models is excluded (retired July 2026).

**Tech Stack:** TypeScript (strict, ESM, Node >= 20), `node:readline/promises`, vitest (fully offline — network and TTY are always injected).

**Spec:** `docs/superpowers/specs/2026-08-24-next-level-design.md` (§7)

## Global Constraints

- Node >= 20; TypeScript strict; ESM; local imports end in `.js`.
- Tests fully offline: `fetchImpl`, streams, and env paths are always injected; never touch real `~/.freeroll`.
- No timers.
- `.env` writes replace the whole file after merge (parse → filter → sort → write). Comments in `.env` are not preserved (documented tradeoff).
- Interactive prompts must degrade gracefully when stdin is not a TTY — the flag path exists precisely for that; do not add TTY detection logic beyond what flows require.
- Comments sparse, explain *why*.
- Commits: `feat:` / `docs:` / `test:` prefixes, imperative mood.
- PowerShell shell; chain with `if ($?) { }`.
- Full suite: `npm test`. Single file: `npx vitest run <file>`. Build: `npm run build`.

## Deviations from spec (intentional)

1. Spec says "opens the relevant signup page". Implemented as: print the URL always, attempt OS-open best-effort through an injectable `openImpl` (never fatal if it fails).
2. Key validation retries at most 3 times interactively before aborting that provider (spec silent; prevents infinite paste loops).

## File Structure (final state)

| File | Responsibility |
|---|---|
| `src/setup.ts` (new) | catalog, env merge, key validation, setup flow |
| `src/cli.ts` | `freeroll setup [--provider X --key Y] [--env FILE]` routing |
| `README.md` | Quickstart leads with `freeroll setup` |
| `docs/manual-smoke.md` | zero-key-user acceptance checklist |

---

### Task 1: Catalog + env-file merge helpers

**Files:**
- Create: `src/setup.ts`
- Create: `test/unit/setup.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface SetupProvider { name: string; envVar: string; signupUrl: string; baseURL: string }`
  - `SETUP_PROVIDERS: SetupProvider[]` ordered groq → google → openrouter → mistral → cerebras (groq FIRST = recommended)
  - `buildEnvContent(existing: string | undefined, updates: Record<string, string>): string`

- [ ] **Step 1: Write failing tests**

Create `test/unit/setup.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SETUP_PROVIDERS, buildEnvContent } from "../../src/setup.js";

describe("SETUP_PROVIDERS", () => {
  it("recommends groq first", () => {
    expect(SETUP_PROVIDERS[0].name).toBe("groq");
  });

  it("covers the five live providers and skips retired github", () => {
    expect(SETUP_PROVIDERS.map((p) => p.name)).toEqual([
      "groq", "google", "openrouter", "mistral", "cerebras",
    ]);
  });

  it("uses https everywhere", () => {
    for (const p of SETUP_PROVIDERS) {
      expect(p.baseURL.startsWith("https://")).toBe(true);
      expect(p.signupUrl.startsWith("https://")).toBe(true);
    }
  });
});

describe("buildEnvContent", () => {
  it("creates sorted KEY=VALUE lines from nothing", () => {
    expect(buildEnvContent(undefined, { GROQ_API_KEY: "gsk_1", B_KEY: "2" }))
      .toBe("B_KEY=2\nGROQ_API_KEY=gsk_1\n");
  });

  it("upserts known keys while preserving unrecognized lines", () => {
    const existing = "# my notes\nOLD_TOKEN=abc\nGROQ_API_KEY=gsk_old\n";
    const out = buildEnvContent(existing, { GROQ_API_KEY: "gsk_new" });
    expect(out).toContain("OLD_TOKEN=abc");
    expect(out).not.toContain("gsk_old");
    expect(out).toContain("GROQ_API_KEY=gsk_new");
  });

  it("drops duplicate definitions of an updated key", () => {
    const existing = "GROQ_API_KEY=a\nGROQ_API_KEY=b\n";
    const out = buildEnvContent(existing, { GROQ_API_KEY: "c" });
    expect(out.match(/GROQ_API_KEY=/g)).toHaveLength(1);
    expect(out).toContain("GROQ_API_KEY=c");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/setup.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/setup.ts`:

```typescript
export interface SetupProvider {
  name: string;
  envVar: string;
  signupUrl: string;
  baseURL: string;
}

// Ordered by onboarding friction — groq is the recommended first key.
// GitHub Models omitted: provider retired July 2026.
export const SETUP_PROVIDERS: SetupProvider[] = [
  { name: "groq", envVar: "GROQ_API_KEY", signupUrl: "https://console.groq.com/keys", baseURL: "https://api.groq.com/openai/v1" },
  { name: "google", envVar: "GEMINI_API_KEY", signupUrl: "https://aistudio.google.com/apikey", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" },
  { name: "openrouter", envVar: "OPENROUTER_API_KEY", signupUrl: "https://openrouter.ai/settings/keys", baseURL: "https://openrouter.ai/api/v1" },
  { name: "mistral", envVar: "MISTRAL_API_KEY", signupUrl: "https://console.mistral.ai/api-keys", baseURL: "https://api.mistral.ai/v1" },
  { name: "cerebras", envVar: "CEREBRAS_API_KEY", signupUrl: "https://cloud.cerebras.ai", baseURL: "https://api.cerebras.ai/v1" },
];

// Whole-file rewrite after merge: keep lines we don't manage verbatim,
// replace every definition of an updated key with exactly one new line.
export function buildEnvContent(
  existing: string | undefined,
  updates: Record<string, string>,
): string {
  const kept: string[] = [];
  for (const rawLine of (existing ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!m || m[1] in updates) continue;
    kept.push(line);
  }
  for (const [k, v] of Object.entries(updates)) kept.push(`${k}=${v}`);
  return `${kept.sort().join("\n")}\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/setup.test.ts && npm run build`
Expected: PASS; clean build.

- [ ] **Step 5: Commit**

```powershell
git add src/setup.ts test/unit/setup.test.ts
git commit -m "feat: setup provider catalog and env-file merge"
```

---

### Task 2: Key validation

**Files:**
- Modify: `src/setup.ts`
- Modify: `test/unit/setup.test.ts` (append)

**Interfaces:**
- Consumes: `SetupProvider.baseURL` (Task 1).
- Produces: `validateKey(baseURL: string, key: string, fetchImpl?: typeof fetch): Promise<{ ok: true } | { ok: false; detail: string }>` — single `GET <baseURL>/models` with bearer auth; 2xx ⇒ ok; 401/403 ⇒ `"invalid key"`; anything else ⇒ `"HTTP <status>"`; transport error ⇒ error message.

- [ ] **Step 1: Write failing tests**

Append to `test/unit/setup.test.ts`:

```typescript
import { validateKey } from "../../src/setup.js";

describe("validateKey", () => {
  it("passes on 2xx and hits the models endpoint with the bearer key", async () => {
    const calls: Array<{ url: string; auth?: unknown }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), auth: (init?.headers as Record<string, unknown>)?.authorization });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await validateKey("https://x.test/v1/", "sk_abc", fetchImpl);
    expect(res).toEqual({ ok: true });
    expect(calls[0].url).toBe("https://x.test/v1/models");
    expect(calls[0].auth).toBe("Bearer sk_abc");
  });

  it("rejects 401/403 as invalid key", async () => {
    for (const status of [401, 403]) {
      const fetchImpl = (async () => new Response("{}", { status })) as unknown as typeof fetch;
      const res = await validateKey("https://x.test/v1", "bad", fetchImpl);
      expect(res).toEqual({ ok: false, detail: "invalid key" });
    }
  });

  it("reports unexpected statuses and transport errors", async () => {
    const fetch500 = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    expect(await validateKey("https://x.test/v1", "k", fetch500))
      .toEqual({ ok: false, detail: "HTTP 500" });
    const fetchBoom = (async () => { throw new Error("dns fail"); }) as unknown as typeof fetch;
    expect(await validateKey("https://x.test/v1", "k", fetchBoom))
      .toEqual({ ok: false, detail: "dns fail" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/setup.test.ts`
Expected: FAIL — `validateKey` missing.

- [ ] **Step 3: Implement**

Append to `src/setup.ts`:

```typescript
function joinURL(base: string, pathPart: string): string {
  return base.replace(/\/+$/, "") + pathPart;
}

export interface KeyValidation {
  ok: boolean;
  detail?: string;
}

export async function validateKey(
  baseURL: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyValidation> {
  try {
    const res = await fetchImpl(joinURL(baseURL, "/models"), {
      headers: { authorization: `Bearer ${key}` },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, detail: "invalid key" };
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
```

Type note: `KeyValidation.detail` is optional so the success branch needs no extra key; the Task 1 tests' `toEqual({ ok: true })` stays valid because `toEqual` ignores `undefined` properties.

Adjust the interface in the plan header accordingly: this returns `{ ok: true } | { ok: false; detail: string }` semantically.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/setup.test.ts && npm run build`
Expected: PASS; clean build.

- [ ] **Step 5: Commit**

```powershell
git add src/setup.ts test/unit/setup.test.ts
git commit -m "feat: lightweight provider key validation"
```

---

### Task 3: Setup flow (flags + interactive)

**Files:**
- Modify: `src/setup.ts`
- Modify: `test/unit/setup.test.ts` (append)

**Interfaces:**
- Consumes: `SETUP_PROVIDERS`, `buildEnvContent`, `validateKey` (Tasks 1–2); `fs/promises`.
- Produces:
  ```ts
  export interface SetupOptions {
    envPath: string;
    interactive: boolean;
    provider?: string;   // flag path only
    key?: string;        // flag path only
    input?: import("node:stream").Readable;   // interactive only
    output?: import("node:stream").Writable;  // interactive only
    fetchImpl?: typeof fetch;
    openImpl?: (url: string) => void;
  }
  export function runSetup(opts: SetupOptions): Promise<number>;
  ```
  Exit codes: 0 saved ≥1 key; 64 bad arguments; 1 validation failed / aborted.
  Behavior: flags path requires BOTH `provider` and `key`. Interactive path recommends `SETUP_PROVIDERS[0]`, prints signup URL (+ `openImpl`), validates pasted keys (≤3 attempts), merges each accepted key into `envPath` immediately, then offers the remaining providers one at a time with `[y/N]`.

- [ ] **Step 1: Write failing tests**

Append to `test/unit/setup.test.ts`:

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { runSetup } from "../../src/setup.js";

function tmpEnvPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-setup-")), ".env");
}

const goodFetch = (async (_url: string | URL, init?: RequestInit) => {
  const auth = (init?.headers as Record<string, string>)?.authorization ?? "";
  return new Response("{}", { status: auth.endsWith("good") ? 200 : 401 });
}) as unknown as typeof fetch;

async function interact(script: string[], opts: Partial<Parameters<typeof runSetup>[0]> = {}) {
  const chunks: string[] = [];
  const input = new Readable({ read() {} });
  const output = new Writable({
    write(c: Buffer, _enc, cb) { chunks.push(c.toString()); cb(); },
  });
  const envPath = tmpEnvPath();
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => { resolveDone = r; });
  void runSetup({
    envPath,
    interactive: true,
    input,
    output,
    fetchImpl: goodFetch,
    ...opts,
  }).then(resolveDone);
  // feed lines asynchronously so prompts render between them
  (async () => {
    for (const line of script) {
      await new Promise<void>((r) => setTimeout(r, 5));
      input.push(`${line}\n`);
    }
  })();
  const code = await done;
  input.destroy();
  return { code, text: chunks.join(""), envPath };
}

describe("runSetup flags path", () => {
  it("requires both provider and key", async () => {
    expect(await runSetup({ envPath: tmpEnvPath(), interactive: false })).toBe(64);
    expect(await runSetup({ envPath: tmpEnvPath(), interactive: false, provider: "groq" })).toBe(64);
  });

  it("rejects unknown providers", async () => {
    expect(await runSetup({
      envPath: tmpEnvPath(), interactive: false, provider: "acme", key: "k",
    })).toBe(64);
  });

  it("validates and saves a good key", async () => {
    const envPath = tmpEnvPath();
    const code = await runSetup({
      envPath, interactive: false, provider: "groq", key: "good", fetchImpl: goodFetch,
    });
    expect(code).toBe(0);
    expect(fs.readFileSync(envPath, "utf8")).toContain("GROQ_API_KEY=good");
  });

  it("fails without writing on a bad key", async () => {
    const envPath = tmpEnvPath();
    const code = await runSetup({
      envPath, interactive: false, provider: "groq", key: "bad", fetchImpl: goodFetch,
    });
    expect(code).toBe(1);
    expect(fs.existsSync(envPath)).toBe(false);
  });
});

describe("runSetup interactive path", () => {
  it("takes groq by default, saves the key, declines extras", async () => {
    const { code, text, envPath } = await interact(["", "good", "n"]);
    expect(code).toBe(0);
    expect(text).toContain("console.groq.com/keys");
    expect(fs.readFileSync(envPath, "utf8")).toContain("GROQ_API_KEY=good");
  });

  it("retries invalid paste up to three attempts", async () => {
    const { code, text, envPath } = await interact(["", "nope", "nope", "good", "n"]);
    expect(code).toBe(0);
    expect((text.match(/invalid key/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(envPath, "utf8")).toContain("GROQ_API_KEY=good");
  });

  it("accepts a second provider when answered y", async () => {
    const { code, envPath } = await interact(["google", "good", "y", "good", "n", "n"]);
    expect(code).toBe(0);
    const content = fs.readFileSync(envPath, "utf8");
    expect(content).toContain("GEMINI_API_KEY=good");
    expect(content).toContain("GROQ_API_KEY=");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/setup.test.ts`
Expected: FAIL — `runSetup` missing.

- [ ] **Step 3: Implement**

Append to `src/setup.ts`:

```typescript
import fsSync from "node:fs";
import fs from "node:fs/promises";
import readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface SetupOptions {
  envPath: string;
  interactive: boolean;
  provider?: string;
  key?: string;
  input?: Readable;
  output?: Writable;
  fetchImpl?: typeof fetch;
  openImpl?: (url: string) => void;
}

async function saveEnv(envPath: string, provider: SetupProvider, key: string): Promise<void> {
  const existing = fsSync.existsSync(envPath)
    ? await fs.readFile(envPath, "utf8")
    : undefined;
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  await fs.writeFile(envPath, buildEnvContent(existing, { [provider.envVar]: key }));
}

export async function runSetup(opts: SetupOptions): Promise<number> {
  if (!opts.interactive) {
    const provider = SETUP_PROVIDERS.find((p) => p.name === opts.provider);
    if (!opts.provider || !opts.key || !provider) return 64;
    const verdict = await validateKey(provider.baseURL, opts.key, opts.fetchImpl);
    if (!verdict.ok) {
      process.stderr.write(`key rejected (${verdict.detail}); nothing was written\n`);
      return 1;
    }
    await saveEnv(opts.envPath, provider, opts.key);
    process.stderr.write(`saved ${provider.envVar} to ${opts.envPath}\n`);
    process.stderr.write(`start serving: node dist/cli.js serve\n`);
    return 0;
  }

  const rl = readline.createInterface({ input: opts.input!, output: opts.output! });
  const out = (...lines: string[]) => rl.write(lines.join("\n") + "\n");
  // EOF (Ctrl-D / scripted streams ending early) must terminate prompts
  // gracefully instead of rejecting an unanswered question forever.
  const ask = async (prompt: string): Promise<string> => {
    try {
      return (await rl.question(prompt)).trim();
    } catch {
      return "";
    }
  };

  try {
    out(
      "freeroll setup",
      "",
      "One free provider is enough to start. Recommended: Groq (fast signup, generous free tier).",
      "Providers:",
      ...SETUP_PROVIDERS.map((p, i) => `  ${i + 1}. ${p.name}`),
    );

    const pickName = await ask(`Provider to start with [${SETUP_PROVIDERS[0].name}]: `);
    const chosenIdx = pickName === ""
      ? 0
      : Number.isNaN(Number(pickName))
        ? SETUP_PROVIDERS.findIndex((p) => p.name === pickName.toLowerCase())
        : Number(pickName) - 1;
    const rest = [...SETUP_PROVIDERS];
    if (chosenIdx < 0 || chosenIdx >= SETUP_PROVIDERS.length) {
      out(`unknown provider '${pickName}'`);
      return 1;
    }
    const [first] = rest.splice(chosenIdx, 1);

    const collect = async (provider: SetupProvider): Promise<boolean> => {
      out("", `Opening ${provider.signupUrl}`, "(paste an API key when you have one)");
      try {
        opts.openImpl?.(provider.signupUrl);
      } catch {
        // opening a browser is best-effort
      }
      for (let attempt = 1; attempt <= 3; attempt++) {
        const key = await ask(`${provider.envVar}: `);
        if (!key) continue;
        const verdict = await validateKey(provider.baseURL, key, opts.fetchImpl);
        if (verdict.ok) {
          await saveEnv(opts.envPath, provider, key);
          out(`saved ${provider.envVar}`);
          return true;
        }
        out(`attempt ${attempt}/3: ${verdict.detail}`);
      }
      out(`giving up on ${provider.name} for now`);
      return false;
    };

    let saved = (await collect(first)) ? 1 : 0;
    for (const bonus of rest) {
      const wantsMore = (await ask(`Add ${bonus.name} too? [y/N]: `)).toLowerCase();
      if (wantsMore !== "y") continue;
      if (await collect(bonus)) saved++;
    }

    out(
      "",
      saved > 0
        ? `Done — ${saved} provider key(s) in ${opts.envPath}. Start with: node dist/cli.js serve`
        : "No keys saved. Re-run freeroll setup whenever you're ready.",
    );
    return saved > 0 ? 0 : 1;
  } finally {
    rl.close();
  }
}
```

Add the missing import alongside the others at top of file:

```typescript
import path from "node:path";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/setup.test.ts && npm test && npm run build`
Expected: PASS everywhere; clean build.

- [ ] **Step 5: Commit**

```powershell
git add src/setup.ts test/unit/setup.test.ts
git commit -m "feat: interactive and scripted freeroll setup flow"
```

---

### Task 4: CLI wiring, README quickstart, smoke checklist

**Files:**
- Modify: `src/cli.ts`
- Modify: `README.md`
- Modify: `docs/manual-smoke.md` (append)

**Interfaces:**
- Consumes: `runSetup`, `SETUP_PROVIDERS` (Task 3); `defaultEnvPath` (existing config export).
- Produces: `freeroll setup [--provider NAME --key VALUE] [--env FILE]` returning runSetup's code; README quickstart leads with setup.

- [ ] **Step 1: Write failing test**

Append to `test/unit/cli.test.ts`:

```typescript
import { runSetup } from "../../src/setup.js";

describe("cli setup routing", () => {
  it("routes setup flags to runSetup and propagates its code", async () => {
    const envPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-cli-set-")), ".env");
    const goodFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = goodFetch;
    try {
      const code = await runCli(["setup", "--provider", "groq", "--key", "gsk_ok", "--env", envPath]);
      expect(code).toBe(0);
      expect(fs.readFileSync(envPath, "utf8")).toContain("GROQ_API_KEY=gsk_ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

Note: the flag path intentionally uses real `globalThis.fetch` inside `runCli` wiring unless overridden — the CLI passes no `fetchImpl`, so this test stubs `globalThis.fetch` temporarily. This is the one place a global stub is acceptable (documented here).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/cli.test.ts`
Expected: FAIL — `setup` falls through to usage/64.

- [ ] **Step 3: Implement**

`src/cli.ts` import:

```typescript
import { runSetup, SETUP_PROVIDERS } from "./setup.js";
```

Wire before the fallthrough:

```typescript
  if (cmd === "setup") {
    const flag = (name: string): string | undefined => {
      const i = argv.indexOf(name);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    const provider = flag("--provider");
    const key = flag("--key");
    const envPath = flag("--env") ?? defaultEnvPath();
    const interactive = provider === undefined && key === undefined;
    if (!interactive && !SETUP_PROVIDERS.some((p) => p.name === provider)) {
      process.stderr.write(`unknown provider '${provider}'. options: ${SETUP_PROVIDERS.map((p) => p.name).join(", ")}\n`);
      return 64;
    }
    return runSetup({ envPath, interactive, provider, key });
  }
```

Update the usage line to `[serve|status|setup|export-stats|revive]`.

README — replace everything from `## Quickstart` through the PowerShell warning block with:

```markdown
## Quickstart

    npm install
    npm run build
    node dist/cli.js setup

The wizard recommends starting with a **single** provider (Groq — fast signup,
generous free tier), opens the key page, validates your key with a live call,
and stores it in `%USERPROFILE%\.freeroll\.env`. Adding more providers later is
optional bonus capacity — re-run `freeroll setup` anytime.

Scripted equivalent (CI, dotfiles):

    node dist/cli.js setup --provider groq --key gsk_...

Then point any OpenAI-compatible tool at the server:

    node dist/cli.js serve     # http://127.0.0.1:8787/v1

    base URL: http://127.0.0.1:8787/v1
    API key:  anything (freeroll does not check client keys)
    model:    auto/coding | auto/fast | auto/any

Prefer manual setup? Any subset of these works as environment variables
(a `.env` in `~/.freeroll/` is loaded):
`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`,
`CEREBRAS_API_KEY`.

> Warning: in PowerShell, plain `set NAME=value` does **not** create an
> environment variable — use `$env:NAME = value`.
```

(The old Configuration section already documents env vars; leave it.)

Append to `docs/manual-smoke.md`:

```markdown
## Setup wizard — zero-key-user acceptance

1. Temporarily hide any real keys: `$env:GROQ_API_KEY=$null` etc.; ensure `%USERPROFILE%\.freeroll\.env` does not exist.
2. `node dist/cli.js setup` — accept the Groq recommendation (Enter).
3. Browser opens console.groq.com/keys (or copy the printed URL); create a key; paste it.
4. Expect `saved GROQ_API_KEY`; answer `N` to all bonus providers.
5. `node dist/cli.js serve` → POST a tools request to `http://127.0.0.1:8787/v1/chat/completions` with `model:"auto/coding"`.
6. Expect HTTP 200, `x-freeroll-served-by` starting `groq::`.
7. `node dist/cli.js status` shows `1/6 providers have keys` and groq rows only.
```

- [ ] **Step 4: Run full verification**

Run: `npm test; if ($?) { npm run build }`
Expected: green; clean build.

- [ ] **Step 5: Commit**

```powershell
git add src/cli.ts README.md docs/manual-smoke.md test/unit/cli.test.ts
git commit -m "feat: freeroll setup command leads the quickstart"
```

---

## Completion checklist (Plan D)

- [ ] `npm test` green; `npm run build` clean.
- [ ] Acceptance: zero-key user reaches a working `auto/coding` request using only `freeroll setup` + one provider signup (manual smoke checklist).
- [ ] Wizard is inert without explicit invocation; never logs or persists the raw key beyond `.env`.
