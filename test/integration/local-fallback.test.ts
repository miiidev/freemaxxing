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
  const localCfg = { ...CFG.local, enabled: opts?.localEnabled ?? true };
  return buildServer({
    config: { ...CFG, local: localCfg },
    providers: PROV,
    aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
    registry: opts?.registry ?? [entry("groq::a", "up-a"), entry("groq::b", "up-b")],
    stateMap: opts?.stateMap ?? new Map(),
    fetchImpl,
    localCfg,
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

function recordingFetchCloudOk(hits: Array<{ url: string; model?: string }>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1:9101")) {
      hits.push({ url: u, model: init?.body ? (JSON.parse(String(init.body)) as { model: string }).model : undefined });
      if (u.endsWith("/models")) return new Response("{\"data\":[]}", { status: 200 });
      return new Response(OK_BODY, { status: 200 });
    }
    hits.push({ url: u, model: init?.body ? (JSON.parse(String(init.body)) as { model: string }).model : undefined });
    return new Response(OK_BODY, { status: 200 });
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
    const app = makeServer(recordingFetchCloudOk(hits));
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