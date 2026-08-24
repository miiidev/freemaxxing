import { describe, it, expect } from "vitest";
import { validateCompletion, type ToolSpec } from "../../src/toolcall.js";

const PATCH: ToolSpec = {
  type: "function",
  function: {
    name: "apply_patch",
    parameters: { type: "object", required: ["path", "diff"] },
  },
};

const completion = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  choices: [{ finish_reason: "tool_calls", message: { tool_calls: [] } }],
  ...overrides,
});

const call = (name: string, args: unknown) => ({
  id: "c1",
  type: "function",
  function: { name, arguments: args },
});

describe("validateCompletion", () => {
  it("accepts valid OpenAI-style string arguments", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [call("apply_patch", JSON.stringify({ path: "a.ts", diff: "@@" }))] },
        }],
      }),
      [PATCH],
    );
    expect(v).toEqual({ ok: true });
  });

  it("accepts object-form arguments (Google-compat shape)", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "stop",
          message: { tool_calls: [call("apply_patch", { path: "a.ts", diff: "@@" })] },
        }],
      }),
      [PATCH],
    );
    expect(v).toEqual({ ok: true });
  });

  it("accepts parallel tool calls", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [
            call("apply_patch", JSON.stringify({ path: "a.ts", diff: "@@" })),
            call("read_file", JSON.stringify({ path: "b.ts" })),
          ] },
        }],
      }),
      [PATCH, { function: { name: "read_file", parameters: { required: ["path"] } } }],
    );
    expect(v).toEqual({ ok: true });
  });

  it("rejects truncated argument JSON", () => {
    const truncatedJson = '{"path":"a.ts","diff":';
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [call("apply_patch", truncatedJson)] },
        }],
      }),
      [PATCH],
    );
    expect(v.ok).toBe(false);
  });

  it("rejects missing required argument", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [call("apply_patch", JSON.stringify({ path: "a.ts" }))] },
        }],
      }),
      [PATCH],
    );
    expect(v).toEqual({ ok: false, reason: "tool_calls[0]:missing-arg:diff" });
  });

  it("rejects empty-string required argument values", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [call("apply_patch", JSON.stringify({ path: "", diff: "@@" }))] },
        }],
      }),
      [PATCH],
    );
    expect(v).toEqual({ ok: false, reason: "tool_calls[0]:missing-arg:path" });
  });

  it("rejects unknown tool names when tools were requested", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "tool_calls",
          message: { tool_calls: [call("rm_rf", "{}")] },
        }],
      }),
      [PATCH],
    );
    expect(v.reason).toBe("tool_calls[0]:unknown-tool:rm_rf");
  });

  it("rejects empty tool name", () => {
    const v = validateCompletion(
      completion({
        choices: [{ finish_reason: "tool_calls", message: { tool_calls: [call("", "{}")] } }],
      }),
      [PATCH],
    );
    expect(v.reason).toBe("tool_calls[0]:missing-name");
  });

  it("rejects cutoff regardless of payload validity", () => {
    const v = validateCompletion(
      completion({
        choices: [{
          finish_reason: "length",
          message: { tool_calls: [call("apply_patch", JSON.stringify({ path: "a.ts", diff: "@@" }))] },
        }],
      }),
      [PATCH],
    );
    expect(v).toEqual({ ok: false, reason: "cutoff-length" });
  });

  it("LENIENCY: prose reply to a tools request is valid", () => {
    const v = validateCompletion(
      completion({
        choices: [{ finish_reason: "stop", message: { content: "Which file?" } }],
      }),
      [PATCH],
    );
    expect(v).toEqual({ ok: true });
  });

  it("no tools requested: cutoff still fails, plain answers pass", () => {
    expect(validateCompletion(completion({
      choices: [{ finish_reason: "length", message: { content: "half a sen" } }],
    })).reason).toBe("cutoff-length");
    expect(validateCompletion(completion({
      choices: [{ finish_reason: "stop", message: { content: "done" } }],
    }), undefined)).toEqual({ ok: true });
  });

  it("rejects empty choices array", () => {
    expect(validateCompletion({ choices: [] }).ok).toBe(false);
  });
});