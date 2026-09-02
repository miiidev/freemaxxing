import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnvFile, loadEnv, loadConfig, activeProviders, mergedAliases, mergedProviderCaps } from "../../src/config.js";
import { PROVIDERS } from "../../src/catalog.js";
import { BUILT_IN_ALIASES } from "../../src/router.js";

describe("parseEnvFile", () => {
  it("parses KEY=value, ignores comments/blanks, handles quotes and CRLF", () => {
    const text = "# comment\r\nA=1\r\n\r\nB=\"two words\"\nC='single'\nNOEQ line\n";
    expect(parseEnvFile(text)).toEqual({ A: "1", B: "two words", C: "single" });
  });
});

describe("loadEnv", () => {
  it("process env wins over file values; missing file is fine", () => {
    const merged = loadEnv("/nonexistent/.env", { A: "from-process" });
    expect(merged.A).toBe("from-process");
  });

  it("file value yields to real env when the file exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-env-"));
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "A=from-file\nB=only-in-file\n");
    const merged = loadEnv(file, { A: "from-process" });
    expect(merged.A).toBe("from-process");
    expect(merged.B).toBe("only-in-file");
  });
});

describe("loadConfig", () => {
  it("returns defaults when file missing", () => {
    const cfg = loadConfig(null);
    expect(cfg.port).toBe(8787);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.providers["groq"].apiKeyEnv).toBe("GROQ_API_KEY");
    expect(cfg.annotateResponses).toBe(true);
  });

  it("merges user overrides over defaults", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-cfg-")), "config.json");
    fs.writeFileSync(file, JSON.stringify({
      port: 9999,
      providers: { groq: { apiKeyEnv: "MY_KEY" } },
    }));
    const cfg = loadConfig(file);
    expect(cfg.port).toBe(9999);
    expect(cfg.providers["groq"].apiKeyEnv).toBe("MY_KEY");
    expect(cfg.providers["openrouter"].apiKeyEnv).toBe("OPENROUTER_API_KEY");
  });

  it("annotateResponses default true, explicit false honored", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-cfg-")), "config.json");
    fs.writeFileSync(file, JSON.stringify({ annotateResponses: false }));
    const cfg = loadConfig(file);
    expect(cfg.annotateResponses).toBe(false);
  });
});

describe("activeProviders", () => {
  it("skips keyless providers, attaches key when present", () => {
    const act = activeProviders(loadConfig(null), { GROQ_API_KEY: "sk-groq" });
    expect(Object.keys(act)).toEqual(["groq", "local"]);
    expect(act["groq"].apiKey).toBe("sk-groq");
    expect(act["groq"].baseURL).toBe(PROVIDERS["groq"].baseURL);
    expect(act["local"]).toBeDefined();
    expect(act["local"].auth).not.toBe("bearer");
  });
});

describe("mergedAliases", () => {
  it("built-ins always present, custom added on top", () => {
    const cfg = loadConfig(null);
    cfg.aliases = { "auto/mine": { tags: ["vision"] } };
    const aliases = mergedAliases(cfg);
    expect(aliases["auto/coding"]).toEqual(BUILT_IN_ALIASES["auto/coding"]);
    expect(aliases["auto/mine"]).toBeDefined();
  });
});

describe("harvest config", () => {
  it("defaults harvest on with empty override maps", () => {
    const cfg = loadConfig(null);
    expect(cfg.harvest).toBe(true);
    expect(cfg.modelLimits).toEqual({});
    expect(cfg.providerLimits).toEqual({});
  });

  it("parses harvest off and limit overrides", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-cfg-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({
      harvest: false,
      modelLimits: { "google::gemini-2.5-pro": { rpd: 5 } },
      providerLimits: { openrouter: { rpd: 1000 } },
    }));
    const cfg = loadConfig(file);
    expect(cfg.harvest).toBe(false);
    expect(cfg.modelLimits["google::gemini-2.5-pro"]).toEqual({ rpd: 5 });
    expect(cfg.providerLimits.openrouter).toEqual({ rpd: 1000 });
  });

  it("mergedProviderCaps overlays config onto provider seeds per-field", () => {
    const cfg = loadConfig(null);
    cfg.providerLimits = { openrouter: { rpd: 1000 } };
    const caps = mergedProviderCaps(cfg);
    expect(caps.openrouter).toEqual({ rpd: 1000 }); // seed had only rpd anyway
    expect(caps.groq).toEqual(PROVIDERS.groq.limits);
  });
});
