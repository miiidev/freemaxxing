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
      sleepImpl: (async () => {}) as (ms: number) => Promise<void>,
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toEqual([
        { model: "groq::a", reason: "outage 500", status: 500, detail: '{"oops":true}' },
        { model: "groq::a", reason: "outage 500", status: 500, detail: '{"oops":true}' },
        { model: "groq::b", reason: "outage 500", status: 500, detail: '{"oops":true}' },
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
      sleepImpl: (async () => {}) as (ms: number) => Promise<void>,
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toEqual([
        { model: "groq::a", reason: "outage" },
        { model: "groq::a", reason: "outage" },
      ]);
    }
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

const OR: ActiveProvider = {
  baseURL: "https://or.test/v1",
  auth: "bearer",
  quirks: "openrouter",
  resetProfile: { kind: "daily-utc-midnight" },
  apiKey: "sk-or",
};
const OR_A: RegistryEntry = {
  id: "or::a",
  provider: "or",
  upstream: "a",
  tags: ["coding"],
  tier: 1,
  speed: "fast",
  context: 1000,
  tools: true,
};
const OR_B: RegistryEntry = { ...OR_A, id: "or::b", upstream: "b" };
const GR_C: RegistryEntry = { ...A, id: "groq::c", upstream: "c" };
const NO_SLEEP = (async () => {}) as (ms: number) => Promise<void>;

describe("failure taxonomy", () => {
  it("pooled quota kills the whole provider pool and jumps straight to the next provider", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      calls.push(sent.model);
      return sent.model === "a"
        ? jsonResponse(429, { error: { message: "Free-models-per-day limit exceeded" } })
        : jsonResponse(200, { id: "y", choices: [] });
    }) as unknown as typeof fetch;

    const stateMap = new Map();
    const res = await execute({
      candidates: [OR_A, OR_B, GR_C],
      providers: { or: OR, groq: P_GROQ },
      body: { messages: [] },
      stateMap,
      providerCaps: { or: { rpd: 50 } },
      sleepImpl: NO_SLEEP,
      fetchImpl,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.servedBy.id).toBe("groq::c");
    expect(calls).toEqual(["a", "c"]); // or::b was never attempted
    expect(res.attempts.map((a) => a.reason)).toEqual(["quota 429", "pool-exhausted"]);
    expect(stateMap.get("pool::or")).toMatchObject({ state: "exhausted", reason: "pool" });
    expect(stateMap.get("or::a")).toMatchObject({ state: "exhausted", reason: "pool" });
  });

  it("non-pooled quota marks just the model with daily-cap reason", async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      return sent.model === "a"
        ? jsonResponse(429, { error: { message: "Rate limit reached on tokens per day (TPD)" } })
        : jsonResponse(200, { id: "z", choices: [] });
    }) as unknown as typeof fetch;

    const stateMap = new Map();
    await execute({
      candidates: [A, B],
      providers: { groq: P_GROQ },
      body: { messages: [] },
      stateMap,
      sleepImpl: NO_SLEEP,
      fetchImpl,
    });
    expect(stateMap.get("groq::a")).toMatchObject({ state: "exhausted", reason: "daily-cap" });
    expect(stateMap.has("pool::groq")).toBe(false);
  });

  it("404 retires the model permanently and moves on", async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      return sent.model === "a"
        ? jsonResponse(404, { error: { message: "No endpoints found" } })
        : jsonResponse(200, { id: "w", choices: [] });
    }) as unknown as typeof fetch;

    const stateMap = new Map();
    const res = await execute({
      candidates: [A, B],
      providers: { groq: P_GROQ },
      body: { messages: [] },
      stateMap,
      sleepImpl: NO_SLEEP,
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.servedBy.id).toBe("groq::b");
    expect(stateMap.get("groq::a")).toEqual({ state: "retired", since: expect.any(Number) });
  });

  it("transient 5xx retries the SAME model once before failing over", async () => {
    let callsForA = 0;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      if (sent.model === "a") {
        callsForA++;
        return callsForA === 1
          ? jsonResponse(503, { oops: true })
          : jsonResponse(200, { id: "v", choices: [] });
      }
      return jsonResponse(200, { id: "fallback", choices: [] });
    }) as unknown as typeof fetch;

    const slept: number[] = [];
    const res = await execute({
      candidates: [A, B],
      providers: { groq: P_GROQ },
      body: { messages: [] },
      stateMap: new Map(),
      retryBackoffMs: 250,
      sleepImpl: (ms) => { slept.push(ms); return Promise.resolve(); },
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.servedBy.id).toBe("groq::a"); // recovered in place
    expect(callsForA).toBe(2);
    expect(slept).toEqual([250]);
    expect(res.attempts.map((x) => x.reason)).toEqual(["outage 503"]);
  });

  it("transient that fails twice records a transient cooldown and fails over", async () => {
    const fetchImpl = (async () => jsonResponse(500, { oops: true })) as unknown as typeof fetch;
    const stateMap = new Map();
    const res = await execute({
      candidates: [A, B],
      providers: { groq: P_GROQ },
      body: { messages: [] },
      stateMap,
      retryBackoffMs: 0,
      sleepImpl: NO_SLEEP,
      fetchImpl,
    });
    expect(stateMap.get("groq::a")).toMatchObject({ state: "cooldown", reason: "transient" });
    expect(res.attempts.map((x) => `${x.model}:${x.reason}`)).toEqual([
      "groq::a:outage 500",
      "groq::a:outage 500",
      "groq::b:outage 500",
      "groq::b:outage 500",
    ]);
  });

  it("rate 429 cools down just that model and moves on without same-model retry", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      calls.push(sent.model);
      return sent.model === "a"
        ? jsonResponse(429, { error: { message: "too many requests" } }, { "retry-after": "30" })
        : jsonResponse(200, { id: "y", choices: [] });
    }) as unknown as typeof fetch;

    const slept: number[] = [];
    const stateMap = new Map();
    const res = await execute({
      candidates: [A, B],
      providers: { groq: P_GROQ },
      body: { messages: [] },
      stateMap,
      sleepImpl: (ms) => { slept.push(ms); return Promise.resolve(); },
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.servedBy.id).toBe("groq::b");
    expect(calls).toEqual(["a", "b"]);
    expect(slept).toEqual([]);
    expect(stateMap.get("groq::a")).toMatchObject({ state: "cooldown", reason: "peak-throttle" });
  });
});

const TOOL_BODY = {
  messages: [],
  tools: [{ type: "function", function: { name: "patch" } }],
};

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

  it("writes health state for malformed output", async () => {
    const stateMap = new Map();
    const fetchImpl = (async () => jsonResponse(200, { id: "x", choices: [] })) as unknown as typeof fetch;
    await execute({
      candidates: [A], providers: { groq: P_GROQ },
      body: bodyWithTools, stateMap, fetchImpl,
      inspect: async () => "cutoff-length",
    });
    expect(stateMap.size).toBe(1);
    expect(stateMap.get("groq::a")).toMatchObject({ state: "cooldown", reason: "malformed" });
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
