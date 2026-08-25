import type { ActiveProvider, LocalConfig } from "./config.js";
import type { RegistryEntry } from "./types.js";

export function joinURL(base: string, pathPart: string): string {
  return base.replace(/\/+$/, "") + pathPart;
}

export function localModelId(cfg: Pick<LocalConfig, "model">): string {
  return `local::${cfg.model}`;
}

// Tier 9 / slow keeps the synthetic entry last under any static sort; it only
// ever reaches the executor via the explicit fallback gate in server.ts.
export function localEntry(cfg: LocalConfig): RegistryEntry {
  return {
    id: localModelId(cfg),
    provider: "local",
    upstream: cfg.model,
    tags: ["coding", "chat", "fast", "long-context"],
    tier: 9,
    speed: "slow",
    context: cfg.contextWindow,
    tools: true,
  };
}

// Ollama and llama.cpp server both ignore Authorization headers; the dummy
// key satisfies ActiveProvider without leaking anything real.
export function localProviderDef(cfg: Pick<LocalConfig, "endpoint">): ActiveProvider {
  return {
    baseURL: joinURL(cfg.endpoint, "/v1"),
    auth: "bearer",
    quirks: "local",
    resetProfile: { kind: "daily-utc-midnight" },
    apiKey: "local",
  };
}

const PROBE_TIMEOUT_MS = 1500;

export async function probeLocal(
  cfg: Pick<LocalConfig, "enabled" | "endpoint">,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!cfg.enabled) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(joinURL(cfg.endpoint, "/v1/models"), { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}