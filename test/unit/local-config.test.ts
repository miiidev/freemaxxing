import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, mergeConfigPatch, DEFAULT_LOCAL } from "../../src/config.js";

describe("local config block", () => {
  it("defaults to disabled localhost ollama", () => {
    const cfg = loadConfig(null);
    expect(cfg.local).toEqual(DEFAULT_LOCAL);
    expect(DEFAULT_LOCAL.enabled).toBe(false);
    expect(DEFAULT_LOCAL.endpoint).toBe("http://localhost:11434");
    expect(DEFAULT_LOCAL.model).toBe("qwen2.5-coder:7b");
    expect(DEFAULT_LOCAL.contextWindow).toBe(32768);
  });

  it("parses a full local block", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-cfg-")), "config.json");
    fs.writeFileSync(file, JSON.stringify({
      local: { enabled: true, endpoint: "http://127.0.0.1:8080", model: "llama3.1:8b", contextWindow: 8192 },
    }));
    const cfg = loadConfig(file);
    expect(cfg.local).toEqual({ enabled: true, endpoint: "http://127.0.0.1:8080", model: "llama3.1:8b", contextWindow: 8192 });
  });

  it("rejects garbage fields but keeps valid ones", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-cfg-")), "config.json");
    fs.writeFileSync(file, JSON.stringify({
      local: { enabled: "yes", endpoint: 42, model: "", contextWindow: -5 },
    }));
    const cfg = loadConfig(file);
    expect(cfg.local).toEqual({ ...DEFAULT_LOCAL, enabled: false, model: "qwen2.5-coder:7b" });
  });

  it("keeps other config keys untouched", () => {
    const cfg = loadConfig(null);
    expect(cfg.harvest).toBe(true);
    expect(cfg.port).toBe(8787);
  });
});

describe("mergeConfigPatch", () => {
  it("creates a config file when missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-merge-"));
    const file = path.join(dir, "config.json");
    mergeConfigPatch(file, { local: { enabled: true } });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ local: { enabled: true } });
  });

  it("preserves sibling keys on patch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-merge-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ port: 9999, harvest: false }));
    mergeConfigPatch(file, { local: { enabled: true, model: "m" } });
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(parsed.port).toBe(9999);
    expect(parsed.local).toEqual({ enabled: true, model: "m" });
  });

  it("survives a corrupt base file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-merge-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "{not json");
    mergeConfigPatch(file, { local: { enabled: true } });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).local).toEqual({ enabled: true });
  });
});
