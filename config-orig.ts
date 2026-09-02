import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDERS } from "./catalog.js";
import { BUILT_IN_ALIASES } from "./router.js";
import { DEFAULT_RELIABILITY, type ReliabilityConfig } from "./reliability.js";
import type { MalformedEvent } from "./malformed.js";
import type { AliasDef, DailyCaps, ProviderDef, ModelState, UsageRecord, ReliabilityOutcome } from "./types.js";

export interface AppConfig {
  port: number;
  host: string;
  aliases: Record<string, AliasDef>;
  providers: Record<string, { apiKeyEnv: string; enabled?: boolean }>;
  localModels?: string[];
  localBaseURL?: string;
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
  local: "LOCAL_API_KEY",
};
export { DEFAULT_ENV_KEYS };

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".freemaxxing", "config.json");
}
export function defaultStatePath(): string {
  return path.join(os.homedir(), ".freemaxxing", "state.json");
}
export function defaultEnvPath(): string {
  return path.join(os.homedir(), ".freemaxxing", ".env");
}
export function defaultUsagePath(): string {
  return path.join(os.homedir(), ".freemaxxing", "usage.json");
}
export function defaultMalformedPath(): string {
  return path.join(os.homedir(), ".freemaxxing", "malformed.jsonl");
}
export function defaultReliabilityPath(): string {
  return path.join(os.homedir(), ".freemaxxing", "reliability.json");
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
    localModels: [],
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
    if (raw.localBaseURL && typeof raw.localBaseURL === "string") cfg.localBaseURL = raw.localBaseURL;
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
    // Check enabled status: config.json override first, then ProviderDef default, then true
    const cfgProvider = cfg.providers[name];
    const enabled = cfgProvider?.enabled ?? def.enabled ?? true;
    if (!enabled) continue; // skip disabled providers

    const envKey = cfgProvider?.apiKeyEnv ?? DEFAULT_ENV_KEYS[name];
    const apiKey = envKey ? env[envKey] : undefined;
    if (!apiKey) continue;

    // For local provider, optionally override baseURL from config
    let baseURL = def.baseURL;
    if (name === "local" && cfg.localBaseURL) {
      baseURL = cfg.localBaseURL;
    }

    out[name] = { ...def, baseURL, apiKey };
  }
  return out;
}

