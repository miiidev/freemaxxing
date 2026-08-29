import { Transform } from "node:stream";
import { validateCompletion, type ToolCallVerdict, type ToolSpec } from "./toolcall.js";

export function rewriteModelField(frame: string, modelId: string): string {
  return frame.replace(/"model"\s*:\s*"[^"]*"/g, `"model":"${modelId}"`);
}

// Buffers partial frames, splits on "\n\n", rewrites each complete frame's model field.
export function sseModelRewriter(modelId: string): Transform {
  let buffer = "";
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buffer += chunk.toString();
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      if (parts.length > 0) {
        this.push(parts.map((f) => rewriteModelField(f, modelId)).join("\n\n") + "\n\n");
      }
      cb();
    },
    flush(cb) {
      if (buffer.length > 0) this.push(rewriteModelField(buffer, modelId));
      cb();
    },
  });
}

// Inserts a served-by annotation frame immediately before the terminal [DONE] frame,
// but only when the stream contained a frame whose finish_reason was "stop".
export function sseAnnotator(modelId: string): Transform {
  let seenStop = false;
  let buffer = "";
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buffer += chunk.toString();
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const frame = part + "\n\n";
        if (frame === "data: [DONE]\n\n") {
          if (seenStop) {
            this.push(annotationFrame(modelId));
          }
          this.push(frame);
        } else {
          if (part.startsWith("data: ")) {
            try {
              const jsonStr = part.slice(6);
              const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
              const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
              if (choices?.[0]?.finish_reason === "stop") {
                seenStop = true;
              }
            } catch {
              // malformed JSON — pass through
            }
          }
          this.push(frame);
        }
      }
      cb();
    },
    flush(cb) {
      if (buffer.length > 0) this.push(buffer);
      cb();
    },
  });
}

function annotationFrame(modelId: string): string {
  return (
    `data: ${JSON.stringify({
      id: "maxout",
      object: "chat.completion.chunk",
      created: 0,
      model: modelId,
      choices: [{ index: 0, delta: { content: `\n\n---\n*maxout: ${modelId}*` }, finish_reason: null }],
    })}\n\n`
  );
}

export interface ToolGuardOptions {
  tools?: ToolSpec[];
  onVerdict?: (v: ToolCallVerdict) => void;
}

// Reassembles streamed tool-call deltas, validates the assembled call at
// stream end, and on failure emits maxout_error BEFORE the held [DONE] —
// SSE clients stop reading at [DONE], so the frame must land first.
export function sseToolCallGuard(opts: ToolGuardOptions): Transform {
  let buffer = "";
  let finishReason: string | undefined;
  const calls = new Map<number, { name: string; args: string }>();

  const absorb = (frame: string): void => {
    if (!frame.startsWith("data: ") || frame === "data: [DONE]") return;
    try {
      const parsed = JSON.parse(frame.slice(6)) as Record<string, unknown>;
      const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
      const c0 = choices?.[0];
      if (!c0) return;
      if (typeof c0.finish_reason === "string") finishReason = c0.finish_reason;
      const delta = c0.delta as Record<string, unknown> | undefined;
      const deltas = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
      for (const d of Array.isArray(deltas) ? deltas : []) {
        const idx = typeof d.index === "number" ? d.index : 0;
        const entry = calls.get(idx) ?? { name: "", args: "" };
        const fn = d.function as { name?: unknown; arguments?: unknown } | undefined;
        if (fn && typeof fn.name === "string") entry.name = fn.name;
        if (fn && typeof fn.arguments === "string") entry.args += fn.arguments;
        calls.set(idx, entry);
      }
    } catch {
      // malformed JSON — pass through
    }
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buffer += chunk.toString();
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        absorb(part);
        // hold [DONE] until the flush-time verdict
        if (part !== "data: [DONE]") this.push(part + "\n\n");
      }
      cb();
    },
    flush(cb) {
      if (buffer.length > 0) {
        absorb(buffer);
        if (buffer !== "data: [DONE]") this.push(buffer);
        buffer = "";
      }
      const assembled = {
        choices: [{
          finish_reason: finishReason,
          message: {
            tool_calls: [...calls.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, c]) => ({ function: { name: c.name, arguments: c.args } })),
          },
        }],
      };
      const verdict = validateCompletion(assembled, opts.tools);
      opts.onVerdict?.(verdict);
      if (!verdict.ok) {
        this.push(`data: ${JSON.stringify({
          maxout_error: "malformed_tool_call",
          detail: verdict.reason,
        })}\n\n`);
      }
      this.push("data: [DONE]\n\n");
      cb();
    },
  });
}

export interface CapturedUsage {
  tokensIn: number;
  tokensOut: number;
}

// Observes usage totals without altering a single byte of the stream.
export function sseUsageCapture(onUsage: (u: CapturedUsage) => void): Transform {
  let buffer = "";
  let done = false;
  const scan = (frame: string) => {
    if (done || !frame.startsWith("data: ") || frame === "data: [DONE]") return;
    try {
      const parsed = JSON.parse(frame.slice(6)) as Record<string, unknown>;
      const u = parsed.usage as Record<string, unknown> | undefined;
      if (u && typeof u === "object") {
        const tokensIn = typeof u.prompt_tokens === "number"
          ? u.prompt_tokens
          : typeof u.total_tokens === "number" ? u.total_tokens : 0;
        const tokensOut = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
        if (tokensIn > 0 || tokensOut > 0) {
          done = true;
          onUsage({ tokensIn, tokensOut });
        }
      }
    } catch {
      // malformed JSON — ignore
    }
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      this.push(chunk);
      buffer += chunk.toString();
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      parts.forEach(scan);
      cb();
    },
    flush(cb) {
      scan(buffer);
      cb();
    },
  });
}