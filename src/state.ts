import fs from "node:fs";
import path from "node:path";
import type { Failure, ModelState, ResetProfile } from "./types.js";

export type StateMap = Map<string, ModelState>;

let stateFile: string | null = null;

export function bindStateFile(file: string | null): void {
  stateFile = file;
}

const DEFAULT_COOLDOWN_MS = 60_000;

export function effective(ms: ModelState, now: number): ModelState {
  if ((ms.state === "cooldown" || ms.state === "exhausted") && ms.until <= now) {
    return { state: "ok" };
  }
  return ms;
}

export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

export function applyFailure(
  _current: ModelState,
  f: Failure,
  _reset: ResetProfile,
  now: number,
): ModelState {
  if (f.kind === "quota") {
    return { state: "exhausted", until: nextUtcMidnight(now) };
  }
  return { state: "cooldown", until: now + (f.retryAfterMs ?? DEFAULT_COOLDOWN_MS) };
}

export function recordFailure(
  map: StateMap,
  id: string,
  f: Failure,
  reset: ResetProfile,
  now: number,
): void {
  const current = map.get(id) ?? ({ state: "ok" } as ModelState);
  map.set(id, applyFailure(effective(current, now), f, reset, now));
  if (stateFile) saveState(stateFile, map);
}

export function saveState(file: string, map: StateMap): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map), null, 2));
  fs.renameSync(tmp, file);
}

export function loadState(file: string, now: number = Date.now()): StateMap {
  const map: StateMap = new Map();
  if (!fs.existsSync(file)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, ModelState>;
    for (const [id, ms] of Object.entries(raw)) {
      const eff = effective(ms, now);
      if (eff.state !== "ok") map.set(id, eff);
    }
  } catch {
    // corrupt snapshot: start fresh
  }
  return map;
}
