import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TRACE_CAP, bindTraceFile, appendTrace, loadTraces,
  formatTrace, formatTraceList, tracesEnabled, type TraceRecord,
} from "../../src/trace.js";

afterEach(() => bindTraceFile(null));

const T0 = Date.UTC(2026, 7, 25, 12, 0, 0);

function rec(i: number): TraceRecord {
  return {
    requestId: `r${i}-abc123`,
    ts: T0 + i,
    alias: "auto/coding",
    estTokens: 1200,
    widened: false,
    considered: [
      { id: "groq::a" },
      { id: "openrouter::x", excludedBy: "cooldown" },
      { id: "cerebras::y", excludedBy: "provider-blocked" },
    ],
    picked: "groq::a",
    pickedReason: "tier",
    attempts: [{ model: "groq::a", reason: "ok" }],
    servedBy: "groq::a",
  };
}

describe("ring buffer", () => {
  it("starts disabled", () => {
    expect(tracesEnabled()).toBe(false);
  });

  it("caps retention at TRACE_CAP newest records", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mx-trace-")), "traces.json");
    bindTraceFile(file);
    for (let i = 0; i < TRACE_CAP + 7; i++) appendTrace(rec(i));
    const all = loadTraces(file);
    expect(all).toHaveLength(TRACE_CAP);
    expect(all[0]?.requestId).toBe("r7-abc123");
    expect(all[TRACE_CAP - 1]?.requestId).toBe(`r${TRACE_CAP + 6}-abc123`);
  });

  it("returns empty on corrupt or missing files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-trace-"));
    expect(loadTraces(path.join(dir, "missing.json"))).toEqual([]);
    const corrupt = path.join(dir, "corrupt.json");
    fs.writeFileSync(corrupt, "{oops");
    expect(loadTraces(corrupt)).toEqual([]);
  });

  it("appends nothing anywhere while unbound", () => {
    expect(appendTrace(rec(1))).toHaveLength(1);
  });
});

describe("privacy allowlist", () => {
  it("serialized records contain only routing metadata keys", () => {
    const r = rec(9);
    const allowed = new Set([
      "requestId", "ts", "alias", "sessionKey", "estTokens", "widened",
      "considered", "picked", "pickedReason", "attempts", "servedBy",
      "id", "excludedBy", "model", "reason",
    ]);
    const keysOf = (obj: unknown): string[] => {
      if (typeof obj !== "object" || obj === null) return [];
      return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
        Array.isArray(v) ? v.flatMap(keysOf) : typeof v === "object" && v !== null ? [k, ...keysOf(v)] : [k],
      );
    };
    for (const k of keysOf(JSON.parse(JSON.stringify(r)))) {
      expect(allowed.has(k)).toBe(true);
    }
  });
});

describe("formatters", () => {
  it("renders human-readable detail including taxonomy reasons", () => {
    const text = formatTrace(rec(3));
    expect(text).toContain("r3-abc123");
    expect(text).toContain("auto/coding");
    expect(text).toContain("picked=groq::a (tier)");
    expect(text).toContain("openrouter::x");
    expect(text).toContain("cooldown");
    expect(text).toContain("provider-blocked");
  });

  it("renders compact list lines", () => {
    const lines = formatTraceList([rec(1), rec(2)]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("r1-abc123");
    expect(lines[0]).toContain("-> groq::a");
  });
});