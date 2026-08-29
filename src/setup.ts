export interface SetupProvider {
  name: string;
  envVar: string;
  signupUrl?: string;  // optional — null for local provider
  baseURL: string;
}

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { joinURL } from "./url.js";

export interface LocalModelConfig {
  name: string;        // e.g., "qwen2.5-coder:3b"
  description: string; // human-readable description
}

/** Pre-configured local model options */
export const LOCAL_MODEL_OPTIONS: LocalModelConfig[] = [
  { name: "qwen2.5-coder:3b", description: "Qwen 2.5 Coder 3B (code specialist)" },
  { name: "phi4-mini:latest", description: "Phi 4 Mini (general purpose)" },
  { name: "llama3.2:latest", description: "Llama 3.2 (general purpose)" },
  { name: "mistral:latest", description: "Mistral (fast general purpose)" },
  { name: "gemma:latest", description: "Gemma (Google's model)" },
];

// Ordered by onboarding friction — groq is the recommended first key.
// GitHub Models omitted: provider retired July 2026.
export const SETUP_PROVIDERS: SetupProvider[] = [
  { name: "groq", envVar: "GROQ_API_KEY", signupUrl: "https://console.groq.com/keys", baseURL: "https://api.groq.com/openai/v1" },
  { name: "google", envVar: "GEMINI_API_KEY", signupUrl: "https://aistudio.google.com/apikey", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" },
  { name: "openrouter", envVar: "OPENROUTER_API_KEY", signupUrl: "https://openrouter.ai/settings/keys", baseURL: "https://openrouter.ai/api/v1" },
  { name: "mistral", envVar: "MISTRAL_API_KEY", signupUrl: "https://console.mistral.ai/api-keys", baseURL: "https://api.mistral.ai/v1" },
  { name: "cerebras", envVar: "CEREBRAS_API_KEY", signupUrl: "https://cloud.cerebras.ai", baseURL: "https://api.cerebras.ai/v1" },
  { name: "local", envVar: "LOCAL_API_KEY", signupUrl: undefined, baseURL: "http://localhost:11434" },
];

// Whole-file rewrite after merge: keep lines we don't manage verbatim,
// replace every definition of an updated key with exactly one new line.
export function buildEnvContent(
  existing: string | undefined,
  updates: Record<string, string>,
): string {
  const kept: string[] = [];
  for (const rawLine of (existing ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!m || m[1] in updates) continue;
    kept.push(line);
  }
  for (const [k, v] of Object.entries(updates)) kept.push(`${k}=${v}`);
  return `${kept.sort().join("\n")}\n`;
}

export async function listInstalledLocalModels(
  baseURL: string,
  fetchImpl: typeof fetch,
  out: (...lines: string[]) => void
): Promise<Set<string>> {
  const installed = new Set<string>();
  try {
    const res = await fetchImpl(joinURL(baseURL, "/api/tags"), {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return installed;
    const data = (await res.json()) as { models: { name: string }[] };
    data.models.forEach((m) => installed.add(m.name));
  } catch {
    out(`⚠ Could not reach Ollama at ${baseURL}; assuming no models installed`);
  }
  return installed;
}

export interface KeyValidation {
  ok: boolean;
  detail?: string;
}

export async function validateKey(
  baseURL: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyValidation> {
  try {
    const res = await fetchImpl(joinURL(baseURL, "/models"), {
      headers: { authorization: `Bearer ${key}` },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, detail: "invalid key" };
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function saveEnv(envPath: string, provider: SetupProvider, key: string): Promise<void> {
  const existing = fsSync.existsSync(envPath)
    ? await fs.readFile(envPath, "utf8")
    : undefined;
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  await fs.writeFile(envPath, buildEnvContent(existing, { [provider.envVar]: key }));
}

export interface SetupOptions {
  envPath: string;
  interactive: boolean;
  provider?: string;
  key?: string;
  input?: Readable;
  output?: Writable;
  fetchImpl?: typeof fetch;
  openImpl?: (url: string) => void;
}

export async function runSetup(opts: SetupOptions): Promise<number> {
  if (!opts.interactive) {
    const provider = SETUP_PROVIDERS.find((p) => p.name === opts.provider);
    if (!opts.provider || !provider) return 64;
    if (!opts.key) return 64;
    if (provider.name === "local") {
      // Save a dummy key for local — the executor will skip auth
      await saveEnv(opts.envPath, provider, "local");
      process.stderr.write(`saved ${provider.envVar} to ${opts.envPath}\n`);
      process.stderr.write("start serving: node dist/cli.js serve\n");
      return 0;
    }
    const verdict = await validateKey(provider.baseURL, opts.key, opts.fetchImpl);
    if (!verdict.ok) {
      process.stderr.write(`key rejected (${verdict.detail}); nothing was written\n`);
      return 1;
    }
    await saveEnv(opts.envPath, provider, opts.key);
    process.stderr.write(`saved ${provider.envVar} to ${opts.envPath}\n`);
    process.stderr.write("start serving: node dist/cli.js serve\n");
    return 0;
  }

  // CLI invocation passes no streams — fall back to the real terminal.
  const rl = readline.createInterface({
    input: opts.input ?? process.stdin,
    output: opts.output ?? process.stdout,
  });
  // Informational text goes straight to the output stream — readline's own
  // write path is unreliable for non-TTY streams. Safe after EOF: only the
  // interface is dead, not the underlying stream.
  const rawOut = opts.output ?? process.stdout;
  let inputClosed = false;
  const out = (...lines: string[]) => {
    try {
      rawOut.write(lines.join("\n") + "\n");
    } catch {
      // output stream closed — nothing more to show
    }
  };
  // EOF (Ctrl-D / scripted streams ending early) must terminate prompts
  // gracefully instead of leaving an unanswered question pending forever.
  const closed = new Promise<never>((_, reject) => {
    rl.on("close", () => {
      inputClosed = true;
      reject(new Error("input-closed"));
    });
  });
  const ask = async (prompt: string): Promise<string> => {
    try {
      return (await Promise.race([rl.question(prompt), closed])).trim();
    } catch {
      return "";
    }
  };

  try {
    out(
      "maxout setup",
      "",
      "One free provider is enough to start. Recommended: Groq (fast signup, generous free tier).",
      "Providers:",
      ...SETUP_PROVIDERS.map((p, i) => `  ${i + 1}. ${p.name}`),
    );

    const pickName = await ask(`Provider to start with [${SETUP_PROVIDERS[0].name}]: `);
    const chosenIdx = pickName === ""
      ? 0
      : Number.isNaN(Number(pickName))
        ? SETUP_PROVIDERS.findIndex((p) => p.name === pickName.toLowerCase())
        : Number(pickName) - 1;
    if (chosenIdx < 0 || chosenIdx >= SETUP_PROVIDERS.length) {
      out(`unknown provider '${pickName}'`);
      return 1;
    }
    const rest = [...SETUP_PROVIDERS];
    const [first] = rest.splice(chosenIdx, 1);

    const collect = async (provider: SetupProvider): Promise<boolean> => {
      out("", `Opening ${provider.signupUrl ?? provider.baseURL}`, "(paste an API key when you have one)");
      try {
        opts.openImpl?.(provider.signupUrl ?? provider.baseURL);
      } catch {
        // opening a browser is best-effort
      }
      for (let attempt = 1; attempt <= 3; attempt++) {
        const key = await ask(`${provider.envVar}: `);
        if (!key) continue;
        // Local provider: no key validation needed, just save the URL and ask about models
        if (provider.name === "local") {
          // Detect which models are already installed in Ollama
          const installedModels = await listInstalledLocalModels(
            provider.baseURL,
            opts.fetchImpl ?? fetch,
            out
          );
          // Ask which local models to enable
          out("");
          out("Available local models (Ollama/llama.cpp):");
          LOCAL_MODEL_OPTIONS.forEach((m, i) => {
            const status = installedModels.has(m.name) ? "✓ installed" : "✗ not installed";
            out(`  ${i + 1}. ${m.name}  ${status}`);
          });
          out("  0. Skip (no local models enabled)");

          const input = await ask(`Select models (comma-separated numbers, or 0 to skip): `);
          if (input.trim() === "0") {
            await saveEnv(opts.envPath, provider, key);
            out(`saved ${provider.envVar} (local mode)`);
            out("No local models enabled.");
            return true;
          }

          const choices = input.split(",").map((s) => s.trim()).filter((s) => s !== "");
          const selected: string[] = [];
          for (const choice of choices) {
            const idx = Number(choice) - 1;
            if (idx >= 0 && idx < LOCAL_MODEL_OPTIONS.length) {
              selected.push(LOCAL_MODEL_OPTIONS[idx].name);
            } else {
              out(`Invalid selection: ${choice}`);
            }
          }

          // Auto-pull missing models
          const toPull = selected.filter((m) => !installedModels.has(m));
          if (toPull.length > 0) {
            out(`\nDownloading missing local models...`);
            for (const model of toPull) {
              out(`\n▶ ollama pull ${model}`);
              const { spawn } = await import("node:child_process");
              const child = spawn("ollama", ["pull", model], { stdio: "inherit" });
              await new Promise<void>((resolve) => child.on("exit", resolve));
              if (child.exitCode !== 0) {
                out(`⚠ Failed to pull ${model} — run: ollama pull ${model}`);
                // Remove from selected so it's not recorded
                selected.splice(selected.indexOf(model), 1);
              }
            }
          }

          await saveEnv(opts.envPath, provider, key);
          // Store model selection in config
          if (selected.length > 0) {
            const configPath = path.join(os.homedir(), ".maxout", "config.json");
            let config: any = {};
            if (fsSync.existsSync(configPath)) {
              try {
                config = JSON.parse(await fs.readFile(configPath, "utf8"));
              } catch {
                config = {};
              }
            }
            config.localModels = selected;
            if (!config.aliases) config.aliases = {};
            for (const aliasName of ["autoAny", "autoFast", "autoCoding"]) {
              const alias = config.aliases[aliasName];
              if (alias && Array.isArray(alias.providers) && !alias.providers.includes("local")) {
                alias.providers.push("local");
              }
            }
            await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
            out(`Saved local model config: ${selected.join(", ")}`);
          }
          out(`saved ${provider.envVar} (local mode)`);
          out(`Enabled local models: ${selected.length > 0 ? selected.join(", ") : "none"}`);
          return true;
        }
        const verdict = await validateKey(provider.baseURL, key, opts.fetchImpl);
        if (verdict.ok) {
          await saveEnv(opts.envPath, provider, key);
          out(`saved ${provider.envVar}`);
          return true;
        }
        out(`attempt ${attempt}/3: ${verdict.detail}`);
      }
      out(`giving up on ${provider.name} for now`);
      return false;
    };

    let saved = (await collect(first)) ? 1 : 0;
    for (const bonus of rest) {
      if (inputClosed) break; // EOF: take the one-provider win and finish
      const wantsMore = (await ask(`Add ${bonus.name} too? [y/N]: `)).toLowerCase();
      if (wantsMore !== "y") continue;
      if (inputClosed) break;
      if (await collect(bonus)) saved++;
    }

    out(
      "",
      saved > 0
        ? `Done — ${saved} provider key(s) in ${opts.envPath}. Start with: node dist/cli.js serve`
        : "No keys saved. Re-run maxout setup whenever you're ready.",
    );
    return saved > 0 ? 0 : 1;
  } finally {
    rl.close();
  }
}