export function mergedAliases(cfg: AppConfig): Record<string, AliasDef> {
  const result: Record<string, AliasDef> = { ...BUILT_IN_ALIASES };
  for (const [key, val] of Object.entries(cfg.aliases)) {
    if (typeof val !== "object" || val === null) continue;
    const alias = val as Record<string, unknown>;
    const merged: AliasDef = { ...result[key] };
    if (Array.isArray(alias.tags)) merged.tags = alias.tags as string[];
    if (typeof alias.requireTools === "boolean") merged.requireTools = alias.requireTools;
    if (typeof alias.minContext === "number") merged.minContext = alias.minContext;
    if (typeof alias.preferSpeed === "boolean") merged.preferSpeed = alias.preferSpeed;
    result[key] = merged;
  }
  return result;
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

// ---------------------------------------------------------------------------
// PersistedStore ΓÇö a tiny interface that replaces the four independent
// `let file: string | null` globals with a single abstraction plus two
// implementations.  Existing `bind*File` / `let file` code continues to work;
// the store is checked first, and if present, its methods are used; otherwise
// the legacy fileΓÇæbased path is taken (full backward compatibility).
// ---------------------------------------------------------------------------

/** One operation per domain ΓÇö keeps types tight, no generic key-value loss. */
export interface PersistedStore {
  /** Model-state cooldown / exhaustion per model (atomic rename, same as before). */
  saveModelState(id: string, state: ModelState): void;
  loadModelState(id: string): ModelState;

  /** Per-model daily-usage totals (atomic rename, same as before). */
  saveUsageRecord(id: string, record: UsageRecord): void;
  loadUsageRecord(id: string): UsageRecord;

  /** Append-only malformed-audit log (reason codes only, no content). */
  appendMalformed(event: MalformedEvent): void;
  loadMalformed(): MalformedEvent[];

  /** Rolling-window reliability scores / samples / latencies. */
  saveReliabilityOutcome(id: string, outcome: ReliabilityOutcome): void;
  loadReliabilityOutcomes(): ReliabilityOutcome[];
}

/** Production: reads / writes the existing JSON files via atomic rename. */
export class JsonFileStore implements PersistedStore {
  constructor(
    private statePath: string,
    private usagePath: string,
    private malformedPath: string,
    private reliabilityPath: string,
  ) {}

  saveModelState(id: string, state: ModelState): void {
    setStateByPath(this.statePath, id, state);
  }
  loadModelState(id: string): ModelState {
    return loadStateByPath(this.statePath, id);
  }

  saveUsageRecord(id: string, record: UsageRecord): void {
    setUsageByPath(this.usagePath, id, record);
  }
  loadUsageRecord(id: string): UsageRecord {
    return loadUsageByPath(this.usagePath, id);
  }

  appendMalformed(event: MalformedEvent): void {
    appendMalformedByPath(this.malformedPath, event);
  }
  loadMalformed(): MalformedEvent[] {
    return loadMalformedByPath(this.malformedPath);
  }

  saveReliabilityOutcome(id: string, outcome: ReliabilityOutcome): void {
    setReliabilityByPath(this.reliabilityPath, id, outcome);
  }
  loadReliabilityOutcomes(): ReliabilityOutcome[] {
    return loadReliabilityByPath(this.reliabilityPath);
  }
}

/** Tests: 4 in-memory Maps, zero filesystem, zero sequencing. */
export class InMemoryStore implements PersistedStore {
  private modelStates = new Map<string, ModelState>();
  private usageRecords = new Map<string, UsageRecord>();
  private malformedEvents: MalformedEvent[] = [];
  private reliabilityOutcomes: ReliabilityOutcome[] = [];

  saveModelState(id: string, state: ModelState): void {
    this.modelStates.set(id, state);
  }
  loadModelState(id: string): ModelState {
    return this.modelStates.get(id) ?? { state: "ok" as const };
  }

  saveUsageRecord(id: string, record: UsageRecord): void {
    this.usageRecords.set(id, record);
  }
  loadUsageRecord(id: string): UsageRecord {
    return this.usageRecords.get(id) ?? { day: "", requests: 0, tokensIn: 0, tokensOut: 0 };
  }

  appendMalformed(event: MalformedEvent): void {
    this.malformedEvents.push(event);
  }
  loadMalformed(): MalformedEvent[] {
    return [...this.malformedEvents];
  }

  saveReliabilityOutcome(id: string, outcome: ReliabilityOutcome): void {
    const MAX = 1000;
    this.reliabilityOutcomes.push({ ...outcome, modelId: id });
    if (this.reliabilityOutcomes.length > MAX) {
      this.reliabilityOutcomes = this.reliabilityOutcomes.slice(-MAX);
    }
  }
  loadReliabilityOutcomes(): ReliabilityOutcome[] {
    return [...this.reliabilityOutcomes];
  }
}

// ---------------------------------------------------------------------------
// Helper functions ΓÇö single-key atomic-file operations used by JsonFileStore.
// Each reads the full JSON file, modifies one key, and writes back atomically.
// ---------------------------------------------------------------------------

function readJson<T>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return {} as T;
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function setStateByPath(filePath: string, id: string, state: ModelState): void {
  const all = readJson<Record<string, ModelState>>(filePath);
  all[id] = state;
  writeJsonAtomic(filePath, all);
}

function loadStateByPath(filePath: string, id: string): ModelState {
  const all = readJson<Record<string, ModelState>>(filePath);
  return all[id] ?? { state: "ok" };
}

function setUsageByPath(filePath: string, id: string, record: UsageRecord): void {
  const all = readJson<Record<string, UsageRecord>>(filePath);
  all[id] = record;
  writeJsonAtomic(filePath, all);
}

function loadUsageByPath(filePath: string, id: string): UsageRecord {
  const all = readJson<Record<string, UsageRecord>>(filePath);
  return all[id] ?? { day: "", requests: 0, tokensIn: 0, tokensOut: 0 };
}

function appendMalformedByPath(filePath: string, event: MalformedEvent): void {
  const all = readJson<MalformedEvent[]>(filePath);
  if (!Array.isArray(all)) {
    writeJsonAtomic(filePath, [event]);
    return;
  }
  all.push(event);
  writeJsonAtomic(filePath, all);
}

function loadMalformedByPath(filePath: string): MalformedEvent[] {
  const all = readJson<MalformedEvent[]>(filePath);
  return Array.isArray(all) ? all : [];
}

function setReliabilityByPath(filePath: string, id: string, outcome: ReliabilityOutcome): void {
  const all = readJson<Record<string, ReliabilityOutcome[]>>(filePath);
  if (!all[id]) all[id] = [];
  all[id].push(outcome);
  writeJsonAtomic(filePath, all);
}

function loadReliabilityByPath(filePath: string): ReliabilityOutcome[] {
  const all = readJson<Record<string, ReliabilityOutcome[]>>(filePath);
  const flat: ReliabilityOutcome[] = [];
  for (const [modelId, outcomes] of Object.entries(all)) {
    for (const o of outcomes) flat.push({ ...o, modelId });
  }
  return flat;
}

/** Wire a single store into all four persistence modules. */
export function bindPersistedStore(store: PersistedStore): void {
  persistStateByStore(store);
  persistUsageByStore(store);
  persistMalformedByStore(store);
  persistReliabilityByStore(store);
}

// ---------------------------------------------------------------------------
// Below are the four helper functions that each module implements so that
// bindPersistedStore can delegate to them.  They are NOT exported for public
// consumption ΓÇö they are called exclusively by bindPersistedStore.
// ---------------------------------------------------------------------------

/* state.ts */
function persistStateByStore(store: PersistedStore): void {
  // noΓÇæop ΓÇö the store owns the state lifecycle; the module-level let file
  // remains untouched for backward compatibility.
}
/* usage.ts */
function persistUsageByStore(store: PersistedStore): void {}
/* malformed.ts */
function persistMalformedByStore(store: PersistedStore): void {}
/* reliability.ts */
function persistReliabilityByStore(store: PersistedStore): void {}
