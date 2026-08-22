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
    const out = resolve("auto/coding", BUILT_IN_ALIASES, REG, () => OK, CTX);
    expect(out.map((x) => x.id)).toEqual(["a::one", "b::two"]);
  });

  it("auto/fast prefers speed over tier", () => {
    const out = resolve("auto/fast", BUILT_IN_ALIASES, REG, () => OK, CTX);
    expect(out[0]?.speed).toBe("fast");
  });

  it("drops models not in ok state", () => {
    const states: Record<string, ModelState> = { "b::two": EXH, "a::one": COOL };
    const out = resolve("auto/coding", BUILT_IN_ALIASES, REG, (id) => states[id] ?? OK, CTX);
    expect(out).toEqual([]);
  });

  it("requires tools-capable model when request carries tools", () => {
    const reg = [...REG, e({ id: "d::four", provider: "d", upstream: "four", tags: ["coding"], tier: 0, tools: false })];
    const out = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, { ...CTX, hasTools: true });
    expect(out.map((x) => x.id)).not.toContain("d::four");
  });

  it("drops models whose context cannot fit estimated tokens (90% headroom)", () => {
    const reg = [...REG, e({ id: "e::small", provider: "e", upstream: "small", tags: ["coding"], tier: 0, context: 2000 })];
    const out = resolve("auto/coding", BUILT_IN_ALIASES, reg, () => OK, { ...CTX, estTokens: 1900 });
    expect(out.map((x) => x.id)).not.toContain("e::small");
  });

  it("is deterministic across calls", () => {
    const r1 = resolve("auto/any", BUILT_IN_ALIASES, REG, () => OK, CTX).map((x) => x.id);
    const r2 = resolve("auto/any", BUILT_IN_ALIASES, REG, () => OK, CTX).map((x) => x.id);
    expect(r1).toEqual(r2);
  });

  it("supports custom aliases merged from config", () => {
    const aliases = { ...BUILT_IN_ALIASES, "auto/long": { tags: ["long-context"], minContext: 100000 } };
    const reg = [...REG, e({ id: "f::big", provider: "f", upstream: "big", tags: ["long-context"], context: 200000, tier: 5 })];
    const out = resolve("auto/long", aliases, reg, () => OK, CTX);
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
