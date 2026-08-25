import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExportSnapshot } from "../../src/cli.js";
import { loadConfig, type AppConfig, type ActiveProvider } from "../../src/config.js";
import type { ReliabilityMap } from "../../src/reliability.js";
import { buildServer } from "../../src/server.js";
import { BUILT_IN_ALIASES } from "../../src/router.js";
import { bindMalformedFile } from "../../src/malformed.js";

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);

describe("buildExportSnapshot", () => {
  it("allowlists fields and skips zero-sample models", () => {
    const map: ReliabilityMap = new Map([
      ["a::good", [
        { ts: NOW, ok: true, latencyMs: 100 },
        { ts: NOW + 1, ok: true, latencyMs: 300 },
        { ts: NOW + 2, ok: false },
      ]],
      ["b::empty", []],
    ]);
    const snap = buildExportSnapshot(loadConfig(null), [{ id: "a::good" }, { id: "b::empty" }, { id: "c::unseen" }], map, NOW);
    expect(snap.generatedAt).toBe(new Date(NOW).toISOString());
    expect(snap.models).toHaveLength(1);
    expect(Object.keys(snap.models[0]).sort()).toEqual(["avgLatencyMs", "id", "samples", "score"]);
    expect(snap.models[0]).toEqual({ id: "a::good", score: 2 / 3, samples: 3, avgLatencyMs: 200 });
  });

  it("carries the effective window config for consumers", () => {
    const snap = buildExportSnapshot(loadConfig(null), [], new Map(), NOW);
    expect(snap.window).toEqual(loadConfig(null).reliability);
  });
});

const SENTINEL_PROMPT = "SECRET_SENTINEL_PROMPT_42";
const SENTINEL_PATH = "C:/users/me/SECRET_FILE.txt";
const SENTINEL_KEY = "sk-SENTINEL-API-KEY";

describe("export privacy (pipeline leak test)", () => {
  it("prompt content, paths, and keys never reach the snapshot", async () => {
    const PROV: Record<string, ActiveProvider> = {
      p: { baseURL: "https://p.test/v1", auth: "bearer", quirks: "groq",
           resetProfile: { kind: "daily-utc-midnight" }, apiKey: SENTINEL_KEY },
    };
    const registry = [{
      id: "p::flaky", provider: "p", upstream: "flaky",
      tags: ["coding"], tier: 1, speed: "fast", context: 32000, tools: true,
    }];
    const fetchImpl = (async () =>
      new Response(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [{ function: { name: "patch", arguments: '{"path":' } }] },
        }],
      }), { status: 200 })) as unknown as typeof fetch;

    const relMap: ReliabilityMap = new Map();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-privacy-"));
    bindMalformedFile(path.join(dir, "m.jsonl"));
    const app = buildServer({
      config: { ...loadConfig(null), providers: { p: { apiKeyEnv: "P_KEY" } } } as AppConfig,
      providers: PROV,
      aliases: BUILT_IN_ALIASES,
      registry,
      stateMap: new Map(),
      fetchImpl,
      reliabilityMap: relMap,
    });
    await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: {
        model: "auto/coding",
        messages: [{ role: "user", content: `fix ${SENTINEL_PROMPT} in ${SENTINEL_PATH}` }],
        tools: [{ type: "function", function: { name: "patch" } }],
      },
    });
    bindMalformedFile(null);

    const snapshot = JSON.stringify(buildExportSnapshot(loadConfig(null), registry, relMap, Date.now()));
    expect(snapshot).not.toContain(SENTINEL_PROMPT);
    expect(snapshot).not.toContain(SENTINEL_PATH);
    expect(snapshot).not.toContain(SENTINEL_KEY);

    const malformedRaw = fs.readFileSync(path.join(dir, "m.jsonl"), "utf8");
    expect(malformedRaw).not.toContain(SENTINEL_PROMPT);
    expect(malformedRaw).not.toContain(SENTINEL_PATH);
  });
});