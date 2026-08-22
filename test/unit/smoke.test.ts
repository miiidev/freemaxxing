import { describe, it, expect } from "vitest";
import type { RegistryEntry } from "../../src/types.js";

describe("toolchain", () => {
  it("compiles and imports types", () => {
    const e: RegistryEntry = {
      id: "groq::llama-3.3-70b-versatile",
      provider: "groq",
      upstream: "llama-3.3-70b-versatile",
      tags: ["coding"],
      tier: 1,
      speed: "fast",
      context: 128000,
      tools: true,
    };
    expect(e.tier).toBe(1);
  });
});
