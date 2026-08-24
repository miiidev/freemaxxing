import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindMalformedFile, recordMalformed, loadMalformed } from "../../src/malformed.js";

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);

describe("malformed event log", () => {
  beforeEach(() => bindMalformedFile(null));

  it("inert when unbound", () => {
    expect(() => recordMalformed("m::x", "cutoff-length", T0)).not.toThrow();
  });

  it("appends one JSON line per event and loads them back", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-mal-")), "malformed.jsonl");
    bindMalformedFile(file);
    recordMalformed("groq::a", "tool_calls[0]:arguments-not-json", T0);
    recordMalformed("or::b", "cutoff-length", T0 + 5);
    expect(loadMalformed(file)).toEqual([
      { ts: T0, model: "groq::a", reason: "tool_calls[0]:arguments-not-json" },
      { ts: T0 + 5, model: "or::b", reason: "cutoff-length" },
    ]);
  });

  it("stores reason codes only — no response content API exists", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fr-mal2-")), "malformed.jsonl");
    bindMalformedFile(file);
    recordMalformed("m::x", "missing-arg:path", T0);
    const raw = fs.readFileSync(file, "utf8");
    expect(Object.keys(JSON.parse(raw))).toEqual(["ts", "model", "reason"]);
  });

  it("loadMalformed tolerates missing file and corrupt lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-mal3-"));
    expect(loadMalformed(path.join(dir, "nope.jsonl"))).toEqual([]);
    const bad = path.join(dir, "bad.jsonl");
    fs.writeFileSync(bad, "{oops\n");
    expect(loadMalformed(bad)).toEqual([]);
  });
});