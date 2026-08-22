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
