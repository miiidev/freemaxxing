import { describe, it, expect } from "vitest";
import { formatLocalLine } from "../../src/cli.js";
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