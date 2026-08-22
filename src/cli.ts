import { pathToFileURL } from "node:url";
import { buildServer } from "./server.js";
import { REGISTRY } from "./catalog.js";
import {
  loadConfig, loadEnv, activeProviders, mergedAliases,
  defaultConfigPath, defaultStatePath, defaultEnvPath,
} from "./config.js";
import { loadState, effective } from "./state.js";
import type { ModelState, RegistryEntry } from "./types.js";

export function formatStatusRow(e: RegistryEntry, msRaw: ModelState, now: number): string {
  const ms = effective(msRaw, now);
  let state: string;
  if (ms.state === "ok") {
    state = "ok";
  } else if (ms.state === "cooldown") {
    state = `cooldown ${Math.max(0, Math.round((ms.until - now) / 60_000))}m`;
  } else {
    state = `exhausted until ${new Date(ms.until).toISOString().slice(0, 16)}Z`;
  }
  return [
    e.id.padEnd(50),
    `t${e.tier}`,
    e.speed.padEnd(7),
    e.tools ? "tools" : "-",
    String(e.context).padStart(7),
    state.padEnd(28),
    e.tags.join(","),
  ].join("  ");
}

async function printStatus(): Promise<void> {
  const cfg = loadConfig(defaultConfigPath());
  const env = loadEnv(defaultEnvPath(), process.env as Record<string, string | undefined>);
  const providers = activeProviders(cfg, env);
  const states = loadState(defaultStatePath());
  console.log(`freeroll status - ${Object.keys(providers).length}/6 providers have keys`);
  console.log("");
  for (const entry of REGISTRY) {
    if (!providers[entry.provider]) continue;
    console.log(formatStatusRow(entry, states.get(entry.id) ?? { state: "ok" }, Date.now()));
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
    const app = buildServer({
      config: cfg,
      providers,
      aliases: mergedAliases(cfg),
      registry: REGISTRY,
      stateMap: loadState(defaultStatePath()),
    });
    await app.listen({ port: cfg.port, host: cfg.host });
    console.log(
      `freeroll serving ${Object.keys(providers).length}/6 providers on http://${cfg.host}:${cfg.port}/v1`,
    );
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
