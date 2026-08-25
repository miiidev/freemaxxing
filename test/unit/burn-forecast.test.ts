import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordUsage, loadUsage, saveUsage, bindUsageFile,
  utcDayStart, MAX_REQ_TS, type UsageMap,
  projectExhaustion, aggregateProvider, MIN_FORECAST_SAMPLES,
} from "../../src/usage.js";
import { formatPoolLine } from "../../src/cli.js";
import type { DailyCaps } from "../../src/types.js";

const DAY_START = Date.UTC(2026, 7, 25, 0, 0, 0);

const CAPS: DailyCaps = { rpd: 50 };
const T10 = Date.UTC(2026, 7, 25, 10, 0, 0); // 600 minutes into the day

function seeded(requests: number, lastAtMin = 9 * 60): UsageMap {
  const map: UsageMap = new Map();
  const firstModelRequests = Math.min(requests, 3);
  const secondModelRequests = requests - firstModelRequests;
  map.set("groq::a", {
    day: "2026-08-25", requests: firstModelRequests, tokensIn: 0, tokensOut: 0,
    reqTs: Array.from({ length: firstModelRequests }, (_, i) => DAY_START + (i + 1) * 60_000),
  });
  if (secondModelRequests > 0) {
    map.set("groq::b", {
      day: "2026-08-25", requests: secondModelRequests, tokensIn: 0, tokensOut: 0,
    });
  }
  return map;
}

describe("utcDayStart", () => {
  it("snaps to UTC midnight", () => {
    expect(utcDayStart(Date.UTC(2026, 7, 25, 10, 30, 15))).toBe(DAY_START);
    expect(utcDayStart(DAY_START)).toBe(DAY_START);
  });
});

describe("request timestamp retention", () => {
  it("appends one timestamp per counted request", () => {
    const map: UsageMap = new Map();
    recordUsage(map, "groq::a", { requests: 1 }, DAY_START + 60_000);
    recordUsage(map, "groq::a", { tokensIn: 10 }, DAY_START + 90_000); // no request -> no ts
    expect(map.get("groq::a")?.reqTs).toEqual([DAY_START + 60_000]);
  });

  it("keeps only the newest MAX_REQ_TS entries", () => {
    const map: UsageMap = new Map();
    for (let i = 1; i <= MAX_REQ_TS + 5; i++) {
      recordUsage(map, "groq::a", { requests: 1 }, DAY_START + i * 1000);
    }
    const ts = map.get("groq::a")?.reqTs ?? [];
    expect(ts).toHaveLength(MAX_REQ_TS);
    expect(ts[ts.length - 1]).toBe(DAY_START + (MAX_REQ_TS + 5) * 1000);
  });

  it("survives a persist/reload round-trip", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-burn-")), "usage.json");
    bindUsageFile(file);
    const map: UsageMap = new Map();
    recordUsage(map, "groq::a", { requests: 2 }, DAY_START + 1000);
    recordUsage(map, "groq::a", { requests: 1 }, DAY_START + 2000);
    bindUsageFile(null);
    const reloaded = loadUsage(file, DAY_START + 3000);
    expect(reloaded.get("groq::a")?.reqTs).toEqual([DAY_START + 1000, DAY_START + 2000]);
  });

  it("sanitizes corrupt persisted timestamps", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-burn-")), "usage.json");
    fs.writeFileSync(file, JSON.stringify({
      "groq::a": { day: "2026-08-25", requests: 2, tokensIn: 0, tokensOut: 0, reqTs: [DAY_START, "oops", null, 42] },
      "groq::b": { day: "2026-08-25", requests: 1, tokensIn: 0, tokensOut: 0, reqTs: "junk" },
    }));
    const map = loadUsage(file, DAY_START + 5000);
    expect(map.get("groq::a")?.reqTs).toEqual([DAY_START, 42]);
    expect(map.get("groq::b")?.reqTs).toBeUndefined();
  });
});

describe("projectExhaustion", () => {
  it("matches manual linear extrapolation exactly on a clean fixture", () => {
    // 30 requests by 10:00 UTC at 50/day: rate 30/600min, remaining 20 -> 400min -> 16:40
    const f = projectExhaustion("groq", CAPS, seeded(30), T10);
    expect(f?.projectedAt).toBe(Date.UTC(2026, 7, 25, 16, 40));
  });

  it("suppresses below the minimum sample threshold", () => {
    const f = projectExhaustion("groq", CAPS, seeded(MIN_FORECAST_SAMPLES - 1), T10);
    expect(f).toBeNull();
  });

  it("suppresses when too little of the day has elapsed", () => {
    const f = projectExhaustion("groq", CAPS, seeded(6), DAY_START + 10 * 60_000);
    expect(f).toBeNull();
  });

  it("returns null for pools without an rpd cap", () => {
    expect(projectExhaustion("cerebras", { tpd: 1_000_000 }, seeded(30), T10)).toBeNull();
    expect(projectExhaustion("mystery", undefined, seeded(30), T10)).toBeNull();
  });

  it("returns null once the pool is already exhausted", () => {
    expect(projectExhaustion("groq", CAPS, seeded(50), T10)).toBeNull();
  });
});

describe("pool-line forecast fragment", () => {
  const totals = { requests: 32, tokensIn: 0, tokensOut: 0 };

  it("appends the projection time when a forecast exists", () => {
    const line = formatPoolLine("openrouter", CAPS, totals, { state: "ok" }, 12, T10, { projectedAt: Date.UTC(2026, 7, 25, 15, 40) });
    expect(line).toContain("projected exhaustion ~15:40 UTC");
  });

  it("stays byte-identical to the old format without a forecast", () => {
    const args = ["openrouter", CAPS, totals, { state: "ok" }, 12, T10] as const;
    expect(formatPoolLine(...args, null)).toBe(formatPoolLine(...args));
    expect(formatPoolLine(...args)).not.toContain("projected");
  });
});