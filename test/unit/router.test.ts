import { describe, it, expect } from "vitest";
import { resolve, estimateTokens, BUILT_IN_ALIASES, UnknownAliasError } from "../../src/router.js";
import type { RegistryEntry, ModelState } from "../../src/types.js";

const OK: ModelState = { state: "ok" };
const COOL: ModelState = { state: "cooldown", until: Number.MAX_SAFE_INTEGER };
const EXH: ModelState = { state: "exhausted", until: Number.MAX_SAFE_INTEGER };
const CTX = { hasTools: false, estTokens: 1000 };

function e(partial: Partial<RegistryEntry>): RegistryEntry {
  return {
    id: partial.id ?? `${partial.provider ?? "p"}::${partial.upstream ?? "m"}`,
    provider: partial.provider ?? "p",
    upstream: partial.upstream ?? "m",
    tags: partial.tags ?? ["chat"],
    tier: partial.tier ?? 2,
    speed: partial.speed ?? "medium",
    context: partial.context ?? 128000,
    tools: partial.tools ?? true,
  };
}

const REG: RegistryEntry[] = [
  e({ id: "a::one", provider: "a", upstream: "one", tags: ["coding"], tier: 1, speed: "slow" }),
  e({ id: "b::two", provider: "b", upstream: "two", tags: ["coding"], tier: 2, speed: "fast" }),
  e({ id: "c::three", provider: "c", upstream: "three", tags: ["chat"], tier: 1 }),
];

describe("resolve", () => {
  it("auto/coding filters to coding tag and ranks tier asc then speed then id", () => {
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, REG, () => OK, CTX);
    const out = resolved.candidates;
    expect(out.map((x) => x.id)).toEqual(["a::one", "b::two"]);
  });

  it("auto/fast prefers speed over tier", () => {
    const resolved = resolve("auto/fast", BUILT_IN_ALIASES, REG, () => OK, CTX);
    const out = resolved.candidates;
    expect(out[0]?.speed).toBe("fast");
  });

  it("drops models not in ok state", () => {
    const states: Record<string, ModelState> = { "b::two": EXH, "a::one": COOL };
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, REG, (id) => states[id] ?? OK, CTX);
    const out = resolved.candidates;
    expect(out).toEqual([]);
  });

  it("requires tools-capable model when request carries tools", () => {
    const reg = [...REG, e({ id: "d::four", provider: "d", upstream: "four", tags: ["coding"], tier: 0, tools: false })];
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, { ...CTX, hasTools: true });
    const out = resolved.candidates;
    expect(out.map((x) => x.id)).not.toContain("d::four");
  });

  it("drops models whose context cannot fit estimated tokens (90% headroom)", () => {
    const reg = [...REG, e({ id: "e::small", provider: "e", upstream: "small", tags: ["coding"], tier: 0, context: 2000 })];
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, { ...CTX, estTokens: 1900 });
    const out = resolved.candidates;
    expect(out.map((x) => x.id)).not.toContain("e::small");
  });

  it("is deterministic across calls", () => {
    const r1 = resolve("auto/any", BUILT_IN_ALIASES, REG, () => OK, CTX).candidates.map((x) => x.id);
    const r2 = resolve("auto/any", BUILT_IN_ALIASES, REG, () => OK, CTX).candidates.map((x) => x.id);
    expect(r1).toEqual(r2);
  });

  it("supports custom aliases merged from config", () => {
    const aliases = { ...BUILT_IN_ALIASES, "auto/long": { tags: ["long-context"], minContext: 100000 } };
    const reg = [...REG, e({ id: "f::big", provider: "f", upstream: "big", tags: ["long-context"], context: 200000, tier: 5 })];
    const resolved = resolve("auto/long", aliases, reg, () => OK, CTX);
    const out = resolved.candidates;
    expect(out.map((x) => x.id)).toEqual(["f::big"]);
  });

  it("throws UnknownAliasError for unknown alias", () => {
    expect(() => resolve("nope/none", BUILT_IN_ALIASES, REG, () => OK, CTX))
      .toThrow(UnknownAliasError);
  });
});

describe("estimateTokens", () => {
  it("is roughly chars/4 rounded up", () => {
    const body = { a: "12345678" };
    expect(estimateTokens(body)).toBe(Math.ceil(JSON.stringify(body).length / 4));
  });
});

const DAY = Date.UTC(2026, 7, 23, 10, 0, 0);
const recOf = (requests: number) => ({ day: "2026-08-23", requests, tokensIn: 0, tokensOut: 0 });

const LIMITED: RegistryEntry[] = [
  { ...REG[0], limits: { rpd: 100 } },
  { ...REG[1], limits: { rpd: 100 } },
  { ...REG[2], limits: { rpd: 100 } },
];

function harvestCtx(usage: Record<string, ReturnType<typeof recOf>>) {
  return {
    ...CTX,
    harvest: true,
    now: DAY,
    getUsage: (id: string) => usage[id],
  };
}

