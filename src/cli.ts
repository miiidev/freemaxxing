#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { Table } from "console-table-printer";
import { buildServer } from "./server.js";
import { REGISTRY, applyModelLimits, buildLocalRegistry, PROVIDERS } from "./catalog.js";
import {
  loadConfig, loadEnv, activeProviders, mergedAliases,
  defaultConfigPath, defaultStatePath, defaultEnvPath,
  defaultUsagePath, defaultMalformedPath, defaultReliabilityPath, mergedProviderCaps,
  type AppConfig,
  DEFAULT_ENV_KEYS,
} from "./config.js";
import { loadState, effective, bindStateFile, poolKey, reviveMatching } from "./state.js";
import { bindMalformedFile } from "./malformed.js";
import { runSetup, SETUP_PROVIDERS } from "./setup.js";
import {
  loadReliability, bindReliabilityFile, stats, isDemoted,
  type ReliabilityMap,
} from "./reliability.js";
import type { DailyCaps, ModelState, RegistryEntry, UsageRecord } from "./types.js";
import { aggregateProvider, bindUsageFile, loadUsage, type ProviderTotals } from "./usage.js";

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
): string[] {
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
    e.id,
    `t${e.tier}`,
    e.speed,
    e.tools ? "tools" : "-",
    String(e.context),
    state,
    usageCol,
    e.tags.join(","),
  ];
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
  let spent = "";
  if (caps.rpd) {
    spent = `req ${totals.requests}/${fmtCompact(caps.rpd)}`;
  }
  if (caps.tpd) {
    if (spent) spent += " · ";
    spent += `tok ${fmtCompact(totals.tokensIn + totals.tokensOut)}/${fmtCompact(caps.tpd)}`;
  }
  if (!spent) spent = "req -";
  // UTC-midnight rollover for every pool profile, so ok pools always read 00:00.
  const resetAt = ms.state === "exhausted" ? new Date(ms.until).toISOString().slice(11, 16) : "00:00";
  const st = ms.state === "ok" || ms.state === "exhausted" ? ms.state : String(ms.state);
  return [
    `[pool] ${provider.padEnd(12)}`,
    spent.padEnd(10),
    `${st} · resets ${resetAt} UTC`,
    `shared by ${modelCount} model${modelCount === 1 ? "" : "s"}`,
  ].join("  ");
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
    "  2. Persist it across sessions: create a file at ~/.freemaxxing/.env containing one key per line,",
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
  console.log("freemaxxing reliability (rolling window)");
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

async function printStatus(): Promise<void> {
  const cfg = loadConfig(defaultConfigPath());
  const env = loadEnv(defaultEnvPath(), process.env as Record<string, string | undefined>);
  const allProviders = Object.keys(PROVIDERS);
  const providers = activeProviders(cfg, env);
  const states = loadState(defaultStatePath());
  const usageMap = loadUsage(defaultUsagePath());
  const disabledProviders = allProviders.filter((p) => {
    const cfgProvider = cfg.providers[p];
    return !(cfgProvider?.enabled ?? PROVIDERS[p]?.enabled ?? true);
  });
  const providerCount = Object.keys(providers).length;
  const totalCount = allProviders.length;
  console.log(`freemaxxing status - ${providerCount}/${totalCount} providers enabled (${disabledProviders.length} disabled)`);
  if (providerCount === 0) {
    console.log("");
    for (const line of noProvidersHint()) console.log(line);
    return;
  }
  console.log("");
  const providerCaps = mergedProviderCaps(cfg);
  const groups = new Map<string, RegistryEntry[]>();
  for (const entry of [
    ...applyModelLimits(REGISTRY, cfg.modelLimits),
    ...buildLocalRegistry(cfg.localModels ?? []),
  ]) {
    if (!providers[entry.provider]) continue;
    const list = groups.get(entry.provider) ?? [];
    list.push(entry);
    groups.set(entry.provider, list);
  }
  const now = Date.now();
  const colNames = ["Model", "Tier", "Speed", "Tools", "Ctx", "State", "Usage", "Tags"];
  const table = new Table({
    columns: colNames.map((n) => ({ name: n, alignment: n === "Ctx" ? "right" as const : "left" as const })),
  });
  for (const [provider, entries] of groups) {
    const caps = providerCaps[provider];
    if (caps) {
      const dispName = disabledProviders.includes(provider) ? `${provider} [disabled]` : provider;
      console.log(formatPoolLine(
        dispName, caps, aggregateProvider(usageMap, provider),
        states.get(poolKey(provider)) ?? { state: "ok" }, entries.length, now,
      ));
    }
    for (const entry of entries) {
      const values = formatStatusRow(entry, states.get(entry.id) ?? { state: "ok" }, now, usageMap.get(entry.id));
      const row: Record<string, string> = {};
      colNames.forEach((n, i) => { row[n] = values[i]; });
      table.addRow(row);
    }
  }
  console.log(table.render());
}

