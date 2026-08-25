import { describe, it, expect } from "vitest";
import { formatLocalLine, formatStatusRow } from "../../src/cli.js";
import { DEFAULT_LOCAL } from "../../src/config.js";

describe("formatLocalLine", () => {
  it("says not configured when disabled", () => {
    expect(formatLocalLine({ ...DEFAULT_LOCAL, enabled: false }, true)).toBe("local \u2014 not configured");
  });

  it("labels port 11434 as ollama and shows availability", () => {
    expect(formatLocalLine({ ...DEFAULT_LOCAL, enabled: true }, true))
      .toBe("local (ollama) \u2014 qwen2.5-coder:7b \u2014 available");
  });

  it("labels custom endpoints and reports unreachability", () => {
    expect(formatLocalLine({ ...DEFAULT_LOCAL, enabled: true, endpoint: "http://192.168.1.10:8080" }, false))
      .toBe("local (custom) \u2014 qwen2.5-coder:7b \u2014 unreachable");
  });
});

describe("status verbose limits column", () => {
  const entry = {
    id: "groq::m", provider: "groq", upstream: "m", tags: ["chat"],
    tier: 2, speed: "fast" as const, context: 131072, maxOutput: 32768, tools: true,
  };

  it("omits the output column by default", () => {
    const row = formatStatusRow(entry, { state: "ok" }, Date.now(), undefined, false);
    expect(row).not.toContain("32k");
  });

  it("shows the output limit under verbose", () => {
    const row = formatStatusRow(entry, { state: "ok" }, Date.now(), undefined, true);
    expect(row).toContain("33k");
  });
});