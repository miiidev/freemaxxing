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

function makeServer(fetchImpl?: typeof fetch) {
  return buildServer({
    config: CFG, providers: PROV, aliases: BUILT_IN_ALIASES,
    registry: REGISTRY, stateMap: new Map(), fetchImpl,
  });
}

describe("GET /v1/models", () => {
  it("lists aliases first then registry entries", async () => {
    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data.find((m: { id: string }) => m.id === "auto/coding").freeroll_alias).toBe(true);
    expect(body.data.some((m: { id: string }) => m.id === "groq::llama-3.3-70b-versatile")).toBe(true);
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
    expect(res.headers["x-freeroll-served-by"]).toMatch(/^groq::/);
  });

  it("defaults missing model to auto/coding", async () => {
    let seenModel: string | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seenModel = String(JSON.parse(String(init?.body)).model);
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
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
    expect(groqAttempt.reason).toBe("rate");
  });
});