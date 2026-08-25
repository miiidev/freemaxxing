import type { HybridConfig } from "./config.js";
import type { RegistryEntry } from "./types.js";

export function paidId(h: HybridConfig): string {
  return `${h.provider}::${h.model}`;
}

export function isPaidEntry(e: Pick<RegistryEntry, "id">, h: HybridConfig): boolean {
  return e.id === paidId(h);
}

// Tier 99/slow is cosmetic insurance — the entry reaches the executor only
// via last-position injection, never by winning a sort.
export function hybridEntry(h: HybridConfig): RegistryEntry {
  return {
    id: paidId(h),
    provider: h.provider,
    upstream: h.model,
    tags: ["coding", "chat", "fast", "long-context"],
    tier: 99,
    speed: "slow",
    context: 200000,
    maxOutput: 8192,
    tools: true,
  };
}

// Provider-reported cost wins; token math is the documented approximation.
export function extractCost(json: Record<string, unknown>, h: HybridConfig): number {
  const usage = json.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return 0;
  if (typeof usage.cost === "number") return usage.cost;
  const pt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const ct = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  if (pt === undefined && ct === undefined) return 0;
  return ((pt ?? 0) / 1e6) * h.priceInPerMTok + ((ct ?? 0) / 1e6) * h.priceOutPerMTok;
}