import { describe, it, expect } from "vitest";
import { Transform } from "node:stream";
import { sseToolCallGuard } from "../../src/sse.js";
import type { ToolCallVerdict, ToolSpec } from "../../src/toolcall.js";

const PATCH: ToolSpec = { function: { name: "patch", parameters: { required: ["path"] } } };

async function run(frames: string[], opts?: { tools?: ToolSpec[] }): Promise<{ out: string; verdict?: ToolCallVerdict }> {
  let out = "";
  let verdict: ToolCallVerdict | undefined;
  const target = sseToolCallGuard({ tools: opts?.tools, onVerdict: (v) => { verdict = v; } });
  target.on("data", (d: Buffer) => { out += d.toString(); });
  for (const f of frames) target.write(f);
  await new Promise<void>((resolveDone) => target.end(() => resolveDone()));
  return { out, verdict };
}

describe("sseToolCallGuard", () => {
  it("passes content-only streams through untouched", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { out, verdict } = await run(frames);
    expect(out).toBe(frames.join(""));
    expect(verdict?.ok).toBe(true);
  });

  it("validates reassembled tool-call deltas and passes good ones", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"patch","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { out, verdict } = await run(frames, { tools: [PATCH] });
    expect(verdict?.ok).toBe(true);
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(out.startsWith(frames[0])).toBe(true); // data frames forwarded unchanged
  });

  it("appends malformed_tool_call frame before DONE on truncated arguments", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"patch","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { out, verdict } = await run(frames, { tools: [PATCH] });
    expect(verdict?.ok).toBe(false);
    expect(out).toContain('"maxout_error":"malformed_tool_call"');
    expect(out).toContain("arguments-not-json");
    const doneIdx = out.indexOf("data: [DONE]");
    const errIdx = out.indexOf('"maxout_error":"malformed_tool_call"');
    expect(errIdx).toBeGreaterThan(-1);
    expect(errIdx).toBeLessThan(doneIdx);
  });

  it("flags finish_reason length mid-stream", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { out, verdict } = await run(frames);
    expect(verdict).toEqual({ ok: false, reason: "cutoff-length" });
    expect(out).toContain('"maxout_error":"malformed_tool_call"');
  });
});