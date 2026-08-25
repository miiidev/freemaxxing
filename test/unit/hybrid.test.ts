import { describe, it, expect } from "vitest";
import { paidId, isPaidEntry, hybridEntry, extractCost } from "../../src/hybrid.js";
import { DEFAULT_HYBRID } from "../../src/config.js";

const H = { ...DEFAULT_HYBRID };

describe("paid entry", () => {
  it("obeys <provider>::<upstream> naming", () => {
    expect(paidId(H)).toBe("openrouter::deepseek/deepseek-chat-v3.1");
    expect(isPaidEntry({ id: paidId(H) }, H)).toBe(true);
    expect(isPaidEntry({ id: "openrouter::other" }, H)).toBe(false);
  });

  it("sorts last under any static ordering and claims tools", () => {
    const e = hybridEntry(H);
    expect(e.tier).toBe(99);
    expect(e.speed).toBe("slow");
    expect(e.tools).toBe(true);
    expect(e.upstream).toBe(H.model);
  });
});

describe("extractCost", () => {
  it("prefers provider-reported cost", () => {
    expect(extractCost({ usage: { cost: 0.07, prompt_tokens: 999999 } }, H)).toBe(0.07);
  });

  it("falls back to tokens times configured prices", () => {
    const json = { usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } };
    expect(extractCost(json, H)).toBeCloseTo(0.27 + 0.55, 10);
  });

  it("returns zero when nothing usable is present", () => {
    expect(extractCost({}, H)).toBe(0);
    expect(extractCost({ usage: {} }, H)).toBe(0);
    expect(extractCost({ usage: { prompt_tokens: "many" } }, H)).toBe(0);
  });
});