import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import type { AppConfig, ActiveProvider } from "../../src/config.js";
import type { RegistryEntry } from "../../src/types.js";

const CFG: AppConfig = {
  port: 8787, host: "127.0.0.1", aliases: {},
  providers: { groq: { apiKeyEnv: "GROQ_API_KEY" } },
  annotateResponses: false, harvest: true,
};
const PROV: Record<string, ActiveProvider> = {
  groq: { baseURL: "https://groq.test/v1", auth: "bearer", quirks: "groq",
          resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk" },
};

function tiny(id: string, upstream: string): RegistryEntry {
  return { id, provider: "groq", upstream, tags: ["coding", "chat"], tier: 1, speed: "fast", context: 2048, maxOutput: 512, tools: true };
}

const OK_BODY = JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] });

function makeServer(registry: RegistryEntry[]) {
  return buildServer({
    config: CFG, providers: PROV,
    aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
    registry,
    stateMap: new Map(),
    fetchImpl: (async () => new Response(OK_BODY, { status: 200 })) as unknown as typeof fetch,
  });
}

describe("widen-back serving", () => {
  it("warns once and serves a truncated-capable model instead of 503", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeServer([tiny("groq::small-a", "up-a"), tiny("groq::small-b", "up-b")]);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/fast", messages: [{ role: "user", content: "x".repeat(40_000) }] },
    });
    expect(res.statusCode).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("widened context filter");
    warn.mockRestore();
  });

  it("stays silent when candidates fit normally", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeServer([tiny("groq::small-a", "up-a")]);
    await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/fast", messages: [{ role: "user", content: "hi" }] },
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});