import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildServer } from "../../src/server.js";
import { bindTraceFile, loadTraces } from "../../src/trace.js";
import type { AppConfig, ActiveProvider } from "../../src/config.js";
import type { ModelState } from "../../src/types.js";
import type { StateMap } from "../../src/state.js";

afterEach(() => bindTraceFile(null));

const CFG: AppConfig = {
  port: 8787, host: "127.0.0.1", aliases: {},
  providers: { groq: { apiKeyEnv: "GROQ_API_KEY" } },
  annotateResponses: false, harvest: true,
};
const PROV: Record<string, ActiveProvider> = {
  groq: { baseURL: "https://groq.test/v1", auth: "bearer", quirks: "groq",
          resetProfile: { kind: "daily-utc-midnight" }, apiKey: "sk" },
};

const SECRET = "SECRET_TOKEN_ABC_DO_NOT_LOG";

function makeServer(stateMap: StateMap) {
  const traceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-rtrace-")), "traces.json");
  bindTraceFile(traceFile);
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    // echo the caller's secret back so we can prove it never lands in traces
    const echo = String(init?.body ?? "").includes(SECRET) ? SECRET : "clean";
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: `reply:${echo}` } }],
    }), { status: 200 });
  }) as unknown as typeof fetch;
  const app = buildServer({
    config: CFG, providers: PROV,
    aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
    registry: [
      { id: "groq::cooled", provider: "groq", upstream: "u-cooled", tags: ["coding", "chat"], tier: 1, speed: "fast", context: 128000, maxOutput: 8192, tools: true },
      { id: "groq::winner", provider: "groq", upstream: "u-winner", tags: ["coding", "chat"], tier: 2, speed: "fast", context: 128000, maxOutput: 8192, tools: true },
    ],
    stateMap,
    fetchImpl,
  });
  return { app, traceFile };
}

describe("routing traces", () => {
  it("matches the actual routing decision, skip reasons included", async () => {
    const stateMap: StateMap = new Map([
      ["groq::cooled", { state: "cooldown", until: Date.now() + 60_000, reason: "peak-throttle" }],
    ]);
    const { app, traceFile } = makeServer(stateMap);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding", messages: [{ role: "user", content: SECRET }] },
    });
    expect(res.statusCode).toBe(200);
    const rid = res.headers["x-maxout-request-id"];
    expect(typeof rid).toBe("string");

    const records = loadTraces(traceFile);
    expect(records).toHaveLength(1);
    const t = records[0];
    expect(t.requestId).toBe(rid);
    expect(t.picked).toBe("groq::winner");
    expect(t.servedBy).toBe("groq::winner");
    const byId = Object.fromEntries(t.considered.map((c) => [c.id, c.excludedBy]));
    expect(byId["groq::cooled"]).toBe("cooldown");
    expect(byId["groq::winner"]).toBeUndefined();
    expect(t.attempts.some((a) => a.model === "groq::winner")).toBe(true);
  });

  it("never records prompt or response content", async () => {
    const { app, traceFile } = makeServer(new Map());
    await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding", messages: [{ role: "user", content: SECRET }] },
    });
    const raw = fs.readFileSync(traceFile, "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("reply:"); // response-derived text stays out too
  });

  it("logs exhaustion decisions with pickedReason=all-exhausted", async () => {
    const traceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-rtrace-")), "traces.json");
    bindTraceFile(traceFile);
    const app = buildServer({
      config: CFG, providers: PROV,
      aliases: { "auto/coding": { tags: ["coding"], requireTools: true }, "auto/fast": { preferSpeed: true }, "auto/any": {} },
      registry: [
        { id: "groq::only", provider: "groq", upstream: "u", tags: ["coding"], tier: 1, speed: "fast", context: 128000, maxOutput: 8192, tools: true },
      ],
      stateMap: new Map(),
      fetchImpl: (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch,
    });
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "auto/coding", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(503);
    const t = loadTraces(traceFile)[0];
    expect(t.picked).toBeUndefined();
    expect(t.pickedReason).toBe("all-exhausted");
    expect(t.attempts.length).toBeGreaterThan(0);
  });
});