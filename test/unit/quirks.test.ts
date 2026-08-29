import { describe, it, expect } from "vitest";
import { QUIRKS } from "../../src/quirks/index.js";

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const H = (h: Record<string, string>) => new Headers(h);

describe("shared rules", () => {
  it.each(Object.keys(QUIRKS))("%s: 500 -> outage", (name) => {
    expect(QUIRKS[name].classifyFailure(500, {}, H({}), NOW)).toEqual({ kind: "outage" });
  });
  it.each(Object.keys(QUIRKS))("%s: unknown 4xx -> rate 60s", (name) => {
    expect(QUIRKS[name].classifyFailure(418, {}, H({}), NOW))
      .toEqual({ kind: "rate", retryAfterMs: 60_000 });
  });
});

describe("openrouter", () => {
  const q = QUIRKS["openrouter"];
  it("402 -> quota", () => {
    expect(q.classifyFailure(402, {}, H({}), NOW)).toEqual({ kind: "quota" });
  });
  it("429 free-model exhausted body -> quota", () => {
    expect(q.classifyFailure(429, { error: { message: "free-model-exhausted" } }, H({}), NOW))
      .toEqual({ kind: "quota" });
  });
  it("plain 429 -> rate 60s", () => {
    expect(q.classifyFailure(429, {}, H({}), NOW)).toEqual({ kind: "rate", retryAfterMs: 60_000 });
  });
});

describe("groq", () => {
  const q = QUIRKS["groq"];
  it("429 TPD body -> quota", () => {
    expect(q.classifyFailure(429, { error: { message: "Rate limit reached on tokens per day (TPD)" } }, H({}), NOW))
      .toEqual({ kind: "quota" });
  });
});

describe("google", () => {
  const q = QUIRKS["google"];
  it("429 with retryDelay detail -> rate", () => {
    const body = { error: { status: "RESOURCE_EXHAUSTED", details: [{ "@type": "s", retryDelay: "23s" }] } };
    expect(q.classifyFailure(429, body, H({}), NOW)).toEqual({ kind: "rate", retryAfterMs: 23_000 });
  });
  it("429 RESOURCE_EXHAUSTED without delay -> quota", () => {
    expect(q.classifyFailure(429, { error: { status: "RESOURCE_EXHAUSTED" } }, H({}), NOW))
      .toEqual({ kind: "quota" });
  });
});

describe("mistral", () => {
  const q = QUIRKS["mistral"];
  it("429 quota wording -> quota", () => {
    expect(q.classifyFailure(429, { message: "Requests quota exceeded for this month" }, H({}), NOW))
      .toEqual({ kind: "quota" });
  });
});

describe("retry-after is authoritative", () => {
  const NOW2 = Date.UTC(2026, 7, 22, 12, 0, 0);
  it("openrouter: retry-after beats free-model body", () => {
    expect(QUIRKS["openrouter"].classifyFailure(429, { error: { message: "free-model-exhausted" } }, H({ "retry-after": "5" }), NOW2))
      .toEqual({ kind: "rate", retryAfterMs: 5000 });
  });
  it("groq: retry-after beats TPD body", () => {
    expect(QUIRKS["groq"].classifyFailure(429, { error: { message: "tokens per day (TPD)" } }, H({ "retry-after": "7" }), NOW2))
      .toEqual({ kind: "rate", retryAfterMs: 7000 });
  });
  it("mistral: retry-after beats quota wording", () => {
    expect(QUIRKS["mistral"].classifyFailure(429, { message: "monthly quota exceeded" }, H({ "retry-after": "9" }), NOW2))
      .toEqual({ kind: "rate", retryAfterMs: 9000 });
  });
  it("google: retry-after beats RESOURCE_EXHAUSTED-without-delay", () => {
    expect(QUIRKS["google"].classifyFailure(429, { error: { status: "RESOURCE_EXHAUSTED" } }, H({ "retry-after": "11" }), NOW2))
      .toEqual({ kind: "rate", retryAfterMs: 11000 });
  });
});

describe("ollama", () => {
  const q = QUIRKS["ollama"];
  const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);

  it("500 -> outage", () => {
    expect(q.classifyFailure(500, {}, H({}), NOW)).toEqual({ kind: "outage" });
  });

  it("404 -> retired", () => {
    expect(q.classifyFailure(404, {}, H({}), NOW)).toEqual({ kind: "retired" });
  });

  it("body with model not found -> retired", () => {
    expect(q.classifyFailure(200, { error: "model 'llama3' not found" }, H({}), NOW))
      .toEqual({ kind: "retired" });
  });

  it("body with not loaded -> 30s rate", () => {
    expect(q.classifyFailure(200, { error: "model 'llama3' not loaded" }, H({}), NOW))
      .toEqual({ kind: "rate", retryAfterMs: 30_000 });
  });

  it("422 -> bad_request", () => {
    expect(q.classifyFailure(422, {}, H({}), NOW)).toEqual({ kind: "bad_request" });
  });
});

describe("client errors are deterministic, not rate limits", () => {
  it.each(Object.keys(QUIRKS))("%s: 400 -> bad_request", (name) => {
    expect(QUIRKS[name].classifyFailure(400, {}, H({}), NOW)).toEqual({ kind: "bad_request" });
  });
  it.each(Object.keys(QUIRKS))("%s: 404 -> retired", (name) => {
    expect(QUIRKS[name].classifyFailure(404, {}, H({}), NOW)).toEqual({ kind: "retired" });
  });
  it.each(Object.keys(QUIRKS))("%s: 422 -> bad_request", (name) => {
    expect(QUIRKS[name].classifyFailure(422, {}, H({}), NOW)).toEqual({ kind: "bad_request" });
  });
  it.each(Object.keys(QUIRKS))("%s: retry-after does NOT override a client error", (name) => {
    expect(QUIRKS[name].classifyFailure(400, {}, H({ "retry-after": "5" }), NOW))
      .toEqual({ kind: "bad_request" });
  });
});
