import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildServer } from "../../src/server.js";
import type { AppConfig, ActiveProvider } from "../../src/config.js";
import { REGISTRY } from "../../src/catalog.js";
import { BUILT_IN_ALIASES } from "../../src/router.js";
import { loadUsage, bindUsageFile, utcDayKey } from "../../src/usage.js";
import { loadState } from "../../src/state.js";
import type { DailyCaps, RegistryEntry, UsageMap } from "../../src/types.js";

const CFG: AppConfig = {
  port: 8787, host: "127.0.0.1", aliases: {},
  providers: { groq: { apiKeyEnv: "GROQ_API_KEY" } },
  annotateResponses: true,
  harvest: true,
};
const PROV: Record<string, ActiveProvider> = {
  groq: {
    baseURL: "https://groq.test/v1", auth: "bearer", quirks: "groq",
    resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk",
  },
};

function makeServer(
  fetchImpl?: typeof fetch,
  opts?: { usageMap?: UsageMap; providerCaps?: Record<string, DailyCaps>; registry?: RegistryEntry[] },
) {
  return buildServer({
    config: CFG, providers: PROV, aliases: BUILT_IN_ALIASES,
    registry: opts?.registry ?? REGISTRY, stateMap: new Map(), fetchImpl,
    usageMap: opts?.usageMap, providerCaps: opts?.providerCaps,
  });
}

describe("GET /v1/models", () => {
  it("lists aliases first then registry entries", async () => {
    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data.find((m: { id: string }) => m.id === "auto/coding").maxout_alias).toBe(true);
    expect(body.data.some((m: { id: string }) => m.id === "groq::openai/gpt-oss-120b")).toBe(true);
  });
});

describe("POST /v1/chat/completions", () => {
  it("400 on missing messages", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request");
  });

  it("404 on unknown alias", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "wat/ever", messages: [{ role: "user", content: "x" }] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.type).toBe("unknown_alias");
  });

  it("proxies success, rewrites model field, sets served-by header", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ id: "x", model: "whatever-upstream", choices: [{ message: { role: "assistant", content: "hi" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const app = makeServer(fetchImpl);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/fast", messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.json().model)).toMatch(/^groq::/);
    expect(res.headers["x-maxout-served-by"]).toMatch(/^groq::/);
  });

  it("defaults missing model to auto/coding", async () => {
    let seenModel: string | undefined;
    const responseBody = `{
      "choices": [{
        "finish_reason": "tool_calls",
        "message": {
          "tool_calls": [{
            "function": {
              "name": "patch",
              "arguments": "{\\"path\\":\\"x.ts\\",\\"diff\\":\\"@@\\"}"
            }
          }]
        }
      }]
    }`;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seenModel = String(JSON.parse(String(init?.body)).model);
      return new Response(responseBody, { status: 200 });
    }) as unknown as typeof fetch;
    const app = makeServer(fetchImpl);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(seenModel).toMatch(/^[a-z]/); // an upstream model id was sent
  });

  it("503 all_models_exhausted with attempts breakdown", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    const app = makeServer(fetchImpl);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/fast", messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(503);
    const errBody = res.json().error;
    expect(errBody.type).toBe("all_models_exhausted");
    expect(errBody.attempts.length).toBeGreaterThan(0);
    const groqAttempt = errBody.attempts.find((a: { model: string }) => a.model.startsWith("groq::"));
    expect(groqAttempt).toBeTruthy();
    expect(groqAttempt.model).toMatch(/^groq::/);
    expect(groqAttempt.reason).toBe("rate 429");
  });

  it("non-streaming success content ends with served-by annotation", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ id: "x", model: "upstream", choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const app = makeServer(fetchImpl);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/fast", messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].message.content).toMatch(/\n\n---\n\*maxout: groq::/);
  });

  it("non-streaming with annotateResponses=false leaves content untouched", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ id: "x", model: "upstream", choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const app = buildServer({
      config: { ...CFG, annotateResponses: false },
      providers: PROV, aliases: BUILT_IN_ALIASES,
      registry: REGISTRY, stateMap: new Map(), fetchImpl,
    });
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/fast", messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].message.content).toBe("Hello!");
  });
});

describe("harvest recording (non-streaming)", () => {
  it("records exact usage from the response body", async () => {
    const usageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-srv-")), "usage.json");
    // single candidate: with several limited models the headroom sort would
    // rotate request 2 onto a fresh model and break exact-count assertions
    const limited = REGISTRY.filter((e) => e.id === "groq::openai/gpt-oss-120b")
      .map((e) => ({ ...e, limits: { rpd: 2 } }));
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const usageMap = new Map();
    const app = makeServer(fetchImpl, { usageMap, registry: limited });
    bindUsageFile(usageFile);
    try {
      for (let i = 0; i < 2; i++) {
        await app.inject({ method: "POST", url: "/v1/chat/completions",
          payload: { messages: [{ role: "user", content: "hi" }] } });
      }
      const rec = loadUsage(usageFile).get("groq::openai/gpt-oss-120b");
      expect(rec?.requests).toBe(2);
      expect(rec?.tokensIn).toBe(200);
      expect(rec?.tokensOut).toBe(40);
    } finally {
      bindUsageFile(null);
    }
  });

  it("reports skippedByBudget when every candidate is spent or fails", async () => {
    const DAY = utcDayKey(Date.now());
    const spent = new Map([["groq::openai/gpt-oss-120b", { day: DAY, requests: 999, tokensIn: 0, tokensOut: 0 }]]);
    const limited = REGISTRY.filter((e) => e.provider === "groq").map((e) => ({ ...e, limits: { rpd: 100 } }));
    const fetchImpl = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    const app = makeServer(fetchImpl, {
      usageMap: spent, registry: limited,
    });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding", messages: [{ role: "user", content: "x" }] } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.skippedByBudget).toEqual(["groq::openai/gpt-oss-120b"]);
  });
});

describe("proactive pool exhaustion", () => {
  it("marks pool::<provider> exhausted when the pooled cap is spent", async () => {
    const usageMap: UsageMap = new Map();
    const stateMap = new Map();
    const registry: RegistryEntry[] = [{
      id: "or::m1", provider: "or", upstream: "m1",
      tags: ["coding"], tier: 1, speed: "fast", context: 32000, tools: true,
    }];
    const app = buildServer({
      config: CFG,
      providers: { or: { baseURL: "https://or.test/v1", auth: "bearer", quirks: "openrouter", resetProfile: { kind: "daily-utc-midnight" }, apiKey: "k" } },
      aliases: BUILT_IN_ALIASES,
      registry,
      stateMap,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 })) as unknown as typeof fetch,
      usageMap,
      providerCaps: { or: { rpd: 1 } },
    });

    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(stateMap.get("or::m1")).toMatchObject({ state: "exhausted", reason: "daily-cap" });
    expect(stateMap.get("pool::or")).toMatchObject({ state: "exhausted", reason: "pool" });
  });
});

import { bindMalformedFile, loadMalformed } from "../../src/malformed.js";
import { recordOutcome, type ReliabilityMap } from "../../src/reliability.js";

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
    expect(res.headers["x-maxout-served-by"]).toBe("p::good");
    expect(loadMalformed(path.join(dir, "malformed.jsonl"))).toEqual([
      { ts: expect.any(Number), model: "p::bad", reason: "tool_calls[0]:arguments-not-json" },
    ]);
  });

it("prose replies pass through without events", async () => {
    const fetchImpl = (async () =>
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
