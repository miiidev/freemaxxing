import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.js";
import { bindTraceFile, appendTrace, loadTraces, type TraceRecord } from "../../src/trace.js";

afterEach(() => bindTraceFile(null));

function seed(count = 2): TraceRecord[] {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-clitrace-")), "traces.json");
  bindTraceFile(file);
  const base: Omit<TraceRecord, "requestId"> = {
    ts: Date.UTC(2026, 7, 25, 12, 0, 0),
    alias: "auto/coding",
    estTokens: 900,
    widened: false,
    considered: [{ id: "groq::a" }],
    picked: "groq::a",
    pickedReason: "sole-candidate",
    attempts: [],
    servedBy: "groq::a",
  };
  const made = Array.from({ length: count }, (_, i) =>
    appendTrace({ ...base, requestId: `r${i + 1}-xyz` }));
  void made;
  return loadTraces(file);
}

describe("maxout trace", () => {
  it("prints a specific record by id (human-readable)", async () => {
    seed(1);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const code = await runCli(["trace", "r1-xyz"]);
    vi.restoreAllMocks();
    expect(code).toBe(0);
    expect(out.join("")).toContain("picked=groq::a (sole-candidate)");
  });

  it("lists recent records with --last and emits JSON with --json", async () => {
    seed(2);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const code = await runCli(["trace", "--last", "--json"]);
    vi.restoreAllMocks();
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].requestId).toBe("r1-xyz");
  });

  it("errors politely on unknown ids and missing args", async () => {
    seed(1);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    expect(await runCli(["trace", "nope"])).toBe(1);
    expect(await runCli(["trace"])).toBe(64);
    vi.restoreAllMocks();
    expect(err.join("")).toContain("no trace for 'nope'");
    expect(err.join("")).toContain("usage:");
  });
});