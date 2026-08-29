import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDERS } from "./catalog.js";
import { BUILT_IN_ALIASES } from "./router.js";
import { DEFAULT_RELIABILITY, type ReliabilityConfig } from "./reliability.js";
import type { AliasDef, DailyCaps, ProviderDef } from "./types.js";

export interface AppConfig {
  port: number;
  host: string;
  aliases: Record<string, AliasDef>;
  providers: Record<string, { apiKeyEnv: string; enabled?: boolean }>;
  annotateResponses: boolean;
  harvest: boolean;
  modelLimits: Record<string, Partial<DailyCaps>>;
  providerLimits: Record<string, Partial<DailyCaps>>;
  reliability: ReliabilityConfig;
  ttfbTimeoutMs?: number;
  retryBackoffMs?: number;
  pacing?: {
    provider?: string;
    thresholdHours?: number;
    penalty?: number;
  };
}

export interface ActiveProvider extends ProviderDef {
  apiKey: string;
}

const DEFAULT_ENV_KEYS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
};

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".maxout", "config.json");
}
export function defaultStatePath(): string {
  return path.join(os.homedir(), ".maxout", "state.json");
}
export function defaultEnvPath(): string {
  return path.join(os.homedir(), ".maxout", ".env");
}
export function defaultUsagePath(): string {
  return path.join(os.homedir(), ".maxout", "usage.json");
}
export function defaultMalformedPath(): string {
  return path.join(os.homedir(), ".maxout", "malformed.jsonl");
}
export function defaultReliabilityPath(): string {
  return path.join(os.homedir(), ".maxout", "reliability.json");
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadEnv(
  envPath: string,
  processEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (!fs.existsSync(envPath)) return processEnv;
  const parsed = parseEnvFile(fs.readFileSync(envPath, "utf8"));
  return { ...parsed, ...processEnv }; // real environment wins
}

export function loadConfig(configPath: string | null): AppConfig {
  const cfg: AppConfig = {
    port: 8787,
    host: "127.0.0.1",
    aliases: {},
    annotateResponses: true,
    harvest: true,
    modelLimits: {},
    providerLimits: {},
    reliability: { ...DEFAULT_RELIABILITY },
    providers: Object.fromEntries(
      Object.entries(DEFAULT_ENV_KEYS).map(([name, envKey]) => [name, { apiKeyEnv: envKey }]),
    ),
  };
  if (configPath && fs.existsSync(configPath)) {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<AppConfig>;
    if (typeof raw.port === "number") cfg.port = raw.port;
    if (typeof raw.host === "string") cfg.host = raw.host;
    if (typeof raw.annotateResponses === "boolean") cfg.annotateResponses = raw.annotateResponses;
    if (typeof raw.harvest === "boolean") cfg.harvest = raw.harvest;
    if (raw.modelLimits && typeof raw.modelLimits === "object") {
      cfg.modelLimits = raw.modelLimits as AppConfig["modelLimits"];
    }
    if (raw.providerLimits && typeof raw.providerLimits === "object") {
      cfg.providerLimits = raw.providerLimits as AppConfig["providerLimits"];
    }
    if (raw.reliability && typeof raw.reliability === "object") {
      const r = raw.reliability as Partial<ReliabilityConfig>;
      if (typeof r.windowSize === "number" && r.windowSize > 0) cfg.reliability.windowSize = r.windowSize;
      if (typeof r.minSamples === "number" && r.minSamples >= 0) cfg.reliability.minSamples = r.minSamples;
      if (typeof r.demoteBelow === "number" && r.demoteBelow > 0 && r.demoteBelow <= 1) {
        cfg.reliability.demoteBelow = r.demoteBelow;
      }
    }
    if (raw.aliases) cfg.aliases = { ...cfg.aliases, ...raw.aliases };
    if (raw.providers) cfg.providers = { ...cfg.providers, ...raw.providers };
    if (typeof raw.ttfbTimeoutMs === "number" && raw.ttfbTimeoutMs > 0) cfg.ttfbTimeoutMs = raw.ttfbTimeoutMs;
    if (typeof raw.retryBackoffMs === "number" && raw.retryBackoffMs > 0) cfg.retryBackoffMs = raw.retryBackoffMs;
    if (raw.pacing && typeof raw.pacing === "object") {
      cfg.pacing = { ...raw.pacing };
    }
  }
  return cfg;
}

// Graceful degradation: providers whose key env var is unset are simply absent.
export function activeProviders(
  cfg: AppConfig,
  env: Record<string, string | undefined>,
): Record<string, ActiveProvider> {
  const out: Record<string, ActiveProvider> = {};
  for (const [name, def] of Object.entries(PROVIDERS)) {
    const envKey = cfg.providers[name]?.apiKeyEnv ?? DEFAULT_ENV_KEYS[name];
    const apiKey = envKey ? env[envKey] : undefined;
    if (!apiKey) continue;
    out[name] = { ...def, apiKey };
  }
  return out;
}

export function mergedAliases(cfg: AppConfig): Record<string, AliasDef> {
  return { ...BUILT_IN_ALIASES, ...cfg.aliases };
}

// Provider pools are account/org-wide: every model under a provider shares one budget.
export function mergedProviderCaps(cfg: AppConfig): Record<string, DailyCaps> {
  const out: Record<string, DailyCaps> = {};
  for (const [name, def] of Object.entries(PROVIDERS)) {
    if (def.limits) out[name] = { ...def.limits };
  }
  for (const [name, o] of Object.entries(cfg.providerLimits)) {
    out[name] = { ...out[name], ...o };
  }
  return out;
}
