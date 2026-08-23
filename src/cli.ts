import { pathToFileURL } from "node:url";
import { buildServer } from "./server.js";
import { REGISTRY, applyModelLimits } from "./catalog.js";
import {
  loadConfig, loadEnv, activeProviders, mergedAliases,
  defaultConfigPath, defaultStatePath, defaultEnvPath,
  defaultUsagePath, mergedProviderCaps,
} from "./config.js";
import { loadState, effective, bindStateFile } from "./state.js";
import { bindUsageFile, loadUsage } from "./usage.js";
import type { ModelState, RegistryEntry, UsageRecord } from "./types.js";

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatStatusRow(
  e: RegistryEntry,
  msRaw: ModelState,
  now: number,
  usage?: UsageRecord,
): string {
  const ms = effective(msRaw, now);
  let state: string;
  if (ms.state === "ok") {
    state = "ok";
  } else if (ms.state === "cooldown") {
    state = `cooldown ${Math.max(0, Math.round((ms.until - now) / 60_000))}m`;
  } else {
    state = `exhausted until ${new Date(ms.until).toISOString().slice(0, 16)}Z`;
  }
  // spend column only makes sense when the model has caps and today's usage on file
  let usageCol = "req -";
  if (e.limits && usage) {
    const parts: string[] = [];
    if (e.limits.rpd) parts.push(`req ${usage.requests}/${fmtCompact(e.limits.rpd)}`);
    if (e.limits.tpd) {
      parts.push(`tok ${fmtCompact(usage.tokensIn + usage.tokensOut)}/${fmtCompact(e.limits.tpd)}`);
    }
    usageCol = parts.length > 0 ? parts.join(" · ") : "req -";
  }
  return [
    e.id.padEnd(50),
    `t${e.tier}`,
    e.speed.padEnd(7),
    e.tools ? "tools" : "-",
    String(e.context).padStart(7),
    state.padEnd(28),
    usageCol.padEnd(18),
    e.tags.join(","),
  ].join("  ");
}

export function noProvidersHint(): string[] {
  return [
    "No provider API keys were found, so every request will fail.",
    "Fix by doing ONE of:",
    '  1. Set a key in this shell (session-only):   $env:GROQ_API_KEY = "gsk_..."   <- PowerShell',
    "                                               set GROQ_API_KEY=gsk_...          <- cmd.exe",
    "  2. Persist it across sessions: create a file at ~/.freeroll/.env containing one key per line,",
    "     e.g.  GROQ_API_KEY=gsk_...",
    "     Recognized names: OPENROUTER_API_KEY GROQ_API_KEY GEMINI_API_KEY MISTRAL_API_KEY CEREBRAS_API_KEY",
    "Note: in PowerShell, `set NAME=value` does NOT create an environment variable - use $env:NAME = value.",
  ];
}

async function printStatus(): Promise<void> {
  const cfg = loadConfig(defaultConfigPath());
  const env = loadEnv(defaultEnvPath(), process.env as Record<string, string | undefined>);
  const providers = activeProviders(cfg, env);
  const states = loadState(defaultStatePath());
  const usageMap = loadUsage(defaultUsagePath());
  const providerCount = Object.keys(providers).length;
  console.log(`freeroll status - ${providerCount}/6 providers have keys`);
  if (providerCount === 0) {
    console.log("");
    for (const line of noProvidersHint()) console.log(line);
    return;
  }
  console.log("");
  for (const entry of applyModelLimits(REGISTRY, cfg.modelLimits)) {
    if (!providers[entry.provider]) continue;
    console.log(formatStatusRow(entry, states.get(entry.id) ?? { state: "ok" }, Date.now(), usageMap.get(entry.id)));
  }
}

export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "serve";

  if (cmd === "status") {
    await printStatus();
    return 0;
  }

  if (cmd === "serve") {
    const cfg = loadConfig(defaultConfigPath());
    const env = loadEnv(defaultEnvPath(), process.env as Record<string, string | undefined>);
    const providers = activeProviders(cfg, env);
    bindStateFile(defaultStatePath()); // spec 4.6: cooldowns/exhaustion survive restarts
    bindUsageFile(defaultUsagePath()); // every served request is persisted as it happens
    const app = buildServer({
      config: cfg,
      providers,
      aliases: mergedAliases(cfg),
      registry: applyModelLimits(REGISTRY, cfg.modelLimits),
      stateMap: loadState(defaultStatePath()),
      usageMap: loadUsage(defaultUsagePath()),
      providerCaps: mergedProviderCaps(cfg),
    });
    await app.listen({ port: cfg.port, host: cfg.host });
    const providerCount = Object.keys(providers).length;
    console.log(
      `freeroll serving ${providerCount}/6 providers on http://${cfg.host}:${cfg.port}/v1`,
    );
    if (providerCount === 0) {
      for (const line of noProvidersHint()) console.log(line);
    }
    return new Promise<number>(() => {
      // server runs until killed
    });
  }

  process.stderr.write("usage: freeroll [serve|status]\n");
  return 64;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) void runCli(process.argv.slice(2));
