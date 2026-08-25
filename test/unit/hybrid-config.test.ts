import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, mergeConfigPatch, DEFAULT_HYBRID, defaultSpendPath } from "../../src/config.js";
import { fileSpendStore, saveLedger, loadSpend } from "../../src/spend.js";

const T = Date.UTC(2026, 7, 25, 12, 0, 0);

describe("hybrid config block", () => {
  it("defaults to disabled with sane prices", () => {
    const cfg = loadConfig(null);
    expect(cfg.hybrid).toEqual(DEFAULT_HYBRID);
    expect(DEFAULT_HYBRID.enabled).toBe(false);
    expect(DEFAULT_HYBRID.dailyCapUSD).toBe(2);
    expect(DEFAULT_HYBRID.provider).toBe("openrouter");
  });

  it("parses overrides and keeps garbage out", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-hcfg-")), "config.json");
    fs.writeFileSync(file, JSON.stringify({
      hybrid: { enabled: true, dailyCapUSD: 5, provider: "groq", model: "m", priceInPerMTok: -3, dailyCapUSDExtra: 9 },
    }));
    const cfg = loadConfig(file);
    expect(cfg.hybrid?.enabled).toBe(true);
    expect(cfg.hybrid?.dailyCapUSD).toBe(5);
    expect(cfg.hybrid?.provider).toBe("groq");
    expect(cfg.hybrid?.priceInPerMTok).toBe(DEFAULT_HYBRID.priceInPerMTok);
  });

  it("exposes the ledger path under ~/.maxout", () => {
    expect(defaultSpendPath().replace(/\\/g, "/")).toMatch(/\.maxout\/spend\.json$/);
  });
});

describe("spend ledger", () => {
  it("accumulates within the day and rolls over at UTC midnight", () => {
    const store = fileSpendStore(null);
    store.record(0.42, T);
    store.record(0.08, T + 1000);
    expect(store.spentToday(T + 2000)).toBeCloseTo(0.50, 10);
    const nextDay = T + 24 * 60 * 60 * 1000;
    expect(store.spentToday(nextDay)).toBe(0);
  });

  it("persists and reloads through a file, surviving restarts", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-spend-")), "spend.json");
    const writer = fileSpendStore(file);
    writer.record(1.25, T);
    const reader = fileSpendStore(file); // fresh process, same file
    expect(reader.spentToday(T)).toBeCloseTo(1.25, 10);
  });

  it("ignores stale days and corrupt files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-spend-"));
    const stale = path.join(dir, "stale.json");
    saveLedger(stale, { day: "2026-08-24", spentUSD: 99 });
    expect(loadSpend(stale, T)).toBeNull();
    const corrupt = path.join(dir, "corrupt.json");
    fs.writeFileSync(corrupt, "{nope");
    expect(loadSpend(corrupt, T)).toBeNull();
  });

  it("treats the cap as strictly-under-to-route", () => {
    const store = fileSpendStore(null);
    store.record(1.99, T);
    expect(store.spentToday(T) < 2).toBe(true);
    store.record(0.01, T);
    expect(store.spentToday(T) < 2).toBe(false);
  });
});

describe("mergeConfigPatch interplay", () => {
  it("can enable hybrid without losing siblings", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-hmerge-")), "config.json");
    mergeConfigPatch(file, { harvest: false });
    mergeConfigPatch(file, { hybrid: { enabled: true } });
    const cfg = loadConfig(file);
    expect(cfg.harvest).toBe(false);
    expect(cfg.hybrid?.enabled).toBe(true);
  });
});