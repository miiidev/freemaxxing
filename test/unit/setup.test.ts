import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { SETUP_PROVIDERS, buildEnvContent, validateKey, runSetup, listInstalledLocalModels } from "../../src/setup.js";

describe("SETUP_PROVIDERS", () => {
  it("recommends groq first", () => {
    expect(SETUP_PROVIDERS[0].name).toBe("groq");
  });

  it("covers the six live providers including local", () => {
    expect(SETUP_PROVIDERS.map((p) => p.name)).toEqual([
      "groq", "google", "openrouter", "mistral", "cerebras", "local",
    ]);
  });

  it("uses https everywhere", () => {
    for (const p of SETUP_PROVIDERS) {
      if (p.name === "local") continue;
      expect(p.baseURL.startsWith("https://")).toBe(true);
      expect(p.signupUrl).toBeDefined();
      expect(p.signupUrl!.startsWith("https://")).toBe(true);
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
    input.push(null); // EOF — unanswered prompts must take defaults
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
  it("takes groq by default, saves the key, declines extras via EOF", async () => {
    const { code, text, envPath } = await interact(["", "good"]);
    expect(code).toBe(0);
    expect(text).toContain("console.groq.com/keys");
    expect(fs.readFileSync(envPath, "utf8")).toContain("GROQ_API_KEY=good");
  });

  it("retries invalid paste up to three attempts", async () => {
    const { code, text, envPath } = await interact(["", "nope", "nope", "good"]);
    expect(code).toBe(0);
    expect((text.match(/attempt \d\/3/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(envPath, "utf8")).toContain("GROQ_API_KEY=good");
  });

  it("accepts a second provider when answered y", async () => {
    const { code, envPath } = await interact(["google", "good", "y", "good"]);
    expect(code).toBe(0);
    const content = fs.readFileSync(envPath, "utf8");
    expect(content).toContain("GEMINI_API_KEY=good");
    expect(content).toContain("GROQ_API_KEY=");
  });
});

describe("local provider setup", () => {
  it("lists installed Ollama models", async () => {
    const fetchImpl = (async (url: string) => {
      if ((url as string).endsWith("/api/tags")) {
        return new Response(JSON.stringify({
          models: [{ name: "llama3.2:latest" }, { name: "mistral:latest" }],
        }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const installed = await listInstalledLocalModels("http://localhost:11434", fetchImpl, (...l: string[]) => void lines.push(...l));
    expect(installed.has("llama3.2:latest")).toBe(true);
    expect(installed.has("mistral:latest")).toBe(true);
  });

  it("handles Ollama unreachable gracefully", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const lines: string[] = [];
    const installed = await listInstalledLocalModels("http://localhost:11434", fetchImpl, (...l: string[]) => void lines.push(...l));
    expect(installed.size).toBe(0);
  });
});