describe("harvest mode", () => {
  const usage = { "a::one": recOf(90), "b::two": recOf(5), "c::three": recOf(0) };

  it("orders tier asc then headroom asc within tier", () => {
    // a::one and c::three are tier 1; a::one at 90% vs c::three at 0%; b::two is tier 2
    const { candidates } = resolve("auto/any", BUILT_IN_ALIASES, LIMITED, () => OK, harvestCtx(usage));
    expect(candidates.map((x) => x.id)).toEqual(["c::three", "a::one", "b::two"]);
  });

  it("skips budget-dead candidates into skippedByBudget", () => {
    const ctx = harvestCtx({ ...usage, "c::three": recOf(100) });
    const { candidates, skippedByBudget } = resolve("auto/any", BUILT_IN_ALIASES, LIMITED, () => OK, ctx);
    expect(candidates.map((x) => x.id)).not.toContain("c::three");
    expect(skippedByBudget.map((x) => x.id)).toEqual(["c::three"]);
  });

  it("preferSpeed aliases keep speed primary with headroom secondary", () => {
    // b::two is fast+fresh; c::three medium-fresh beats a::one slow-spent
    const { candidates } = resolve("auto/fast", BUILT_IN_ALIASES, LIMITED, () => OK, harvestCtx(usage));
    expect(candidates.map((x) => x.speed)).toEqual(["fast", "medium", "slow"]);
  });

  it("treats unlimited models as full headroom (fraction 0)", () => {
    const mixed: RegistryEntry[] = [
      ...LIMITED,
      e({ id: "z::free", provider: "z", upstream: "free", tags: ["chat"], tier: 1 }),
    ];
    const { candidates } = resolve("auto/any", BUILT_IN_ALIASES, mixed, () => OK, harvestCtx(usage));
    expect(candidates[0].id).toBe("z::free");
  });

  it("provider pool exhaustion skips models with personal headroom", () => {
    const ctx = {
      ...harvestCtx(usage),
      getProviderCaps: (p: string) => (p === "a" ? { rpd: 90 } : undefined),
    };
    const { candidates, skippedByBudget } = resolve("auto/any", BUILT_IN_ALIASES, LIMITED, () => OK, ctx);
    expect(skippedByBudget.map((x) => x.id)).toEqual(["a::one"]); // pooled 90/90
    expect(candidates.map((x) => x.id)).toEqual(["c::three", "b::two"]);
  });
});

describe("harvest off parity", () => {
  it("ignores usage entirely and preserves legacy order", () => {
    const spent = { "a::one": recOf(100), "c::three": recOf(100), "b::two": recOf(100) };
    const out = resolve("auto/coding", BUILT_IN_ALIASES, REG, () => OK, {
      ...CTX, harvest: true, now: DAY, getUsage: (id) => spent[id],
    });
    expect(out.candidates.map((x) => x.id)).toEqual(["a::one", "b::two"]);
    expect(out.skippedByBudget).toEqual([]); // REG entries carry no limits -> inert
  });

  it("spent limited models stay candidates when harvest is off", () => {
    const spent = { "a::one": recOf(100), "b::two": recOf(100), "c::three": recOf(100) };
    const out = resolve("auto/any", BUILT_IN_ALIASES, LIMITED, () => OK, {
      ...CTX, harvest: false, now: DAY, getUsage: (id) => spent[id],
    });
    expect(out.candidates.map((x) => x.id)).toEqual(["c::three", "a::one", "b::two"]); // legacy tier/speed order
    expect(out.skippedByBudget).toEqual([]);
  });

  it("unlimited still outranks capped at full ties with harvest off (limitedKey)", () => {
    // documents the intentional deviation from byte-for-byte v0 parity
    const mixed = [...LIMITED, e({ id: "z::free", provider: "z", upstream: "free", tags: ["chat"], tier: 1 })];
    const out = resolve("auto/any", BUILT_IN_ALIASES, mixed, () => OK, { ...CTX, harvest: false, now: DAY });
    expect(out.candidates[0].id).toBe("z::free");
  });
});

describe("provider-level blocking", () => {
  const BLOCKED_EXH: ModelState = { state: "exhausted", until: Number.MAX_SAFE_INTEGER, reason: "pool" };
  const EXPIRED: ModelState = { state: "exhausted", until: 1, reason: "pool" };
  const RETIRED_POOL: ModelState = { state: "retired", since: 0 };

  it("drops every candidate of a blocked provider", () => {
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, REG, () => OK, {
      ...CTX,
      getProviderState: (p) => (p === "a" ? BLOCKED_EXH : undefined),
    });
    expect(resolved.candidates.map((x) => x.id)).toEqual(["b::two"]);
    expect(resolved.skippedByBudget).toEqual([]);
  });

  it("ignores expired pool blocks (lazy expiry)", () => {
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, REG, () => OK, {
      ...CTX,
      getProviderState: (p) => (p === "a" ? EXPIRED : undefined),
    });
    expect(resolved.candidates.map((x) => x.id)).toEqual(["a::one", "b::two"]);
  });

  it("honors retired pool entries regardless of time", () => {
    const resolved = resolve("auto/coding", BUILT_IN_ALIASES, REG, () => OK, {
      ...CTX,
      getProviderState: (p) => (p === "a" ? RETIRED_POOL : undefined),
    });
    expect(resolved.candidates.map((x) => x.id)).toEqual(["b::two"]);
  });
});
