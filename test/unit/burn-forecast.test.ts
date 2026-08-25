import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordUsage, loadUsage, saveUsage, bindUsageFile,
  utcDayStart, MAX_REQ_TS, type UsageMap,
} from "../../src/usage.js";

const DAY_START = Date.UTC(2026, 7, 25, 0, 0, 0);

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