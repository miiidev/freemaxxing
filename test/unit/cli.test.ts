import { describe, it, expect } from "vitest";
import { formatStatusRow, runCli, noProvidersHint } from "../../src/cli.js";
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
