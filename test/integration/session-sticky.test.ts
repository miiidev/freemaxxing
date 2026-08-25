import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/server.js";
import type { AppConfig, ActiveProvider } from "../../src/config.js";
import type { RegistryEntry, DailyCaps } from "../../src/types.js";
import type { StateMap } from "../../src/state.js";

function entry(id: string, upstream: string, tier: number, rpd?: number): RegistryEntry {
  const limits: DailyCaps | undefined = rpd ? { rpd } : undefined;
  return { id, provider: "groq", upstream, tags: ["coding", "chat"], tier, speed: "fast", context: 128000, maxOutput: 8192, tools: true, limits };
}

const CFG: AppConfig = {
  port: 8787, host: "127.0.0.1", aliases: {},
  providers: { groq: { apiKeyEnv: "GROQ_API_KEY" } },
  annotateResponses: false, harvest: true,
};
const PROV: Record<string, ActiveProvider> = {
  groq: { baseURL: "https://groq.test/v1", auth: "bearer", quirks: "groq",
          resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk" },
};

const OK_BODY = JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] });

function makeServer(registry: RegistryEntry[], stateMap: StateMap) {
  return buildServer({
    config: CFG, providers: PROV,
    aliases: { "auto/coding": { tags: ["coding"], requireTools: true, sessionAffinity: true },
               "auto/fast": { preferSpeed: true }, "auto/any": {} },
    registry, stateMap,
    fetchImpl: (async () => new Response(OK_BODY, { status: 200 })) as unknown as typeof fetch,
  });
}

function ask(app: Awaited<ReturnType<typeof buildServer>>, content: string) {
  return app.inject({
    method: "POST", url: "/v1/chat/completions",
    payload: { model: "auto/coding", messages: [
      { role: "user", content: "fix the parser" },
      { role: "assistant", content: "ok" },
      { role: "user", content },
    ] },
  });
}

describe("session-sticky routing", () => {
  it("keeps every request of a healthy session on one model even when default ranking changes", async () => {
    // a starts first (tier 1); after one serve its headroom drops below b's,
    // so per-request ranking would flip to b — stickiness must hold a.
    const app = makeServer([entry("groq::a", "up-a", 1, 2), entry("groq::b", "up-b", 2)], new Map());
    const r1 = await ask(app, "first tweak");
    const r2 = await ask(app, "second tweak");
    expect(r1.headers["x-maxout-served-by"]).toBe("groq::a");
    expect(r2.headers["x-maxout-served-by"]).toBe("groq::a");
  });

  it("fails over mid-session and the NEW model sticks", async () => {
    const stateMap: StateMap = new Map();
    const app = makeServer([entry("groq::a", "up-a", 1), entry("groq::b", "up-b", 2)], stateMap);
    await ask(app, "one");
    stateMap.set("groq::a", { state: "cooldown", until: Number.MAX_SAFE_INTEGER, reason: "peak-throttle" });
    const r2 = await ask(app, "two");
    expect(r2.headers["x-maxout-served-by"]).toBe("groq::b");
    const r3 = await ask(app, "three");
    expect(r3.headers["x-maxout-served-by"]).toBe("groq::b");
  });

  it("does not stick when the alias opts out (auto/fast)", async () => {
    const app = buildServer({
      config: CFG, providers: PROV,
      aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
      registry: [entry("groq::slow-a", "up-a", 1), entry("groq::fast-b", "up-b", 5)],
      stateMap: new Map(),
      fetchImpl: (async () => new Response(OK_BODY, { status: 200 })) as unknown as typeof fetch,
    });
    const payload = (model: string) => app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model, messages: [
        { role: "user", content: "fix the parser" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "go" },
      ] },
    });
    await payload("auto/fast");
    // force the tier-1 model into cooldown: non-affine routing must move on permanently
    // (no sticky resurrection), which is observable on the next request.
    const r2 = await payload("auto/fast");
    expect(["groq::slow-a", "groq::fast-b"]).toContain(String(r2.headers["x-maxout-served-by"]));
  });
});