import { describe, it, expect } from "vitest";
import { PROVIDERS, REGISTRY, applyModelLimits } from "../../src/catalog.js";

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

describe("applyModelLimits", () => {
  it("merges per-field overrides over seeded limits", () => {
    const reg = [{ ...REGISTRY[0], limits: { rpd: 50, tpd: 1000 } }];
    const out = applyModelLimits(reg, { [REGISTRY[0].id]: { tpd: 2000 } });
    expect(out[0].limits).toEqual({ rpd: 50, tpd: 2000 });
  });

  it("adds limits to entries without them", () => {
    const entry = REGISTRY.find((e) => !e.limits)!;
    const out = applyModelLimits([entry], { [entry.id]: { rpd: 7 } });
    expect(out[0].limits).toEqual({ rpd: 7 });
  });

  it("ignores unknown ids and returns entries unchanged when no overrides", () => {
    expect(applyModelLimits(REGISTRY, { "nope::x": { rpd: 1 } })).toEqual(REGISTRY);
    expect(applyModelLimits(REGISTRY)).toEqual(REGISTRY);
  });
});

describe("seeded caps", () => {
  it("openrouter pool is account-wide 50/day; google models have per-model rpd", () => {
    expect(PROVIDERS.openrouter.limits).toEqual({ rpd: 50 });
    expect(PROVIDERS.groq.limits?.rpd).toBeGreaterThan(0);
    expect(PROVIDERS.cerebras.limits?.tpd).toBeGreaterThan(0);
    expect(REGISTRY.find((e) => e.id === "google::gemini-2.5-pro")!.limits!.rpd).toBeGreaterThan(0);
  });
});
