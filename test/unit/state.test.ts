import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  effective, applyFailure, loadState, saveState,
  nextUtcMidnight, recordFailure, bindStateFile, setState,
} from "../../src/state.js";

const T0 = Date.UTC(2026, 7, 22, 12, 0, 0); // 2026-08-22T12:00:00Z
const RESET = { kind: "daily-utc-midnight" } as const;

describe("effective (lazy expiry)", () => {
  it("expires cooldown after until", () => {
    expect(effective({ state: "cooldown", until: T0 }, T0 + 1)).toEqual({ state: "ok" });
  });
  it("keeps cooldown before until", () => {
    expect(effective({ state: "cooldown", until: T0 }, T0 - 1))
      .toEqual({ state: "cooldown", until: T0 });
  });
  it("expires exhausted at until", () => {
    expect(effective({ state: "exhausted", until: T0 }, T0)).toEqual({ state: "ok" });
  });
});

describe("applyFailure", () => {
  it("rate -> cooldown honoring retryAfterMs", () => {
    expect(applyFailure({ state: "ok" }, { kind: "rate", retryAfterMs: 5000 }, RESET, T0))
      .toEqual({ state: "cooldown", until: T0 + 5000, reason: "peak-throttle" });
  });
  it("rate -> cooldown default 60s without retryAfterMs", () => {
    expect(applyFailure({ state: "ok" }, { kind: "rate" }, RESET, T0))
      .toEqual({ state: "cooldown", until: T0 + 60_000, reason: "peak-throttle" });
  });
  it("quota -> exhausted at next UTC midnight", () => {
    const ms = applyFailure({ state: "ok" }, { kind: "quota" }, RESET, T0);
    expect(ms.until).toBe(nextUtcMidnight(T0));
  });
  it("quota -> daily-cap reason", () => {
    expect(applyFailure({ state: "ok" }, { kind: "quota" }, RESET, T0).reason).toBe("daily-cap");
  });
  it("outage -> cooldown default", () => {
    expect(applyFailure({ state: "ok" }, { kind: "outage" }, RESET, T0))
      .toEqual({ state: "cooldown", until: T0 + 60_000, reason: "transient" });
  });
});

describe("nextUtcMidnight", () => {
  it("returns next midnight UTC", () => {
    expect(nextUtcMidnight(T0)).toBe(Date.UTC(2026, 7, 23, 0, 0, 0, 0));
  });
});

describe("persistence", () => {
  beforeEach(() => bindStateFile(null));

  function tmpfile(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "maxout-test-")), "state.json");
  }

  it("roundtrips through disk, dropping expired entries", () => {
    const file = tmpfile();
    const map = new Map(Object.entries({
      "a::m": { state: "cooldown", until: T0 + 60_000 },
      "b::m": { state: "exhausted", until: T0 - 1 },
    }));
    saveState(file, map);
    const loaded = loadState(file, T0);
    expect([...loaded.keys()]).toEqual(["a::m"]);
  });

  it("tolerates corrupt snapshots", () => {
    const file = tmpfile();
    fs.writeFileSync(file, "{not json");
    expect(loadState(file).size).toBe(0);
  });

  it("recordFailure persists when bound", () => {
    const file = tmpfile();
    bindStateFile(file);
    const map = new Map();
    recordFailure(map, "groq::x", { kind: "quota" }, RESET, T0);
    expect(loadState(file, T0).get("groq::x")?.state).toBe("exhausted");
  });

  it("setState persists when bound", () => {
    const file = tmpfile();
    bindStateFile(file);
    const map = new Map();
    setState(map, "groq::x", { state: "exhausted", until: nextUtcMidnight(T0) });
    expect(loadState(file, T0).get("groq::x")?.until).toBe(nextUtcMidnight(T0));
  });
});
