import { describe, it, expect } from "vitest";
import { Transform, Writable, Readable } from "node:stream";
import {
  rewriteModelField,
  sseModelRewriter,
  sseAnnotator,
  sseUsageCapture,
} from "../../src/sse.js";

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

describe("sseAnnotator", () => {
  function collect(annotator: Writable): Promise<string> {
    const results: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { results.push(chunk.toString()); cb(); },
    });
    annotator.pipe(sink);
    return new Promise((resolve) => sink.on("finish", () => resolve(results.join(""))));
  }

  function makeData(content: string, finishReason: string | null): string {
    const fr = finishReason === null ? "null" : `"${finishReason}"`;
    return `data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":${JSON.stringify(content)}},"finish_reason":${fr}}]}\n\n`;
  }

  const DONE = "data: [DONE]\n\n";

  it("inserts annotation frame before [DONE] on stop", async () => {
    const ann = sseAnnotator("groq::final") as Writable;
    const promise = collect(ann);
    ann.write(makeData("hello", null));
    ann.write(makeData(" world", "stop"));
    ann.end(DONE);
    const out = await promise;
    expect(out).toContain('"finish_reason":null');
    expect(out).toContain(`"content":"\\n\\n---\\n*freeroll: groq::final*"`);
    expect(out).toContain(DONE);
    // annotation frame appears between content and DONE
    const lastAnnotation = out.lastIndexOf("freeroll:");
    const donePos = out.indexOf(DONE);
    expect(lastAnnotation).toBeLessThan(donePos);
  });

  it("does NOT annotate when finish_reason is tool_calls", async () => {
    const ann = sseAnnotator("groq::final") as Writable;
    const promise = collect(ann);
    ann.write(makeData("hello", null));
    ann.write(makeData("", "tool_calls"));
    ann.end(DONE);
    const out = await promise;
    expect(out).not.toContain("freeroll:");
    expect(out).toContain(DONE);
  });

  it("passes through untouched when no stop frame seen", async () => {
    const ann = sseAnnotator("groq::final") as Writable;
    const promise = collect(ann);
    ann.write(makeData("hello", null));
    ann.write(makeData(" world", null));
    ann.end(DONE);
    const out = await promise;
    expect(out).not.toContain("freeroll:");
    expect(out).toContain('"content":"hello"');
    expect(out).toContain('"content":" world"');
    expect(out).toContain(DONE);
  });

  it("forwards [DONE] always even with no prior frames", async () => {
    const ann = sseAnnotator("groq::final") as Writable;
    const promise = collect(ann);
    ann.end(DONE);
    const out = await promise;
    expect(out).not.toContain("freeroll:");
    expect(out).toBe(DONE);
  });
});

async function pipeThrough(input: string, t: Transform): Promise<string> {
  const results: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) { results.push(chunk.toString()); cb(); },
  });
  t.pipe(sink);
  t.end(input);
  return new Promise((resolve) => sink.on("finish", () => resolve(results.join(""))));
}

describe("sseUsageCapture", () => {
  it("passes frames through untouched and captures usage once", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n',
      'data: {"choices":[{"delta":{"content":" with \\"usage\\" inside"}}]}\n\n', // word inside content must not match
      "data: [DONE]\n\n",
    ].join("");
    let captured: { tokensIn: number; tokensOut: number } | undefined;
    const out = await pipeThrough(frames, sseUsageCapture((u) => { captured ??= u; }));
    expect(out).toBe(frames);
    expect(captured).toEqual({ tokensIn: 12, tokensOut: 34 });
  });

  it("never fires on streams without usage", async () => {
    let fired = false;
    await pipeThrough('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n',
      sseUsageCapture(() => { fired = true; }));
    expect(fired).toBe(false);
  });
});
