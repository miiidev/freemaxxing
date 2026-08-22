import { describe, it, expect } from "vitest";
import { PROVIDERS, REGISTRY } from "../../src/catalog.js";

describe("catalogs", () => {
  it("exposes all six providers with valid shape", () => {
    for (const name of ["openrouter", "groq", "google", "mistral", "github", "cerebras"]) {
      const p = PROVIDERS[name];
      expect(p, `missing provider ${name}`).toBeDefined();
      expect(p.baseURL.startsWith("https://")).toBe(true);
      expect(p.auth).toBe("bearer");
      expect(typeof p.quirks).toBe("string");
      expect(p.resetProfile.kind).toBe("daily-utc-midnight");
    }
  });

  it("registry entries reference known providers and match id convention", () => {
    expect(REGISTRY.length).toBeGreaterThanOrEqual(19);
    for (const e of REGISTRY) {
      expect(PROVIDERS[e.provider], `${e.id}: unknown provider`).toBeDefined();
      expect(e.id).toBe(`${e.provider}::${e.upstream}`);
      expect(e.tier).toBeGreaterThanOrEqual(1);
      expect(["fast", "medium", "slow"]).toContain(e.speed);
    }
  });

  it("ids are unique", () => {
    expect(new Set(REGISTRY.map((e) => e.id)).size).toBe(REGISTRY.length);
  });
});
