import providersJson from "./providers.json" with { type: "json" };
import registryJson from "./registry.json" with { type: "json" };
import type { ProviderDef, RegistryEntry } from "./types.js";

function isProviderDef(v: unknown): v is ProviderDef {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  const reset = d.resetProfile;
  return (
    typeof d.baseURL === "string" &&
    d.baseURL.startsWith("https://") &&
    d.auth === "bearer" &&
    typeof d.quirks === "string" &&
    d.quirks.length > 0 &&
    typeof reset === "object" &&
    reset !== null &&
    (reset as Record<string, unknown>).kind === "daily-utc-midnight"
  );
}

function isRegistryEntry(v: unknown): v is RegistryEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (
    typeof e.id !== "string" ||
    typeof e.provider !== "string" ||
    typeof e.upstream !== "string"
  ) {
    return false;
  }
  if (!Array.isArray(e.tags) || !e.tags.every((t) => typeof t === "string")) {
    return false;
  }
  if (typeof e.tier !== "number" || !(e.tier >= 1)) return false;
  if (e.speed !== "fast" && e.speed !== "medium" && e.speed !== "slow") {
    return false;
  }
  if (typeof e.context !== "number" || !(e.context > 0)) return false;
  return typeof e.tools === "boolean";
}

const rawProviders: unknown = providersJson;
if (typeof rawProviders !== "object" || rawProviders === null) {
  throw new Error("providers.json: invalid root");
}
for (const [name, def] of Object.entries(rawProviders as Record<string, unknown>)) {
  if (!isProviderDef(def)) throw new Error(`providers.json: invalid entry ${name}`);
}
export const PROVIDERS = rawProviders as Record<string, ProviderDef>;

const rawRegistry: unknown = registryJson;
if (!Array.isArray(rawRegistry)) throw new Error("registry.json: invalid root");
for (const e of rawRegistry) {
  if (!isRegistryEntry(e)) {
    throw new Error(`registry.json: invalid entry ${JSON.stringify(e).slice(0, 80)}`);
  }
}
export const REGISTRY = rawRegistry as RegistryEntry[];
