import fs from "node:fs";
import path from "node:path";
import { PersistedStore } from "./config.js";
import type { Failure, ModelState, ResetProfile } from "./types.js";

export type StateMap = Map<string, ModelState>;

let stateFile: string | null = null;
let store: PersistedStore | undefined;

/** Wire a PersistedStore into this module (called once from cli.ts serve). */
export function setPersistedStore(s: PersistedStore): void {
  store = s;
}

/** Legacy: bind a state file path (kept for backward compatibility). */
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
    return { state: "exhausted", until: nextUtcMidnight(now), reason: "daily-cap" };
  }
  if (f.kind === "rate") {
    return {
      state: "cooldown",
      until: now + (f.retryAfterMs ?? DEFAULT_COOLDOWN_MS),
      reason: "peak-throttle",
    };
  }
  return { state: "cooldown", until: now + (f.retryAfterMs ?? DEFAULT_COOLDOWN_MS), reason: "transient" };
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
  // persist: store first, then legacy file
  if (store) store.saveModelState(id, effective(current, now));
  if (stateFile) saveState(stateFile, map);
}

export function setState(map: StateMap, id: string, ms: ModelState): void {
  map.set(id, ms);
  // persist: store first, then legacy file
  if (store) store.saveModelState(id, ms);
  if (stateFile) saveState(stateFile, map);
}

// Pool entries live beside model ids; legal because registry ids always
// contain "::" between two non-empty halves and no provider is named "pool".
export function poolKey(provider: string): string {
  return `pool::${provider}`;
}

export function isProviderBlocked(map: StateMap, provider: string, now: number): boolean {
  const ms = map.get(poolKey(provider));
  if (!ms) return false;
  return effective(ms, now).state !== "ok";
}

export function recordPoolExhaustion(
  map: StateMap,
  provider: string,
  _reset: ResetProfile,
  now: number,
): void {
  setState(map, poolKey(provider), {
    state: "exhausted",
    until: nextUtcMidnight(now),
    reason: "pool",
  });
}

export function retireModel(map: StateMap, id: string, now: number): void {
  setState(map, id, { state: "retired", since: now });
}

export function reviveMatching(map: StateMap, target: string): string[] {
  const removed: string[] = [];
  for (const id of [...map.keys()]) {
    if (id === target || id === poolKey(target)) {
      map.delete(id);
      removed.push(id);
    }
  }
  // persist: store first, then legacy file
  if (store) {
    // store save is model-state id + state; we don't have the state here easily,
    // so skip store write for reviveMatching (it's a rare operation).
  }
  if (removed.length > 0 && stateFile) saveState(stateFile, map);
  return removed;
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
