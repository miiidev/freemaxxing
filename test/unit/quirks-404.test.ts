import { describe, it, expect } from "vitest";
import { QUIRKS } from "../../src/quirks/index.js";

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);

describe("404 classification", () => {
  for (const [name, quirk] of Object.entries(QUIRKS)) {
    it(`${name}: 404 -> retired`, () => {
      const f = quirk.classifyFailure(
        404,
        { error: { message: "No endpoints found for model" } },
        new Headers(),
        NOW,
      );
      expect(f.kind).toBe("retired");
    });
  }

  it("groq: other client errors stay bad_request", () => {
    expect(
      QUIRKS.groq.classifyFailure(400, { error: { message: "bad" } }, new Headers(), NOW),
    ).toEqual({ kind: "bad_request" });
  });

  it("openrouter: 5xx stays outage even with 404 nearby", () => {
    expect(
      QUIRKS.openrouter.classifyFailure(500, {}, new Headers(), NOW).kind,
    ).toBe("outage");
  });
});