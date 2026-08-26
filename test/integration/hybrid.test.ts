import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/server.js";
import { DEFAULT_HYBRID, type AppConfig, type ActiveProvider } from "../../src/config.js";
import type { SpendStore } from "../../src/spend.js";
import type { StateMap } from "../../src/state.js";

const PAID_UPSTREAM = "deepseek/deepseek-chat-v3.1";
const PAID_ID = `openrouter::${PAID_UPSTREAM}`;

const EXH = { state: "exhausted" as const, until: Number.MAX_SAFE_INTEGER };

function baseCfg(hybridEnabled: boolean): AppConfig {
  return {
    port: 8787, host: "127.0.0.1", aliases: {},
    providers: { groq: { apiKeyEnv: "GROQ_API_KEY" } },
    annotateResponses: false, harvest: true,
    hybrid: { ...DEFAULT_HYBRID, enabled: hybridEnabled },
  };
}

const PROV: Record<string, ActiveProvider> = {
  groq: { baseURL: "https://groq.test/v1", auth: "bearer", quirks: "groq",
          resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk-g" },
  openrouter: { baseURL: "https://or.test/api/v1", auth: "bearer", quirks: "openrouter",
                resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk-o" },
};

function registry(): RegistryEntryLike[] {
  return [
    { id: "groq::a", provider: "groq", upstream: "up-a", tags: ["coding"], tier: 1, speed: "fast", context: 128000, maxOutput: 8192, tools: true },
  ];
}
type RegistryEntryLike = import("../../src/types.js").RegistryEntry;

function spyStore(records: number[] = [], spent = 0): SpendStore & { records: number[] } {
  return {
    records,
    spentToday: () => spent,
    record: (usd: number) => { records.push(usd); },
  };
}

function makeServer(opts: {
  hybridEnabled: boolean;
  spend?: SpendStore;
  stateMap?: StateMap;
}) {
  const hits: Array<{ url: string }> = [];
  const fetchImpl = (async (url: string | URL) => {
    hits.push({ url: String(url) });
    const u = String(url);
    if (u.startsWith("https://or.test")) {
      if (u.includes("/models")) {
        // Model availability probe - include the paid model
        return new Response(JSON.stringify({ data: [{ id: PAID_UPSTREAM }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "paid answer" } }],
        usage: { cost: 0.07, prompt_tokens: 100, completion_tokens: 50 },
      }), { status: 200 });
    }
    return new Response("{}", { status: 429 }); // groq dead
  }) as unknown as typeof fetch;
  const app = buildServer({
    config: baseCfg(opts.hybridEnabled),
    providers: PROV,
    aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
    registry: registry(),
    stateMap: opts.stateMap ?? new Map([["groq::a", EXH], ["pool::groq", EXH]]),
    fetchImpl,
    spend: opts.spend,
  });
  return { app, hits };
}

const PAYLOAD = { model: "auto/coding", messages: [{ role: "user", content: "hello" }] };

describe("hybrid mode", () => {
  it("disabled: byte-for-byte unchanged exhaustion behavior, no spend, no paid calls", async () => {
    const off = await makeServer({ hybridEnabled: false }).app.inject({ method: "POST", url: "/v1/chat/completions", payload: PAYLOAD });
    const absent = await buildServer({
      config: { ...baseCfg(false), hybrid: undefined },
      providers: PROV,
      aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
      registry: registry(),
      stateMap: new Map([["groq::a", EXH], ["pool::groq", EXH]]),
      fetchImpl: (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch,
    }).inject({ method: "POST", url: "/v1/chat/completions", payload: PAYLOAD });
    expect(off.statusCode).toBe(503);
    expect(off.body).toBe(absent.body);
  });

  it("enabled + under cap: routes to the paid model after free fails and books reported cost", async () => {
    const records: number[] = [];
    const { app, hits } = makeServer({ hybridEnabled: true, spend: spyStore(records) });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: PAYLOAD });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-maxout-served-by"]).toBe(PAID_ID);
    expect(res.json().model).toBe(PAID_ID);
    expect(hits.some((h) => h.url.startsWith("https://or.test"))).toBe(true);
    expect(records).toEqual([0.07]);
  });

  it("cap reached: hard stop for the rest of the day regardless of free-pool timing", async () => {
    const { app, hits } = makeServer({ hybridEnabled: true, spend: spyStore([], 2.0) });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: PAYLOAD });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.type).toBe("all_models_exhausted");
    expect(hits.some((h) => h.url.startsWith("https://or.test"))).toBe(false);
  });

  it("healthy free capacity is never displaced by paid candidates", async () => {
    const records: number[] = [];
    const hits: Array<{ url: string }> = [];
    const app = buildServer({
      config: baseCfg(true),
      providers: PROV,
      aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
      registry: registry(),
      stateMap: new Map(),
      fetchImpl: (async (url: string | URL) => {
        hits.push({ url: String(url) });
        if (String(url).startsWith("https://groq.test")) {
          return new Response(JSON.stringify({
            choices: [{ message: { role: "assistant", content: "free answer" } }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "paid answer" } }],
          usage: { cost: 0.07, prompt_tokens: 100, completion_tokens: 50 },
        }), { status: 200 });
      }) as unknown as typeof fetch,
      spend: spyStore(records),
    });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: PAYLOAD });
    expect(String(res.headers["x-maxout-served-by"])).toBe("groq::a");
    expect(records).toEqual([]);
    expect(hits.every((h) => !h.url.startsWith("https://or.test"))).toBe(true);
  });

  it("streaming paid answers book captured-token cost", async () => {
    const records: number[] = [];
    const store = spyStore(records);
    const hits: Array<{ url: string }> = [];
    const app = buildServer({
      config: baseCfg(true),
      providers: PROV,
      aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
      registry: registry(),
      stateMap: new Map([["groq::a", EXH], ["pool::groq", EXH]]),
      fetchImpl: (async (url: string | URL) => {
        hits.push({ url: String(url) });
        if (String(url).startsWith("https://or.test")) {
          const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
          const body = [
            frame({ choices: [{ delta: { content: "hi" } }] }),
            frame({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } }),
            "data: [DONE]\n\n",
          ].join("");
          return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        return new Response("{}", { status: 429 });
      }) as unknown as typeof fetch,
      spend: store,
    });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { ...PAYLOAD, stream: true } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-maxout-served-by"]).toBe(PAID_ID);
    // wait one macrotask for the pipe chain to flush before asserting
    await new Promise((r) => setTimeout(r, 25));
    expect(store.records.length).toBe(1);
    expect(store.records[0]).toBeCloseTo((1000 / 1e6) * DEFAULT_HYBRID.priceInPerMTok + (100 / 1e6) * DEFAULT_HYBRID.priceOutPerMTok, 8);
  });
});