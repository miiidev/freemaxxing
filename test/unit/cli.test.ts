import { describe, it, expect } from "vitest";
import { formatStatusRow, runCli } from "../../src/cli.js";
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