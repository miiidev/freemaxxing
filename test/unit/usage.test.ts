import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  utcDayKey, freshRecord, loadUsage, saveUsage, bindUsageFile,
  recordUsage, aggregateProvider, fitsBudget, maybeExhaust, usedFraction,
  type BudgetView, type UsageMap,
} from "../../src/usage.js";
import type { DailyCaps } from "../../src/types.js";
import { effective } from "../../src/state.js";

const T0 = Date.UTC(2026, 7, 23, 10, 0, 0);
const NEXT_DAY = Date.UTC(2026, 7, 24, 0, 0, 1);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maxout-usage-"));
  bindUsageFile(null);
});

describe("utcDayKey", () => {
  it("formats UTC YYYY-MM-DD", () => {
    expect(utcDayKey(T0)).toBe("2026-08-23");
  });
});

describe("freshRecord", () => {
  it("zeroes counters for a day", () => {
    expect(freshRecord("2026-08-23")).toEqual({ day: "2026-08-23", requests: 0, tokensIn: 0, tokensOut: 0 });
  });
});

describe("recordUsage", () => {
  it("accumulates deltas under the model id", () => {
    const map: UsageMap = new Map();
    recordUsage(map, "a::m", { requests: 1, tokensIn: 100 }, T0);
    recordUsage(map, "a::m", { requests: 1, tokensIn: 50, tokensOut: 20 }, T0);
    expect(map.get("a::m")).toEqual({ day: "2026-08-23", requests: 2, tokensIn: 150, tokensOut: 20, reqTs: [T0, T0] });
  });

  it("lazily rolls over on a new UTC day instead of accumulating", () => {
    const map: UsageMap = new Map();
    recordUsage(map, "a::m", { requests: 5, tokensIn: 9999 }, T0);
    recordUsage(map, "a::m", { requests: 1 }, NEXT_DAY);
    expect(map.get("a::m")).toEqual({ day: "2026-08-24", requests: 1, tokensIn: 0, tokensOut: 0, reqTs: [NEXT_DAY] });
  });

  it("persists through bindUsageFile and reloads", () => {
    const file = path.join(dir, "nested", "usage.json");
    bindUsageFile(file);
    const map: UsageMap = new Map();
    recordUsage(map, "a::m", { requests: 3, tokensIn: 10, tokensOut: 4 }, T0);
    expect(fs.existsSync(file)).toBe(true);
    expect(loadUsage(file, T0).get("a::m")).toEqual({ day: "2026-08-23", requests: 3, tokensIn: 10, tokensOut: 4, reqTs: [T0] });
  });
});

describe("loadUsage", () => {
  it("returns empty map when file missing", () => {
    expect(loadUsage(path.join(dir, "nope.json"), T0).size).toBe(0);
  });

  it("drops stale-day records on load", () => {
    const file = path.join(dir, "usage.json");
    saveUsage(file, new Map([["a::m", { day: "2026-08-22", requests: 9, tokensIn: 9, tokensOut: 9 }]]));
    expect(loadUsage(file, T0).has("a::m")).toBe(false);
  });

  it("starts fresh on corrupt JSON", () => {
    const file = path.join(dir, "usage.json");
    fs.writeFileSync(file, "{not json");
    expect(loadUsage(file, T0).size).toBe(0);
  });

  it("ignores malformed records instead of throwing", () => {
    const file = path.join(dir, "usage.json");
    fs.writeFileSync(file, JSON.stringify({ "a::m": { day: "2026-08-23" }, "b::n": 5 }));
    const map = loadUsage(file, T0);
    expect(map.size).toBe(0);
  });
});

describe("aggregateProvider", () => {
  it("sums usage across all models of one provider only", () => {
    const map: UsageMap = new Map([
      ["groq::a", { day: "2026-08-23", requests: 2, tokensIn: 100, tokensOut: 10 }],
      ["groq::b", { day: "2026-08-23", requests: 3, tokensIn: 50, tokensOut: 5 }],
      ["openrouter::c", { day: "2026-08-23", requests: 100, tokensIn: 9999, tokensOut: 99 }],
    ]);
    expect(aggregateProvider(map, "groq")).toEqual({ requests: 5, tokensIn: 150, tokensOut: 15 });
  });
});

const CAPS_BOTH: DailyCaps = { rpd: 100, tpd: 1000 };

describe("usedFraction", () => {
  it("is 0 without caps or records", () => {
    expect(usedFraction({}, T0)).toBe(0);
    expect(usedFraction({ modelCaps: CAPS_BOTH }, T0)).toBe(0);
  });

  it("takes the max over seeded dimensions", () => {
    const view: BudgetView = {
      rec: { day: "2026-08-23", requests: 50, tokensIn: 900, tokensOut: 0 },
      modelCaps: CAPS_BOTH,
    };
    expect(usedFraction(view, T0)).toBe(0.9); // tokens dominate over 50% requests
  });

  it("max of model-only and provider-pool fractions", () => {
    const view: BudgetView = {
      rec: { day: "2026-08-23", requests: 10, tokensIn: 0, tokensOut: 0 },
      provTotals: { requests: 40, tokensIn: 0, tokensOut: 0 },
      provCaps: { rpd: 100 },
    };
    expect(usedFraction(view, T0)).toBeCloseTo(0.4); // pool dominates model-only 0.1
  });
});

describe("fitsBudget", () => {
  it("true when no caps at any level", () => {
    expect(fitsBudget({}, 5000, T0)).toBe(true);
  });

  it("false when remaining rpd < 1", () => {
    const view: BudgetView = {
      rec: { day: "2026-08-23", requests: 50, tokensIn: 0, tokensOut: 0 },
      modelCaps: { rpd: 50 },
    };
    expect(fitsBudget(view, 1, T0)).toBe(false);
  });

  it("false when remaining tpd < estimated tokens", () => {
    const view: BudgetView = {
      rec: { day: "2026-08-23", requests: 0, tokensIn: 990, tokensOut: 0 },
      modelCaps: CAPS_BOTH,
    };
    expect(fitsBudget(view, 11, T0)).toBe(false);
    expect(fitsBudget(view, 10, T0)).toBe(true);
  });

  it("respects provider pool even when model has headroom", () => {
    const view: BudgetView = {
      rec: { day: "2026-08-23", requests: 0, tokensIn: 0, tokensOut: 0 },
      provTotals: { requests: 50, tokensIn: 0, tokensOut: 0 },
      provCaps: { rpd: 50 },
    };
    expect(fitsBudget(view, 1, T0)).toBe(false);
  });
});

describe("maybeExhaust", () => {
  it("marks exhausted until UTC midnight when fully spent", () => {
    const states = new Map();
    maybeExhaust(states, "a::m", {
      rec: { day: "2026-08-23", requests: 50, tokensIn: 0, tokensOut: 0 },
      modelCaps: { rpd: 50 },
    }, T0);
    const ms = states.get("a::m");
    expect(ms.state).toBe("exhausted");
    expect(ms.until).toBe(Date.UTC(2026, 7, 24, 0, 0, 0));
  });

  it("leaves state alone when budget remains", () => {
    const states = new Map();
    maybeExhaust(states, "a::m", { modelCaps: { rpd: 50 } }, T0);
    expect(states.has("a::m")).toBe(false);
  });
});

describe("effective interplay", () => {
  it("treats exhausted state after rollover time as ok", () => {
    expect(effective({ state: "exhausted", until: NEXT_DAY - 1 }, NEXT_DAY)).toEqual({ state: "ok" });
  });
});