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
