import { describe, it, expect } from "vitest";
import { formatHybridLine } from "../../src/cli.js";

describe("formatHybridLine", () => {
  it("renders dollars spent against the cap", () => {
    expect(formatHybridLine(0.42, 2)).toBe("hybrid: $0.42 / $2.00 spent today");
  });

  it("shows the wall plainly when capped", () => {
    expect(formatHybridLine(2, 2)).toBe("hybrid: $2.00 / $2.00 spent today");
  });
});