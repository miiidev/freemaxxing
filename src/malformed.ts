import fs from "node:fs";
import path from "node:path";
import { PersistedStore } from "./config.js";

export interface MalformedEvent {
  ts: number;
  model: string;
  reason: string;
}

let file: string | null = null;
let store: PersistedStore | undefined;

/** Wire a PersistedStore into this module (called once from cli.ts serve). */
export function setPersistedStore(s: PersistedStore): void {
  store = s;
}

/** Legacy: bind a malformed file path (kept for backward compatibility). */
export function bindMalformedFile(f: string | null): void {
  file = f;
}

// Append-only audit of quality failures. Reason codes only — response
// content must never touch this file (it feeds anonymized exports later).
export function recordMalformed(modelId: string, reason: string, now: number = Date.now()): void {
  // persist: store first, then legacy file
  if (store) store.appendMalformed({ ts: now, model: modelId, reason });
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts: now, model: modelId, reason })}\n`);
}

export function loadMalformed(f: string): MalformedEvent[] {
  // persist: load from store first
  if (store) return store.loadMalformed();
  // legacy file-based load
  if (!fs.existsSync(f)) return [];
  try {
    const out: MalformedEvent[] = [];
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as MalformedEvent);
      } catch {
        // skip corrupt line
      }
    }
    return out;
  } catch {
    return [];
  }
}