import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { formatStatusRow, formatPoolLine, runCli, noProvidersHint, reviveCmd } from "../../src/cli.js";
import { loadState, bindStateFile, setState, retireModel } from "../../src/state.js";
import type { RegistryEntry, ModelState } from "../../src/types.js";

const E: RegistryEntry = {
  id: "groq::llama-3.3-70b-versatile", provider: "groq", upstream: "llama-3.3-70b-versatile",
  tags: ["coding", "chat"], tier: 2, speed: "fast", context: 128000, tools: true,
};
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);

describe("formatStatusRow", () => {
  it("renders ok state", () => {
    const row = formatStatusRow(E, { state: "ok" }, NOW);
    expect(row).toContain("groq::llama-3.3-70b-versatile");
    expect(row).toContain("ok");
  });
  it("renders cooldown with humanized remaining minutes", () => {
    const ms: ModelState = { state: "cooldown", until: NOW + 180_000 };
    expect(formatStatusRow(E, ms, NOW)).toContain("cooldown 3m");
  });
  it("renders exhausted with UTC reset time", () => {
    const ms: ModelState = { state: "exhausted", until: Date.UTC(2026, 7, 23, 0, 0, 0) };
    const row = formatStatusRow(E, ms, NOW);
    expect(row).toContain("exhausted until 2026-08-23T00:00Z");
  });
});

describe("reason rendering", () => {
  it("shows cooldown reason next to remaining minutes", () => {
    const ms: ModelState = { state: "cooldown", until: NOW + 180_000, reason: "peak-throttle" };
    expect(formatStatusRow(E, ms, NOW)).toContain("cooldown 3m (peak-throttle)");
  });
  it("defaults gracefully when reason absent (legacy snapshots)", () => {
    const ms: ModelState = { state: "cooldown", until: NOW + 60_000 };
    expect(formatStatusRow(E, ms, NOW)).toContain("cooldown 1m");
  });
  it("shows exhausted reason before the reset timestamp", () => {
    const ms: ModelState = { state: "exhausted", until: Date.UTC(2026, 7, 25, 0, 0, 0), reason: "pool" };
    expect(formatStatusRow(E, ms, NOW)).toContain("exhausted (pool) until 2026-08-25T00:00Z");
  });
  it("renders retired with since timestamp", () => {
    const ms: ModelState = { state: "retired", since: Date.UTC(2026, 7, 24, 9, 30, 0) };
    expect(formatStatusRow(E, ms, NOW)).toContain("retired since 2026-08-24T09:30Z");
  });
});

describe("runCli arg routing", () => {
  it("unknown command returns 64", async () => {
    expect(await runCli(["bogus"])).toBe(64);
  });
});

describe("formatStatusRow usage column", () => {
  const E2: RegistryEntry = { ...E, limits: { rpd: 50, tpd: 1000000 } };

  it("renders spend against caps", () => {
    const row = formatStatusRow(E2, { state: "ok" }, NOW,
      { day: "2026-08-22", requests: 12, tokensIn: 84000, tokensOut: 16000 });
    expect(row).toContain("req 12/50");
    expect(row).toContain("tok 100k/1M");
  });

  it("renders dash for models without caps", () => {
    expect(formatStatusRow(E, { state: "ok" }, NOW)).toContain("req -");
  });

  it("omits unseeded dimensions", () => {
    const half: RegistryEntry = { ...E, limits: { rpd: 50 } };
    const row = formatStatusRow(half, { state: "ok" }, NOW,
      { day: "2026-08-22", requests: 3, tokensIn: 5, tokensOut: 5 });
    expect(row).toContain("req 3/50");
    expect(row).not.toContain("tok");
  });
});

describe("formatPoolLine", () => {
  const TOTALS = { requests: 23, tokensIn: 70, tokensOut: 5 };
  it("renders request-based pools with shared-by count", () => {
    const line = formatPoolLine("openrouter", { rpd: 50 }, TOTALS, { state: "ok" }, 12, NOW);
    expect(line).toContain("[pool] openrouter");
    expect(line).toContain("req 23/50");
    expect(line).toContain("shared by 12 models");
  });
  it("renders token-based pools", () => {
    const line = formatPoolLine("cerebras", { tpd: 1000000 },
      { requests: 2, tokensIn: 900000, tokensOut: 100000 }, { state: "ok" }, 3, NOW);
    expect(line).toContain("tok 1M/1M");
  });
  it("shows exhausted state with UTC reset time", () => {
    const ms: ModelState = { state: "exhausted", until: Date.UTC(2026, 7, 25, 0, 0, 0), reason: "pool" };
    const line = formatPoolLine("openrouter", { rpd: 50 },
      { requests: 50, tokensIn: 0, tokensOut: 0 }, ms, 12, NOW);
    expect(line).toContain("exhausted · resets 00:00 UTC");
  });
  it("singularizes a single shared model", () => {
    const line = formatPoolLine("x", { rpd: 5 },
      { requests: 0, tokensIn: 0, tokensOut: 0 }, { state: "ok" }, 1, NOW);
    expect(line).toContain("shared by 1 model ");
  });
});

describe("noProvidersHint", () => {
  it("leads with the problem and names a concrete fix path", () => {
    const lines = noProvidersHint();
    expect(lines[0]).toMatch(/no provider/i);
    const joined = lines.join("\n");
    expect(joined).toContain("GROQ_API_KEY");
    expect(joined.toLowerCase()).toContain(".env");
    expect(joined).toContain("$env:");
    expect(joined).toMatch(/does not create an environment variable/i);
  });
});

describe("reviveCmd", () => {
  it("clears matching model and pool entries and persists", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-revive-")), "state.json");
    const map = new Map();
    retireModel(map, "or::a", Date.now());
    setState(map, "pool::openrouter", { state: "exhausted", until: Date.now() + 9, reason: "pool" });
    saveTmp(file, map);

    bindStateFile(file);
    const { removed } = reviveCmd("openrouter", file);
    bindStateFile(null);

    expect(removed).toEqual(["pool::openrouter"]);
    expect(loadState(file).has("pool::openrouter")).toBe(false);
    expect(loadState(file).has("or::a")).toBe(true);
  });

  it("reports nothing matched", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-revive2-")), "state.json");
    expect(reviveCmd("ghost", file).removed).toEqual([]);
  });
});

function saveTmp(file: string, map: Map<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(map)));
}

describe("runCli arg routing", () => {
  it("unknown command returns 64", async () => {
    expect(await runCli(["bogus"])).toBe(64);
  });

  it("revive without argument returns 64", async () => {
    expect(await runCli(["revive"])).toBe(64);
  });
});
