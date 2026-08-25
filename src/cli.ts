#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { buildServer } from "./server.js";
import { REGISTRY, applyModelLimits } from "./catalog.js";
import { probeLocal } from "./local.js";
import {
  loadConfig, loadEnv, activeProviders, mergedAliases,
  defaultConfigPath, defaultStatePath, defaultEnvPath,
  defaultUsagePath, defaultMalformedPath, defaultReliabilityPath, mergedProviderCaps,
  type AppConfig, type LocalConfig, DEFAULT_LOCAL,
} from "./config.js";
import { loadState, effective, bindStateFile, poolKey, reviveMatching } from "./state.js";
import { aggregateProvider, bindUsageFile, loadUsage, projectExhaustion, type ProviderTotals } from "./usage.js";
import { bindMalformedFile } from "./malformed.js";
import { runSetup, SETUP_PROVIDERS } from "./setup.js";
import {
  loadReliability, bindReliabilityFile, stats, isDemoted,
  type ReliabilityMap,
} from "./reliability.js";
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
  verbose = false,
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
    ...(verbose ? [(e.maxOutput ? fmtCompact(e.maxOutput) : "-").padStart(5)] : []),
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
  forecast?: { projectedAt: number } | null,
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
  const fc = forecast ? ` · projected exhaustion ~${new Date(forecast.projectedAt).toISOString().slice(11, 16)} UTC` : "";
  return [
    `[pool] ${provider.padEnd(12)}`,
    spent.padEnd(10),
    `${st} · resets ${resetAt} UTC${fc}`,
    `shared by ${modelCount} model${modelCount === 1 ? " " : "s"}`,
  ].join("  ");
}

export function formatLocalLine(local: LocalConfig, reachable: boolean): string {
  if (!local.enabled) return "local \u2014 not configured";
  const flavor = local.endpoint.includes(":11434") ? "ollama" : "custom";
  return `local (${flavor}) \u2014 ${local.model} \u2014 ${reachable ? "available" : "unreachable"}`;
}

// First-run guidance: a fresh user with zero keys gets the wizard, everyone
// else (or any non-interactive shell) goes straight to serving.
export function shouldAutoSetup(providerCount: number, interactive: boolean): boolean {
  return providerCount === 0 && interactive;
}

export function noProvidersHint(): string[] {
  return [
    "No provider API keys were found, so every request will fail.",
    "Fix by doing ONE of:",
    '  1. Set a key in this shell (session-only):   $env:GROQ_API_KEY = "gsk_..."   <- PowerShell',
    "                                               set GROQ_API_KEY=gsk_...          <- cmd.exe",
    "  2. Persist it across sessions: create a file at ~/.maxout/.env containing one key per line,",
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

export function buildExportSnapshot(
  cfg: AppConfig,
  registryIds: Array<{ id: string }>,
  map: ReliabilityMap,
  now: number,
): {
  generatedAt: string;
  window: AppConfig["reliability"];
  models: Array<{ id: string; score: number | null; samples: number; avgLatencyMs: number | null }>;
} {
  // Allowlisted projection only — the export must never carry prompt/path/key data.
  const models = registryIds
    .map(({ id }) => ({ id, ...stats(map.get(id) ?? []) }))
    .filter((m) => m.samples > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map(({ id, score, samples, avgLatencyMs }) => ({ id, score, samples, avgLatencyMs }));
  return { generatedAt: new Date(now).toISOString(), window: cfg.reliability, models };
}

async function printReliabilityTable(): Promise<void> {
  const cfg = loadConfig(defaultConfigPath());
  const map = loadReliability(defaultReliabilityPath(), Date.now(), cfg.reliability);
  console.log("maxout reliability (rolling window)");
  console.log("");
  for (const entry of applyModelLimits(REGISTRY, cfg.modelLimits)) {
    const s = stats(map.get(entry.id) ?? []);
    const demoted = isDemoted(s, cfg.reliability) ? "  <-- DEMOTED" : "";
    const scoreCol = s.score === null ? "-" : s.score.toFixed(2);
    const latCol = s.avgLatencyMs === null ? "-" : `${Math.round(s.avgLatencyMs)}ms`;
    console.log(`${entry.id.padEnd(50)} score=${scoreCol}  n=${String(s.samples).padStart(4)}  avg=${latCol}${demoted}`);
  }
}

function exportStatsCmd(argv: string[]): number {
  const cfg = loadConfig(defaultConfigPath());
  const map = loadReliability(defaultReliabilityPath(), Date.now(), cfg.reliability);
  const snapshot = buildExportSnapshot(cfg, REGISTRY, map, Date.now());
  const json = JSON.stringify(snapshot, null, 2);
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  if (!outPath) {
    process.stdout.write(json + "\n");
    return 0;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, outPath);
  process.stderr.write(`wrote ${outPath}\n`);
  return 0;
}

async function printStatus(verbose = false): Promise<void> {
  const cfg = loadConfig(defaultConfigPath());
  const env = loadEnv(defaultEnvPath(), process.env as Record<string, string | undefined>);
  const providers = activeProviders(cfg, env);
  const states = loadState(defaultStatePath());
  const usageMap = loadUsage(defaultUsagePath());
  const providerCount = Object.keys(providers).length;
  console.log(`maxout status - ${providerCount}/6 providers have keys`);
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
        projectExhaustion(provider, caps, usageMap, now),
      ));
    }
    for (const entry of entries) {
      console.log("  " + formatStatusRow(entry, states.get(entry.id) ?? { state: "ok" }, now, usageMap.get(entry.id), verbose));
    }
    console.log("");
  }
  console.log(formatLocalLine(cfg.local ?? DEFAULT_LOCAL, await probeLocal(cfg.local ?? DEFAULT_LOCAL)));
}

