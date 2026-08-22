import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { rewriteModelField, sseModelRewriter } from "../../src/sse.js";

describe("rewriteModelField", () => {
  it("rewrites model in an SSE frame", () => {
    const frame = 'data: {"id":"1","model":"secret-upstream","choices":[]}\n\n';
    expect(rewriteModelField(frame, "groq::x")).toContain('"model":"groq::x"');
  });
  it("leaves frames without a model untouched", () => {
    expect(rewriteModelField("data: [DONE]\n\n", "groq::x")).toBe("data: [DONE]\n\n");
  });
});

describe("sseModelRewriter", () => {
  it("handles frames split across chunks", async () => {
    const results: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { results.push(chunk.toString()); cb(); },
    });
    const rw = sseModelRewriter("groq::final");
    rw.pipe(sink);
    rw.write('data: {"model":"sec\n');                       // frame split mid-string
    rw.write('ret-up"}\n\ndata: {"model":"other"}\n\n');
    rw.end('data: [DONE]\n\n');
    await new Promise<void>((r) => sink.on("finish", () => r()));
    const joined = results.join("");
    expect(joined).toContain('"model":"groq::final"');
    expect(joined).not.toContain("secret-up");
    expect(joined.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});