export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "serve";
  const allProviders = Object.keys(PROVIDERS);
  if (cmd === "status") {
    if (argv.includes("--reliability")) {
      await printReliabilityTable();
    } else {
      await printStatus();
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
      // The wizard may have written keys to ~/.freemaxxing/.env — pick them up.
      env = loadEnv(defaultEnvPath(), process.env as Record<string, string | undefined>);
      providers = activeProviders(cfg, env);
    }
    bindStateFile(defaultStatePath()); // spec 4.6: cooldowns/exhaustion survive restarts
    bindUsageFile(defaultUsagePath()); // every served request is persisted as it happens
    bindMalformedFile(defaultMalformedPath()); // quality events survive nothing — append-only log
    bindReliabilityFile(defaultReliabilityPath()); // outcomes survive restarts like usage counters
    const registry = [
      ...applyModelLimits(REGISTRY, cfg.modelLimits),
      ...buildLocalRegistry(cfg.localModels ?? []),
    ];
    const app = buildServer({
      config: cfg,
      providers,
      aliases: mergedAliases(cfg),
      registry,
      stateMap: loadState(defaultStatePath()),
      usageMap: loadUsage(defaultUsagePath()),
      providerCaps: mergedProviderCaps(cfg),
      reliabilityMap: loadReliability(defaultReliabilityPath(), Date.now(), cfg.reliability),
    });
    await app.listen({ port: cfg.port, host: cfg.host });
    const providerCount = Object.keys(providers).length;
    const totalProviders = Object.keys(PROVIDERS).length;
    console.log(
      `freemaxxing serving ${providerCount}/${totalProviders} providers on http://${cfg.host}:${cfg.port}/v1`,
    );

    // -- Status summary + hints --
    const states = loadState(defaultStatePath());
    const now = Date.now();
    const exhaustedCount = [...states.values()].filter(
      (ms) => effective(ms, now).state === "exhausted",
    ).length;
    const cooldownCount = [...states.values()].filter(
      (ms) => effective(ms, now).state === "cooldown",
    ).length;
    if (exhaustedCount > 0 || cooldownCount > 0) {
      console.log("");
      const parts: string[] = [];
      if (exhaustedCount > 0) parts.push(`${exhaustedCount} exhausted`);
      if (cooldownCount > 0) parts.push(`${cooldownCount} cooling`);
      console.log(`  Note: ${parts.join(", ")}  ·  freemaxxing status for details`);
      if (exhaustedCount > 0) {
        console.log(`  Fix:   freemaxxing revive <model-id> to clear, or wait for UTC midnight reset`);
      }
    }
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
      process.stderr.write("usage: freemaxxing revive <model-id | provider-name>\n");
      return 64;
    }
    const { removed } = reviveCmd(target, defaultStatePath());
    if (removed.length === 0) console.log(`nothing matched '${target}'`);
    else for (const id of removed) console.log(`revived ${id}`);
    return 0;
  }

  if (cmd === "disable") {
    const provider = argv[1];
    if (!provider) {
      process.stderr.write("usage: freemaxxing disable <provider>\n");
      return 64;
    }
    const configPath = defaultConfigPath();
    if (!fs.existsSync(configPath)) {
      process.stderr.write(`No config found at ${configPath}. Run freemaxxing setup first.\n`);
      return 64;
    }
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as any;
    if (!raw.providers) raw.providers = {};
    if (!raw.providers[provider]) raw.providers[provider] = {};
    raw.providers[provider].enabled = false;
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
    console.log(`Disabled provider '${provider}'`);
    return 0;
  }

  if (cmd === "enable") {
    const provider = argv[1];
    const force = argv.includes("--force");
    if (!provider) {
      process.stderr.write("usage: freemaxxing enable <provider> [--force]\n");
      return 64;
    }
    const configPath = defaultConfigPath();
    if (!fs.existsSync(configPath)) {
      process.stderr.write(`No config found at ${configPath}. Run freemaxxing setup first.\n`);
      return 64;
    }
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as any;
    if (!raw.providers) raw.providers = {};
    if (!raw.providers[provider]) raw.providers[provider] = {};
    raw.providers[provider].enabled = true;
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
    // Verify key exists when not forcing
    if (!force) {
      const envKey = raw.providers[provider].apiKeyEnv ?? DEFAULT_ENV_KEYS[provider];
      if (!envKey && !process.env[envKey]) {
        process.stderr.write(`No API key found for ${provider}. Set it first, or use --force.\n`);
        return 64;
      }
    }
    console.log(`Enabled provider '${provider}'`);
    return 0;
  }

  if (cmd === "providers") {
    const cfg = loadConfig(defaultConfigPath());
    const env = loadEnv(defaultEnvPath(), process.env as Record<string, string | undefined>);
    const act = activeProviders(cfg, env);
    const table = new Table({
      columns: [
        { name: "Provider", alignment: "left" },
        { name: "Status", alignment: "left" },
        { name: "API Key", alignment: "center" },
      ],
    });
    for (const name of allProviders.sort()) {
      const def = PROVIDERS[name];
      const cfgProvider = cfg.providers[name];
      const enabled = cfgProvider?.enabled ?? def.enabled ?? true;
      if (!enabled) {
        table.addRow({ Provider: name, Status: "disabled", "API Key": "—" });
      } else if (act[name]) {
        const isLocal = def.auth !== "bearer";
        table.addRow({ Provider: name, Status: "enabled", "API Key": isLocal ? "✓" : "✓" });
      } else {
        table.addRow({ Provider: name, Status: "enabled (no key)", "API Key": "✗" });
      }
    }
    console.log(table.render());
    return 0;
  }

  process.stderr.write("usage: freemaxxing [serve|status|setup|export-stats|revive|providers]\n");
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
