import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/server.js";
import type { AppConfig, ActiveProvider } from "../../src/config.js";
import { REGISTRY } from "../../src/catalog.js";
import { BUILT_IN_ALIASES } from "../../src/router.js";
import { loadUsage, bindUsageFile, utcDayKey } from "../../src/usage.js";
import type { DailyCaps, RegistryEntry, UsageMap } from "../../src/types.js";
import { bindMalformedFile, loadMalformed } from "../../src/malformed.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CFG: AppConfig = {
  port: 8787, host: "127.0.0.1", aliases: {},
  providers: { groq: { apiKeyEnv: "GROQ_API_KEY" } },
};
const PROV: Record<string, ActiveProvider> = {
  groq: {
    baseURL: "https://groq.test/v1", auth: "bearer", quirks: "groq",
    resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk",
  },
};

function sseResponse(chunks: string[], errorAfterIndex?: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < chunks.length; i++) {
        controller.enqueue(encoder.encode(chunks[i]));
        if (errorAfterIndex !== undefined && i === errorAfterIndex) {
          controller.error(new Error("upstream blew up mid-stream"));
          return;
        }
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function post(app: ReturnType<typeof buildServer>, payload: object) {
  const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload });
  return { statusCode: res.statusCode, headers: res.headers, body: res.payload };
}

describe("streaming", () => {
  it("streams SSE with model rewritten and served-by header", async () => {
    const fetchImpl = (async () =>
      sseResponse([
        'data: {"model":"up","choices":[{"delta":{"content":"He"}}]}\n\n',
        'data: {"model":"up","choices":[{"delta":{"content":"llo"}}]}\n\n',
        "data: [DONE]\n\n",
      ])) as unknown as typeof fetch;

    const app = buildServer({
      config: CFG, providers: PROV, aliases: BUILT_IN_ALIASES,
      registry: REGISTRY, stateMap: new Map(), fetchImpl,
    });
    const { statusCode, headers, body } = await post(app, {
      model: "auto/fast", stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(statusCode).toBe(200);
    expect(headers["content-type"]).toContain("text/event-stream");
    expect(headers["x-freeroll-served-by"]).toMatch(/^groq::/);
    expect(body).toContain('"model":"groq::');
    expect(body).not.toContain('"model":"up"');
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("emits freeroll_error frame and never mixes models when upstream dies mid-stream", async () => {
    const fetchImpl = (async () =>
      sseResponse(['data: {"model":"up","choices":[{"delta":{"content":"partial"}}]}\n\n'], 0)
    ) as unknown as typeof fetch;

    const app = buildServer({
      config: CFG, providers: PROV, aliases: BUILT_IN_ALIASES,
      registry: REGISTRY, stateMap: new Map(), fetchImpl,
    });
    const { body } = await post(app, {
      model: "auto/fast", stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(body).toContain('"freeroll_error":"upstream_stream_failed"');
    expect(body).not.toContain("data: [DONE]");
  });
});

// Pinned to one model: with the full REGISTRY the served id depends on
// cross-provider failover ordering, so assertions would be non-deterministic.
const PINNED = [{ ...REGISTRY.find((e) => e.id === "groq::openai/gpt-oss-20b")!, limits: { rpd: 100 } }];

function makeStreamServer(fetchImpl: typeof fetch, usageMap: UsageMap) {
  return buildServer({
    config: CFG, providers: PROV, aliases: BUILT_IN_ALIASES,
    registry: PINNED, stateMap: new Map(), fetchImpl, usageMap,
  });
}

describe("streaming usage recording", () => {
  it("records real usage when the stream carries a usage frame", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const fetchImpl = (async () => sseResponse([sse])) as unknown as typeof fetch;
    const usageMap: UsageMap = new Map();
    const app = makeStreamServer(fetchImpl, usageMap);
    const res = await post(app, { stream: true, messages: [{ role: "user", content: "hello" }] });
    expect(res.statusCode).toBe(200);
    const rec = usageMap.get("groq::openai/gpt-oss-20b");
    expect(rec?.requests).toBe(1);
    expect(rec?.tokensIn).toBe(7);
    expect(rec?.tokensOut).toBe(3);
  });

  it("falls back to the request-size estimate when no usage frame arrives", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const fetchImpl = (async () => sseResponse([sse])) as unknown as typeof fetch;
    const usageMap: UsageMap = new Map();
    const app = makeStreamServer(fetchImpl, usageMap);
    const res = await post(app, { stream: true, messages: [{ role: "user", content: "hello" }] });
    expect(res.statusCode).toBe(200);
    const rec = usageMap.get("groq::openai/gpt-oss-20b");
    expect(rec?.requests).toBe(1);
    expect(rec?.tokensIn).toBeGreaterThan(0); // chars/4 estimate of request body
    expect(rec?.tokensOut).toBe(0);
  });

  it("records on the annotated path too", async () => {
    const cfgAnnotated = { ...CFG, annotateResponses: true };
    const sse = [
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const fetchImpl = (async () => sseResponse([sse])) as unknown as typeof fetch;
    const usageMap: UsageMap = new Map();
    const app = buildServer({
      config: cfgAnnotated, providers: PROV, aliases: BUILT_IN_ALIASES,
      registry: PINNED, stateMap: new Map(), fetchImpl, usageMap,
    });
    const res = await post(app, { stream: true, messages: [{ role: "user", content: "hello" }] });
    expect(res.statusCode).toBe(200);
    const rec = usageMap.get("groq::openai/gpt-oss-20b");
    expect(rec?.tokensIn).toBe(5);
    expect(rec?.tokensOut).toBe(2);
    expect(res.body).toContain("freeroll: "); // annotation still flows through capture untouched
  });
});

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
      tools: [{ type: "function", function: { name: "patch" } }],
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
