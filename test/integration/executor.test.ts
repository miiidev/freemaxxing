import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute } from "../../src/executor.js";
import { bindStateFile, loadState } from "../../src/state.js";
import type { ActiveProvider } from "../../src/config.js";
import type { RegistryEntry } from "../../src/types.js";

const P_GROQ: ActiveProvider = {
  baseURL: "https://groq.test/v1",
  auth: "bearer",
  quirks: "groq",
  resetProfile: { kind: "daily-utc-midnight" },
  apiKey: "sk-test",
};
const A: RegistryEntry = {
  id: "groq::a", provider: "groq", upstream: "a",
  tags: ["coding"], tier: 1, speed: "fast", context: 1000, tools: true,
};
const B: RegistryEntry = { ...A, id: "groq::b", upstream: "b" };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("execute", () => {
  beforeEach(() => bindStateFile(null));

  it("returns first healthy candidate and swaps alias for upstream model name", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse(200, { id: "x", choices: [] });
    }) as unknown as typeof fetch;

    const res = await execute({
      candidates: [A],
      providers: { groq: P_GROQ },
      body: { model: "auto/coding", messages: [{ role: "user", content: "hi" }] },
      stateMap: new Map(),
      fetchImpl,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.servedBy.id).toBe("groq::a");
      expect(res.attempts).toEqual([]);
    }
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.model).toBe("a");
    expect(calls[0].init.headers).toMatchObject({ authorization: "Bearer sk-test" });
    expect(calls[0].url).toBe("https://groq.test/v1/chat/completions");
  });

  it("fails over on quota 429, records exhausted state, persists snapshot", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-exec-")), "state.json");
    bindStateFile(file);

    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      return sent.model === "a"
        ? jsonResponse(429, { error: { message: "Rate limit reached on tokens per day (TPD)" } })
        : jsonResponse(200, { id: "y", choices: [] });
    }) as unknown as typeof fetch;

    const stateMap = new Map();
    const res = await execute({
      candidates: [A, B],
      providers: { groq: P_GROQ },
      body: { model: "auto/coding", messages: [] },
      stateMap,
      fetchImpl,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.servedBy.id).toBe("groq::b");
    expect(res.attempts).toEqual([
      { model: "groq::a", reason: "quota 429", status: 429, detail: '{"error":{"message":"Rate limit reached on tokens per day (TPD)"}}' },
    ]);
    expect(stateMap.get("groq::a")?.state).toBe("exhausted");
    expect(loadState(file).get("groq::a")?.state).toBe("exhausted");
  });

  it("does not cool down models on deterministic client errors (bad_request)", async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      return sent.model === "a"
        ? jsonResponse(400, { error: { message: "max_tokens is too large" } })
        : jsonResponse(200, { id: "z", choices: [] });
    }) as unknown as typeof fetch;

    const stateMap = new Map();
    const res = await execute({
      candidates: [A, B],
      providers: { groq: P_GROQ },
      body: { messages: [] },
      stateMap,
      fetchImpl,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.servedBy.id).toBe("groq::b");
    expect(res.attempts).toEqual([
      {
        model: "groq::a",
        reason: "bad_request 400",
        status: 400,
        detail: '{"error":{"message":"max_tokens is too large"}}',
      },
    ]);
    expect(stateMap.has("groq::a")).toBe(false);
  });

  it("returns ok:false with attempt reasons when everything fails", async () => {
    const fetchImpl = (async () => jsonResponse(500, { oops: true })) as unknown as typeof fetch;
    const res = await execute({
      candidates: [A, B],
      providers: { groq: P_GROQ },
      body: { messages: [] },
      stateMap: new Map(),
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toEqual([
        { model: "groq::a", reason: "outage 500", status: 500, detail: '{"oops":true}' },
        { model: "groq::b", reason: "outage 500", status: 500, detail: '{"oops":true}' },
      ]);
    }
  });

  it("treats connect timeouts as outage and moves on", async () => {
    const fetchImpl = ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    const stateMap = new Map();
    const res = await execute({
      candidates: [A],
      providers: { groq: P_GROQ },
      body: { messages: [] },
      stateMap: stateMap,
      ttfbTimeoutMs: 20,
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.attempts).toEqual([{ model: "groq::a", reason: "outage" }]);
    expect(stateMap.get("groq::a")?.state).toBe("cooldown");
  });

  it("skips candidates whose provider has no key", async () => {
    const res = await execute({
      candidates: [A],
      providers: {},
      body: { messages: [] },
      stateMap: new Map(),
      fetchImpl: (() => undefined) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.attempts).toEqual([{ model: "groq::a", reason: "no-key" }]);
  });
});
