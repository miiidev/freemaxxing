import { Transform } from "node:stream";

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
      id: "freeroll",
      object: "chat.completion.chunk",
      created: 0,
      model: modelId,
      choices: [{ index: 0, delta: { content: `\n\n---\n*freeroll: ${modelId}*` }, finish_reason: null }],
    })}\n\n`
  );
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
