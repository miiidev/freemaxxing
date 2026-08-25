import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDERS } from "./catalog.js";
import { BUILT_IN_ALIASES } from "./router.js";
import { DEFAULT_RELIABILITY, type ReliabilityConfig } from "./reliability.js";
import type { AliasDef, DailyCaps, ProviderDef } from "./types.js";

export interface LocalConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  contextWindow: number;
}

export const DEFAULT_LOCAL: LocalConfig = {
  enabled: false,
  endpoint: "http://localhost:11434",
  model: "qwen2.5-coder:7b",
  contextWindow: 32768,
};

export interface HybridConfig {
  enabled: boolean;
  dailyCapUSD: number;
  provider: string;
  model: string;
  priceInPerMTok: number;
  priceOutPerMTok: number;
}

export const DEFAULT_HYBRID: HybridConfig = {
  enabled: false,
  dailyCapUSD: 2,
  provider: "openrouter",
  model: "deepseek/deepseek-chat-v3.1",
  priceInPerMTok: 0.27,
  priceOutPerMTok: 1.1,
};

export interface AppConfig {
  port: number;
  host: string;
  aliases: Record<string, AliasDef>;
  providers: Record<string, { apiKeyEnv: string }>;
  annotateResponses: boolean;
  harvest: boolean;
  modelLimits: Record<string, Partial<DailyCaps>>;
  providerLimits: Record<string, Partial<DailyCaps>>;
  reliability: ReliabilityConfig;
  local?: LocalConfig;
  hybrid?: HybridConfig;
}

export interface ActiveProvider extends ProviderDef {
  apiKey: string;
}

const DEFAULT_ENV_KEYS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  github: "GITHUB_TOKEN",
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
export function defaultSpendPath(): string {
  return path.join(os.homedir(), ".maxout", "spend.json");
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
    local: { ...DEFAULT_LOCAL },
    hybrid: { ...DEFAULT_HYBRID },
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
    if (raw.local && typeof raw.local === "object") {
      const l = raw.local as Partial<LocalConfig>;
      const local = cfg.local!;
      if (typeof l.enabled === "boolean") local.enabled = l.enabled;
      if (typeof l.endpoint === "string" && l.endpoint.startsWith("http")) local.endpoint = l.endpoint;
      if (typeof l.model === "string" && l.model.length > 0) local.model = l.model;
      if (typeof l.contextWindow === "number" && l.contextWindow > 0) {
        local.contextWindow = Math.floor(l.contextWindow);
      }
    }
    if (raw.hybrid && typeof raw.hybrid === "object") {
      const h = raw.hybrid as Partial<HybridConfig>;
      if (typeof h.enabled === "boolean") cfg.hybrid!.enabled = h.enabled;
      if (typeof h.dailyCapUSD === "number" && h.dailyCapUSD > 0) cfg.hybrid!.dailyCapUSD = h.dailyCapUSD;
      if (typeof h.provider === "string" && h.provider.length > 0) cfg.hybrid!.provider = h.provider;
      if (typeof h.model === "string" && h.model.length > 0) cfg.hybrid!.model = h.model;
      if (typeof h.priceInPerMTok === "number" && h.priceInPerMTok >= 0) cfg.hybrid!.priceInPerMTok = h.priceInPerMTok;
      if (typeof h.priceOutPerMTok === "number" && h.priceOutPerMTok >= 0) cfg.hybrid!.priceOutPerMTok = h.priceOutPerMTok;
    }
    if (raw.aliases) cfg.aliases = { ...cfg.aliases, ...raw.aliases };
    if (raw.providers) cfg.providers = { ...cfg.providers, ...raw.providers };
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

// Setup-wizard escape hatch: JSON-merge one patch into config.json atomically.
export function mergeConfigPatch(configPath: string, patch: Record<string, unknown>): void {
  let base: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      base = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  const merged = { ...base, ...patch };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, configPath);
}
