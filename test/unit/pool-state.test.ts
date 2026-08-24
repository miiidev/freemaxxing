import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  effective, loadState, nextUtcMidnight, setState,
  bindStateFile, recordPoolExhaustion, isProviderBlocked,
  retireModel, reviveMatching, poolKey,
} from "../../src/state.js";

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);
const RESET = { kind: "daily-utc-midnight" } as const;

describe("poolKey", () => {
  it("namespaces provider entries away from model ids", () => {
    expect(poolKey("openrouter")).toBe("pool::openrouter");
  });
});

describe("recordPoolExhaustion", () => {
  it("marks the whole pool exhausted until next UTC midnight", () => {
    const map = new Map();
    recordPoolExhaustion(map, "openrouter", RESET, T0);
    expect(map.get("pool::openrouter")).toEqual({
      state: "exhausted", until: nextUtcMidnight(T0), reason: "pool",
    });
  });

  it("persists through bindStateFile", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-pool-")), "state.json");
    bindStateFile(file);
    const map = new Map();
    recordPoolExhaustion(map, "openrouter", RESET, T0);
    expect(loadState(file, T0).get("pool::openrouter")?.state).toBe("exhausted");
  });
});

describe("isProviderBlocked", () => {
  it("false when no pool entry exists", () => {
    expect(isProviderBlocked(new Map(), "openrouter", T0)).toBe(false);
  });
  it("true while exhausted", () => {
    const map = new Map();
    map.set("pool::openrouter", { state: "exhausted", until: T0 + 1000, reason: "pool" });
    expect(isProviderBlocked(map, "openrouter", T0)).toBe(true);
  });
  it("lazily expires at until", () => {
    const map = new Map();
    map.set("pool::openrouter", { state: "exhausted", until: T0, reason: "pool" });
    expect(isProviderBlocked(map, "openrouter", T0 + 1)).toBe(false);
  });
});

describe("retired models", () => {
  it("retireModel persists a since-stamped entry", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-ret-")), "state.json");
    bindStateFile(file);
    const map = new Map();
    retireModel(map, "or::old", T0);
    expect(loadState(file, T0).get("or::old")).toEqual({ state: "retired", since: T0 });
  });

  it("effective() never expires retired (no until)", () => {
    expect(effective({ state: "retired", since: T0 }, T0 + 86_400_000))
      .toEqual({ state: "retired", since: T0 });
  });
});

describe("reviveMatching", () => {
  it("removes an exact model id and its provider pool by bare name", () => {
    const map = new Map();
    setState(map, "or::a", { state: "retired", since: T0 });
    setState(map, "pool::openrouter", { state: "exhausted", until: T0 + 9, reason: "pool" });
    setState(map, "gr::b", { state: "cooldown", until: T0 + 9, reason: "peak-throttle" });
    const removed = reviveMatching(map, "or::a");
    expect(removed).toEqual(["or::a"]);
    expect(reviveMatching(map, "openrouter")).toEqual(["pool::openrouter"]);
    expect([...map.keys()]).toEqual(["gr::b"]);
  });

  it("returns empty when nothing matches", () => {
    expect(reviveMatching(new Map(), "nope")).toEqual([]);
  });
});
