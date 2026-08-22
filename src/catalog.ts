import providersJson from "./providers.json" with { type: "json" };
import registryJson from "./registry.json" with { type: "json" };
import type { ProviderDef, RegistryEntry } from "./types.js";

export const PROVIDERS = providersJson as Record<string, ProviderDef>;
export const REGISTRY = registryJson as RegistryEntry[];
