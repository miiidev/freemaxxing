import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/server.js";
import type { AppConfig, ActiveProvider } from "../../src/config.js";
import { REGISTRY } from "../../src/catalog.js";
import { BUILT_IN_ALIASES } from "../../src/router.js";

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
