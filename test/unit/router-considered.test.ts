import { describe, it, expect } from "vitest";
import { resolve, BUILT_IN_ALIASES } from "../../src/router.js";
import type { RegistryEntry, ModelState, DailyCaps } from "../../src/types.js";

const OK: ModelState = { state: "ok" };
const COOL: ModelState = { state: "cooldown", until: Number.MAX_SAFE_INTEGER };
const EXH: ModelState = { state: "exhausted", until: Number.MAX_SAFE_INTEGER };
const CTX = { hasTools: false, estTokens: 1000 };
const DAY = Date.UTC(2026, 7, 25, 10, 0, 0);

function e(partial: Partial<RegistryEntry>): RegistryEntry {
  return {
    id: partial.id ?? `${partial.provider ?? "p"}::${partial.upstream ?? "m"}`,
    provider: partial.provider ?? "p",
    upstream: partial.upstream ?? "m",
    tags: partial.tags ?? ["chat"],
    tier: partial.tier ?? 2,
    speed: partial.speed ?? "medium",
    context: partial.context ?? 128000,
    maxOutput: partial.maxOutput,
    tools: partial.tools ?? true,
    limits: partial.limits,
  };
}

describe("considered list", () => {
  it("records first-failing predicate with the documented precedence", () => {
    const reg = [
      e({ id: "z::wrongtag", tags: ["vision"] }),
      e({ id: "z::notools", tools: false, tags: ["coding"] }),
      e({ id: "z::toosmall", context: 200, tags: ["coding"] }),
      e({ id: "z::cool", provider: "q", upstream: "cool", tags: ["coding"] }),
      e({ id: "z::pooldead", provider: "deadpool", upstream: "pd", tags: ["coding"] }),
      e({ id: "z::spent", provider: "sp", upstream: "sp", limits: { rpd: 5 }, tags: ["coding"] }),
      e({ id: "z::kept", provider: "kp", upstream: "k", tier: 3, tags: ["coding"] }),
    ];
    const states: Record<string, ModelState> = { "z::cool": COOL };
    const usage: Record<string, { day: string; requests: number; tokensIn: number; tokensOut: number }> = {
      "z::spent": { day: "2026-08-25", requests: 5, tokensIn: 0, tokensOut: 0 },
    };
    const out = resolve("auto/coding", BUILT_IN_ALIASES, reg, (id) => states[id] ?? OK, {
      ...CTX,
      harvest: true,
      now: DAY,
      getUsage: (id) => usage[id],
      getProviderState: (p) => (p === "deadpool" ? EXH : undefined),
    });
    const byId = Object.fromEntries(out.considered.map((c) => [c.id, c.excludedBy]));
    expect(byId["z::wrongtag"]).toBe("tags");
    expect(byId["z::notools"]).toBe("tools");
    expect(byId["z::toosmall"]).toBe("context-too-small");
    expect(byId["z::cool"]).toBe("cooldown");
    expect(byId["z::pooldead"]).toBe("provider-blocked");
    expect(byId["z::spent"]).toBe("budget");
    expect(byId["z::kept"]).toBeUndefined();
    // kept candidates appear rank-first in the candidates array
    expect(out.candidates[0].id).toBe("z::kept");
  });

  it("prefers model-state attribution over provider-blocked", () => {
    const reg = [e({ id: "q::dual", provider: "deadpool", upstream: "d", tags: ["coding"] })];
    const out = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => COOL, {
      ...CTX,
      getProviderState: () => EXH,
    });
    expect(out.considered[0].excludedBy).toBe("cooldown");
  });

  it("reports retired distinctly", () => {
    const reg = [e({ id: "q::old", provider: "q", upstream: "o", tags: ["coding"] })];
    const out = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => ({ state: "retired", since: 0 }), CTX);
    expect(out.considered[0].excludedBy).toBe("retired");
  });

  it("clears exclusions for candidates re-admitted by widen-back", () => {
    const reg = [
      e({ id: "t::a", provider: "t1", upstream: "a", tags: ["coding"], context: 2000, tier: 1 }),
      e({ id: "t::b", provider: "t2", upstream: "b", tags: ["coding"], context: 1500, tier: 2 }),
    ];
    const out = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, { hasTools: false, estTokens: 1800 });
    expect(out.widened).toBe(true);
    expect(out.candidates.map((c) => c.id)).toEqual(["t::a", "t::b"]);
    expect(out.considered.every((c) => c.excludedBy === undefined)).toBe(true);
  });
});

describe("winnerReason", () => {
  it("credits tier when that decides", () => {
    const reg = [
      e({ id: "a::one", tags: ["coding"], tier: 1 }),
      e({ id: "b::two", tags: ["coding"], tier: 2 }),
    ];
    expect(resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, CTX).winnerReason).toBe("tier");
  });

  it("credits reliability demotion over static tier", () => {
    const lim = (rpd: number): DailyCaps => ({ rpd });
    const reg = [
      e({ id: "a::one", tags: ["coding"], tier: 1, limits: lim(100) }),
      e({ id: "b::two", tags: ["coding"], tier: 2, limits: lim(100) }),
    ];
    const out = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, {
      ...CTX,
      harvest: true,
      now: DAY,
      getReliability: (id) => (id === "a::one" ? { score: 0.5, samples: 9 } : undefined),
      reliabilityCfg: { minSamples: 2, demoteBelow: 0.85 },
    });
    expect(out.winnerReason).toBe("reliability-demoted");
    expect(out.candidates[0].id).toBe("b::two");
  });

  it("credits speed for preferSpeed aliases", () => {
    const reg = [
      e({ id: "s::slowpoke", speed: "slow", tier: 1 }),
      e({ id: "s::quick", speed: "fast", tier: 4 }),
    ];
    expect(resolve("auto/fast", BUILT_IN_ALIASES, reg, () => OK, CTX).winnerReason).toBe("speed");
  });

  it("says sole-candidate when there is no contest", () => {
    const reg = [e({ id: "only::one", tags: ["coding"] })];
    expect(resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, CTX).winnerReason).toBe("sole-candidate");
  });
});