import fs from "node:fs";
import path from "node:path";

export interface MalformedEvent {
  ts: number;
  model: string;
  reason: string;
}

let file: string | null = null;

export function bindMalformedFile(f: string | null): void {
  file = f;
}

// Append-only audit of quality failures. Reason codes only — response
// content must never touch this file (it feeds anonymized exports later).
export function recordMalformed(modelId: string, reason: string, now: number = Date.now()): void {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts: now, model: modelId, reason })}\n`);
}

export function loadMalformed(f: string): MalformedEvent[] {
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