import { describe, it, expect } from "vitest";
import { SETUP_PROVIDERS, buildEnvContent } from "../../src/setup.js";

describe("SETUP_PROVIDERS", () => {
  it("recommends groq first", () => {
    expect(SETUP_PROVIDERS[0].name).toBe("groq");
  });

  it("covers the five live providers and skips retired github", () => {
    expect(SETUP_PROVIDERS.map((p) => p.name)).toEqual([
      "groq", "google", "openrouter", "mistral", "cerebras",
    ]);
  });

  it("uses https everywhere", () => {
    for (const p of SETUP_PROVIDERS) {
      expect(p.baseURL.startsWith("https://")).toBe(true);
      expect(p.signupUrl.startsWith("https://")).toBe(true);
    }
  });
});

describe("buildEnvContent", () => {
  it("creates sorted KEY=VALUE lines from nothing", () => {
    expect(buildEnvContent(undefined, { GROQ_API_KEY: "gsk_1", B_KEY: "2" }))
      .toBe("B_KEY=2\nGROQ_API_KEY=gsk_1\n");
  });

  it("upserts known keys while preserving unrecognized lines", () => {
    const existing = "# my notes\nOLD_TOKEN=abc\nGROQ_API_KEY=gsk_old\n";
    const out = buildEnvContent(existing, { GROQ_API_KEY: "gsk_new" });
    expect(out).toContain("OLD_TOKEN=abc");
    expect(out).not.toContain("gsk_old");
    expect(out).toContain("GROQ_API_KEY=gsk_new");
  });

  it("drops duplicate definitions of an updated key", () => {
    const existing = "GROQ_API_KEY=a\nGROQ_API_KEY=b\n";
    const out = buildEnvContent(existing, { GROQ_API_KEY: "c" });
    expect(out.match(/GROQ_API_KEY=/g)).toHaveLength(1);
    expect(out).toContain("GROQ_API_KEY=c");
  });
});