export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "serve";

  if (cmd === "status") {
    if (argv.includes("--reliability")) {
      await printReliabilityTable();
    } else {
      await printStatus(argv.includes("--verbose") || argv.includes("-v"));
    }
    return 0;
  }

  if (cmd === "export-stats") {
    return exportStatsCmd(argv);
  }

  if (cmd === "serve") {
    const cfg = loadConfig(defaultConfigPath());
    let env = loadEnv(defaultEnvPath(), process.env as Record<string, string | undefined>);
    let providers = activeProviders(cfg, env);
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (shouldAutoSetup(Object.keys(providers).length, interactive)) {
      console.log("no API keys found - starting first-run setup (ctrl-c to skip)");
      await runSetup({ envPath: defaultEnvPath(), interactive: true });
      // The wizard may have written keys to ~/.maxout/.env — pick them up.
      env = loadEnv(defaultEnvPath(), process.env as Record<string, string | undefined>);
      providers = activeProviders(cfg, env);
    }
    bindStateFile(defaultStatePath()); // spec 4.6: cooldowns/exhaustion survive restarts
    bindUsageFile(defaultUsagePath()); // every served request is persisted as it happens
    bindMalformedFile(defaultMalformedPath()); // quality events survive nothing — append-only log
    bindReliabilityFile(defaultReliabilityPath()); // outcomes survive restarts like usage counters
    const app = buildServer({
      config: cfg,
      providers,
      aliases: mergedAliases(cfg),
      registry: applyModelLimits(REGISTRY, cfg.modelLimits),
      stateMap: loadState(defaultStatePath()),
      usageMap: loadUsage(defaultUsagePath()),
      providerCaps: mergedProviderCaps(cfg),
      reliabilityMap: loadReliability(defaultReliabilityPath(), Date.now(), cfg.reliability),
      localCfg: cfg.local,
    });
    await app.listen({ port: cfg.port, host: cfg.host });
    const providerCount = Object.keys(providers).length;
    console.log(
      `maxout serving ${providerCount}/6 providers on http://${cfg.host}:${cfg.port}/v1`,
    );
    if (providerCount === 0) {
      for (const line of noProvidersHint()) console.log(line);
    }
    return new Promise<number>(() => {
      // server runs until killed
    });
  }

  if (cmd === "setup") {
    const flag = (name: string): string | undefined => {
      const i = argv.indexOf(name);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    const provider = flag("--provider");
    const key = flag("--key");
    const envPath = flag("--env") ?? defaultEnvPath();
    const interactive = provider === undefined && key === undefined;
    if (!interactive && !SETUP_PROVIDERS.some((p) => p.name === provider)) {
      process.stderr.write(`unknown provider '${provider}'. options: ${SETUP_PROVIDERS.map((p) => p.name).join(", ")}\n`);
      return 64;
    }
    return runSetup({ envPath, interactive, provider, key });
  }

  if (cmd === "revive") {
    const target = argv[1];
    if (!target) {
      process.stderr.write("usage: maxout revive <model-id | provider-name>\n");
      return 64;
    }
    const { removed } = reviveCmd(target, defaultStatePath());
    if (removed.length === 0) console.log(`nothing matched '${target}'`);
    else for (const id of removed) console.log(`revived ${id}`);
    return 0;
  }

  process.stderr.write("usage: maxout [serve|status|setup|export-stats|revive]\n");
  return 64;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // Propagate the command's exit code (serve never resolves; it owns the process).
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
