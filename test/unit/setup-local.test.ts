import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { runSetup } from "../../src/setup.js";
import { DEFAULT_LOCAL } from "../../src/config.js";

// Never hit real endpoints: reject every key so collect exhausts attempts quickly.
const failFetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-setup-local-"));
  return { envPath: path.join(dir, ".env"), configPath: path.join(dir, "config.json") };
}

async function runWithInput(lines: string[], configPath: string, envPath: string, promptHints?: string[]) {
  const chunks: string[] = [];
  const input = new Readable({ read() {} });
  const output = new Writable({
    write(c: Buffer, _enc, cb) { chunks.push(c.toString()); cb(); },
  });
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => { resolveDone = r; });
  void runSetup({
    envPath, configPath, interactive: true,
    input, output,
    fetchImpl: failFetch,
    openImpl: () => {},
  }).then(resolveDone);
  const fedFor = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const hint = promptHints?.[i];
    if (hint) {
      const need = (fedFor.get(hint) ?? 0) + 1;
      fedFor.set(hint, need);
      const deadline = Date.now() + 2000;
      while ((chunks.join("").split(hint).length - 1) < need && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 2));
      }
    } else {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    input.push(`${lines[i]}\n`);
  }
  input.push(null); // EOF
  const code = await done;
  input.destroy();
  return { code, text: chunks.join("") };
}

describe("setup local-fallback step", () => {
  it("declining writes no config", async () => {
    const { envPath, configPath } = tmpPaths();
    // 1 blank (provider) + 3 blanks (collect/groq) + 4 blanks (4 bonuses) + "n" (local)
    const { text } = await runWithInput(
      ["", "", "", "", "", "", "", "", "n"],
      configPath, envPath,
      [
        "Provider to start with",   // line 1
        "GROQ_API_KEY:",            // line 2
        "GROQ_API_KEY:",            // line 3
        "GROQ_API_KEY:",            // line 4
        "Add google too?",          // line 5
        "Add openrouter too?",      // line 6
        "Add mistral too?",         // line 7
        "Add cerebras too?",        // line 8
        "Configure local fallback", // line 9
      ],
    );
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("accepting with blank prompts saves enabled defaults", async () => {
    const { envPath, configPath } = tmpPaths();
    // 8 blanks + "y" + blank endpoint + blank model
    const { text } = await runWithInput(
      ["", "", "", "", "", "", "", "", "y", "", ""],
      configPath, envPath,
      [
        "Provider to start with",
        "GROQ_API_KEY:",
        "GROQ_API_KEY:",
        "GROQ_API_KEY:",
        "Add google too?",
        "Add openrouter too?",
        "Add mistral too?",
        "Add cerebras too?",
        "Configure local fallback",
        "Endpoint",
        "Model",
      ],
    );
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(parsed.local).toEqual({ enabled: true, endpoint: DEFAULT_LOCAL.endpoint, model: DEFAULT_LOCAL.model });
  });

  it("accepting with custom values saves them", async () => {
    const { envPath, configPath } = tmpPaths();
    // 8 blanks + "y" + custom endpoint + custom model
    const { text } = await runWithInput(
      ["", "", "", "", "", "", "", "", "y", "http://127.0.0.1:8080", "my-model"],
      configPath, envPath,
      [
        "Provider to start with",
        "GROQ_API_KEY:",
        "GROQ_API_KEY:",
        "GROQ_API_KEY:",
        "Add google too?",
        "Add openrouter too?",
        "Add mistral too?",
        "Add cerebras too?",
        "Configure local fallback",
        "Endpoint",
        "Model",
      ],
    );
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(parsed.local).toEqual({ enabled: true, endpoint: "http://127.0.0.1:8080", model: "my-model" });
  });
});