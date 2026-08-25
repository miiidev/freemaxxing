import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExportSnapshot } from "../../src/cli.js";
import { loadConfig } from "../../src/config.js";
import type { ReliabilityMap } from "../../src/reliability.js";

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