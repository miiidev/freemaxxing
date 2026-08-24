import { pathToFileURL } from "node:url";
import { buildServer } from "./server.js";
import { REGISTRY, applyModelLimits } from "./catalog.js";
import {
  loadConfig, loadEnv, activeProviders, mergedAliases,
  defaultConfigPath, defaultStatePath, defaultEnvPath,
  defaultUsagePath, defaultMalformedPath, mergedProviderCaps,
} from "./config.js";
import { loadState, effective, bindStateFile, poolKey, reviveMatching } from "./state.js";
import { aggregateProvider, bindUsageFile, loadUsage, type ProviderTotals } from "./usage.js";
import { bindMalformedFile } from "./malformed.js";
import type { DailyCaps, ModelState, RegistryEntry, UsageRecord } from "./types.js";

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
    const why = ms.reason ? ` (${ms.reason})` : "";
    state = `cooldown ${Math.max(0, Math.round((ms.until - now) / 60_000))}m${why}`;
  } else if (ms.state === "exhausted") {
    const why = ms.reason ? ` (${ms.reason}) ` : " ";
    state = `exhausted${why}until ${new Date(ms.until).toISOString().slice(0, 16)}Z`;
  } else {
    state = `retired since ${new Date(ms.since).toISOString().slice(0, 16)}Z`;
  }
  const parts: string[] = [];
  if (e.limits && usage) {
    if (e.limits.rpd) parts.push(`req ${usage.requests}/${fmtCompact(e.limits.rpd)}`);
    if (e.limits.tpd) {
      parts.push(`tok ${fmtCompact(usage.tokensIn + usage.tokensOut)}/${fmtCompact(e.limits.tpd)}`);
    }
  }
  const usageCol = parts.length > 0 ? parts.join(" · ") : "req -";
  return [
    e.id.padEnd(50),
    `t${e.tier}`,
    e.speed.padEnd(7),
    e.tools ? "tools" : "-",
    String(e.context).padStart(7),
    state.padEnd(34),
    usageCol.padEnd(18),
    e.tags.join(","),
  ].join("  ");
}

export function formatPoolLine(
  provider: string,
  caps: DailyCaps,
  totals: ProviderTotals,
  msRaw: ModelState,
  modelCount: number,
  now: number,
): string {
  const ms = effective(msRaw, now);
  let spent: string;
  if (caps.rpd) {
    spent = `req ${totals.requests}/${fmtCompact(caps.rpd)}`;
  } else {
    spent = `tok ${fmtCompact(totals.tokensIn + totals.tokensOut)}/${fmtCompact(caps.tpd ?? 0)}`;
  }
  // UTC-midnight rollover for every pool profile, so ok pools always read 00:00.
  const resetAt = ms.state === "exhausted" ? new Date(ms.until).toISOString().slice(11, 16) : "00:00";
  const st = ms.state === "ok" || ms.state === "exhausted" ? ms.state : String(ms.state);
  return [
    `[pool] ${provider.padEnd(12)}`,
    spent.padEnd(10),
    `${st} · resets ${resetAt} UTC`,
    `shared by ${modelCount} model${modelCount === 1 ? " " : "s"}`,
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

export function reviveCmd(target: string, statePath: string): { removed: string[] } {
  const map = loadState(statePath);
  bindStateFile(statePath);
  const removed = reviveMatching(map, target);
  bindStateFile(null);
  return { removed };
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
  const providerCaps = mergedProviderCaps(cfg);
  const groups = new Map<string, RegistryEntry[]>();
  for (const entry of applyModelLimits(REGISTRY, cfg.modelLimits)) {
    if (!providers[entry.provider]) continue;
    const list = groups.get(entry.provider) ?? [];
    list.push(entry);
    groups.set(entry.provider, list);
  }
  const now = Date.now();
  for (const [provider, entries] of groups) {
    const caps = providerCaps[provider];
    if (caps) {
      console.log(formatPoolLine(
        provider, caps, aggregateProvider(usageMap, provider),
        states.get(poolKey(provider)) ?? { state: "ok" }, entries.length, now,
      ));
    }
    for (const entry of entries) {
      console.log("  " + formatStatusRow(entry, states.get(entry.id) ?? { state: "ok" }, now, usageMap.get(entry.id)));
    }
    console.log("");
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
    bindMalformedFile(defaultMalformedPath()); // quality events survive nothing — append-only log
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

  if (cmd === "revive") {
    const target = argv[1];
    if (!target) {
      process.stderr.write("usage: freeroll revive <model-id | provider-name>\n");
      return 64;
    }
    const { removed } = reviveCmd(target, defaultStatePath());
    if (removed.length === 0) console.log(`nothing matched '${target}'`);
    else for (const id of removed) console.log(`revived ${id}`);
    return 0;
  }

  process.stderr.write("usage: freeroll [serve|status|revive]\n");
  return 64;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) void runCli(process.argv.slice(2));
