import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_RELIABILITY, bindReliabilityFile, loadReliability,
  recordOutcome, saveReliability, pruneEvents, stats, isDemoted,
  type ReliabilityMap, type ReliabilityConfig, type OutcomeEvent,
} from "../../src/reliability.js";
import { loadConfig, defaultReliabilityPath } from "../../src/config.js";

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const CFG: ReliabilityConfig = { windowSize: 3, minSamples: 2, demoteBelow: 0.85 };
const ev = (over: Partial<OutcomeEvent>): OutcomeEvent => ({ ts: T0, ok: true, ...over });

describe("pruneEvents", () => {
  it("keeps only the newest windowSize events", () => {
    const events = [
      ev({ ts: T0 }), ev({ ts: T0 + 1 }), ev({ ts: T0 + 2 }), ev({ ts: T0 + 3 }),
    ];
    expect(pruneEvents(events, CFG, T0 + 4)).toEqual([
      ev({ ts: T0 + 1 }), ev({ ts: T0 + 2 }), ev({ ts: T0 + 3 }),
    ]);
  });

  it("drops events older than 7 days even when window not full", () => {
    const events = [ev({ ts: T0 - 8 * DAY }), ev({ ts: T0 - DAY })];
    expect(pruneEvents(events, DEFAULT_RELIABILITY, T0)).toEqual([ev({ ts: T0 - DAY })]);
  });
});

describe("recordOutcome", () => {
  let map: ReliabilityMap;
  beforeEach(() => {
    map = new Map();
    bindReliabilityFile(null);
  });

  it("appends under the model id and prunes", () => {
    recordOutcome(map, "m::a", ev({}), CFG, T0);
    recordOutcome(map, "m::a", ev({ ts: T0 + 1, ok: false }), CFG, T0 + 2);
    expect(map.get("m::a")).toHaveLength(2);
    for (let i = 0; i < 4; i++) recordOutcome(map, "m::a", ev({ ts: T0 + 10 + i }), CFG, T0 + 20);
    expect(map.get("m::a")).toHaveLength(CFG.windowSize);
  });

  it("persists through bindReliabilityFile and reloads", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-rel-")), "reliability.json");
    bindReliabilityFile(file);
    recordOutcome(map, "m::a", ev({ latencyMs: 120 }), DEFAULT_RELIABILITY, T0);
    expect(loadReliability(file, T0 + DAY).get("m::a")).toEqual([ev({ latencyMs: 120 })]);
  });
});

describe("stats", () => {
  it("empty events -> nulls", () => {
    expect(stats([])).toEqual({ score: null, samples: 0, avgLatencyMs: null });
  });
  it("computes success fraction and average latency over timed events", () => {
    const events = [
      ev({ ts: T0, ok: true, latencyMs: 100 }),
      ev({ ts: T0 + 1, ok: false }),
      ev({ ts: T0 + 2, ok: true, latencyMs: 300 }),
    ];
    expect(stats(events)).toEqual({ score: 2 / 3, samples: 3, avgLatencyMs: 200 });
  });
});

describe("isDemoted", () => {
  it("false under minSamples regardless of score", () => {
    expect(isDemoted({ score: 0.1, samples: CFG.minSamples - 1 }, CFG)).toBe(false);
  });
  it("true when enough samples and strictly below demoteBelow", () => {
    expect(isDemoted({ score: 0.84, samples: CFG.minSamples }, CFG)).toBe(true);
  });
  it("boundary: score exactly at demoteBelow stays undemoted", () => {
    expect(isDemoted({ score: 0.85, samples: CFG.minSamples }, CFG)).toBe(false);
  });
});

describe("persistence edge cases", () => {
  beforeEach(() => bindReliabilityFile(null));

  it("corrupt file loads empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-rel2-"));
    fs.writeFileSync(path.join(dir, "reliability.json"), "{nope");
    expect(loadReliability(path.join(dir, "reliability.json"), T0).size).toBe(0);
  });

  it("saveReliability writes atomically-replaced valid JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-rel3-"));
    const file = path.join(dir, "nested", "reliability.json");
    const map: ReliabilityMap = new Map([["m::a", [ev({})]]]);
    saveReliability(file, map, DEFAULT_RELIABILITY, T0);
    expect(loadReliability(file, T0 + DAY).get("m::a")).toEqual([ev({})]);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe("config reliability block", () => {
  it("defaults when absent", () => {
    const cfg = loadConfig(null);
    expect(cfg.reliability).toEqual(DEFAULT_RELIABILITY);
  });

  it("merges per-field from file with defaults for missing keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-cfg-rel-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ reliability: { demoteBelow: 0.5 } }));
    const cfg = loadConfig(file);
    expect(cfg.reliability).toEqual({ windowSize: 200, minSamples: 10, demoteBelow: 0.5 });
  });

  it("ignores invalid values instead of throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-cfg-rel2-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ reliability: { windowSize: -5, minSamples: "x" } }));
    const cfg = loadConfig(file);
    expect(cfg.reliability).toEqual(DEFAULT_RELIABILITY);
  });

  it("defaultReliabilityPath lands in ~/.freeroll", () => {
    expect(defaultReliabilityPath().replace(/\\/g, "/")).toMatch(/\.freeroll\/reliability\.json$/);
  });
});