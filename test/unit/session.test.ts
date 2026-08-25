import { describe, it, expect } from "vitest";
import { deriveSessionKey, SessionAffinity, SESSION_HEADER } from "../../src/session.js";

const TURNS = [
  { role: "user", content: "fix the parser" },
  { role: "assistant", content: "done" },
];

describe("deriveSessionKey", () => {
  it("prefers the explicit header", () => {
    expect(deriveSessionKey({ [SESSION_HEADER]: "agent-run-42" }, TURNS)).toBe("agent-run-42");
  });

  it("uses only the first header value when repeated", () => {
    expect(deriveSessionKey({ [SESSION_HEADER]: ["a", "b"] }, TURNS)).toBe("a");
  });

  it("truncates overlong headers to 64 chars", () => {
    const key = deriveSessionKey({ [SESSION_HEADER]: "x".repeat(100) }, []);
    expect(key?.length).toBe(64);
  });

  it("hashes the first two messages stably", () => {
    const k1 = deriveSessionKey({}, TURNS);
    const k2 = deriveSessionKey({}, [...TURNS, { role: "user", content: "now add tests" }]);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("separates sessions with different opening turns", () => {
    const other = [{ role: "user", content: "write a poem" }, TURNS[1]];
    expect(deriveSessionKey({}, TURNS)).not.toBe(deriveSessionKey({}, other));
  });

  it("returns undefined for empty conversations", () => {
    expect(deriveSessionKey({}, [])).toBeUndefined();
  });
});

describe("SessionAffinity", () => {
  it("remembers the last winner per key", () => {
    const s = new SessionAffinity();
    expect(s.get("k")).toBeUndefined();
    s.set("k", "m1");
    expect(s.get("k")).toBe("m1");
    s.set("k", "m2");
    expect(s.get("k")).toBe("m2");
  });

  it("evicts the least recently USED entry beyond capacity", () => {
    const s = new SessionAffinity(2);
    s.set("a", "m");
    s.set("b", "m");
    s.get("a"); // refresh a — b becomes oldest
    s.set("c", "m");
    expect(s.get("a")).toBe("m");
    expect(s.get("b")).toBeUndefined();
    expect(s.get("c")).toBe("m");
  });
});