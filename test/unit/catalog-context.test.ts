import { describe, it, expect } from "vitest";
import { REGISTRY } from "../../src/catalog.js";

describe("maxOutput field", () => {
  it("is present and positive on every shipped registry entry", () => {
    const missing = REGISTRY.filter((e) => !(typeof e.maxOutput === "number" && e.maxOutput > 0));
    expect(missing.map((e) => e.id)).toEqual([]);
  });

  it("never exceeds the entry's total context", () => {
    const bad = REGISTRY.filter((e) => (e.maxOutput ?? 0) > e.context);
    expect(bad.map((e) => e.id)).toEqual([]);
  });
});