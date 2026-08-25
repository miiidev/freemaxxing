import { describe, it, expect } from "vitest";
import { localModelId, localEntry, localProviderDef, probeLocal } from "../../src/local.js";
import { DEFAULT_LOCAL } from "../../src/config.js";

describe("synthetic local objects", () => {
  it("builds a namespaced model id", () => {
    expect(localModelId({ model: "qwen2.5-coder:7b" })).toBe("local::qwen2.5-coder:7b");
  });

  it("builds a registry entry obeying <provider>::<upstream>", () => {
    const entry = localEntry(DEFAULT_LOCAL);
    expect(entry.id).toBe("local::qwen2.5-coder:7b");
    expect(entry.provider).toBe("local");
    expect(entry.upstream).toBe("qwen2.5-coder:7b");
    expect(entry.tools).toBe(true);
    expect(entry.tier).toBe(9);
    expect(entry.speed).toBe("slow");
    expect(entry.tags).toContain("coding");
    expect(entry.context).toBe(32768);
  });

  it("points the provider at <endpoint>/v1 with dummy auth", () => {
    const def = localProviderDef({ endpoint: "http://localhost:11434/" });
    expect(def.baseURL).toBe("http://localhost:11434/v1");
    expect(def.quirks).toBe("local");
    expect(def.auth).toBe("bearer");
    expect(def.resetProfile).toEqual({ kind: "daily-utc-midnight" });
  });
});

describe("probeLocal", () => {
  it("is false when disabled without touching the network", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    await expect(probeLocal({ enabled: false, endpoint: "http://x" }, fetchImpl)).resolves.toBe(false);
    expect(calls).toBe(0);
  });

  it("is true on HTTP 200 from <endpoint>/v1/models", async () => {
    let seenUrl = "";
    const fetchImpl = (async (url: string | URL) => {
      seenUrl = String(url);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(probeLocal({ enabled: true, endpoint: "http://localhost:11434" }, fetchImpl)).resolves.toBe(true);
    expect(seenUrl).toBe("http://localhost:11434/v1/models");
  });

  it("is false on non-2xx", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(probeLocal({ enabled: true, endpoint: "http://x" }, fetchImpl)).resolves.toBe(false);
  });

  it("is false when the endpoint hangs past the timeout", async () => {
    const fetchImpl = ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    await expect(probeLocal({ enabled: true, endpoint: "http://x" }, fetchImpl, 10)).resolves.toBe(false);
  });
});