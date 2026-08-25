import { describe, it, expect } from "vitest";
import { shouldAutoSetup } from "../../src/cli.js";

describe("shouldAutoSetup", () => {
  it("triggers for a fresh user: zero keys in an interactive shell", () => {
    expect(shouldAutoSetup(0, true)).toBe(true);
  });

  it("skips when any provider key exists", () => {
    expect(shouldAutoSetup(1, true)).toBe(false);
    expect(shouldAutoSetup(6, true)).toBe(false);
  });

  it("skips in non-interactive shells (CI, pipes) even with zero keys", () => {
    expect(shouldAutoSetup(0, false)).toBe(false);
  });
});
