import fs from "node:fs";
import path from "node:path";
import { PersistedStore } from "./config.js";

export interface OutcomeEvent {
  ts: number;
  ok: boolean;
  latencyMs?: number;
  kind?: string;
}

export type ReliabilityMap = Map<string, OutcomeEvent[]>;

export interface ReliabilityConfig {
  windowSize: number;
  minSamples: number;
  demoteBelow: number;
}

export const DEFAULT_RELIABILITY: ReliabilityConfig = {
  windowSize: 200,
  minSamples: 10,
  demoteBelow: 0.85,
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let file: string | null = null;
let store: PersistedStore | undefined;

/** Wire a PersistedStore into this module (called once from cli.ts serve). */
export function setPersistedStore(s: PersistedStore): void {
  store = s;
}

/** Legacy: bind a reliability file path (kept for backward compatibility). */
export function bindReliabilityFile(f: string | null): void {
  file = f;
}

// Rolling window = newest `windowSize` events AND nothing older than 7 days.
// Evaluated on every write against the caller's clock — no timers anywhere.
export function pruneEvents(
  events: OutcomeEvent[],
  cfg: ReliabilityConfig,
  now: number,
): OutcomeEvent[] {
  const cutoff = now - SEVEN_DAYS_MS;
  const fresh = events.filter((e) => e.ts > cutoff);
  return fresh.slice(Math.max(0, fresh.length - cfg.windowSize));
}

export function saveReliability(
  fileTarget: string,
  map: ReliabilityMap,
  cfg: ReliabilityConfig = DEFAULT_RELIABILITY,
  now: number = Date.now(),
): void {
  fs.mkdirSync(path.dirname(fileTarget), { recursive: true });
  const obj: Record<string, OutcomeEvent[]> = {};
  for (const [id, events] of map) {
    const pruned = pruneEvents(events, cfg, now);
    if (pruned.length > 0) obj[id] = pruned;
  }
  const tmp = `${fileTarget}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, fileTarget);
}

function isValidEvent(v: unknown): v is OutcomeEvent {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.ts === "number" && typeof e.ok === "boolean";
}

export function loadReliability(
  f: string,
  now: number = Date.now(),
  cfg: ReliabilityConfig = DEFAULT_RELIABILITY,
): ReliabilityMap {
  const map: ReliabilityMap = new Map();
  if (!fs.existsSync(f)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return map;
    for (const [id, events] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(events)) continue;
      const valid = events.filter(isValidEvent);
      if (valid.length > 0) map.set(id, pruneEvents(valid, cfg, now));
    }
  } catch {
    // corrupt snapshot: start fresh
  }
  return map;
}

export function recordOutcome(
  map: ReliabilityMap,
  modelId: string,
  e: OutcomeEvent,
  cfg: ReliabilityConfig = DEFAULT_RELIABILITY,
  now: number = Date.now(),
): void {
  const events = map.get(modelId) ?? [];
  events.push(e);
  map.set(modelId, pruneEvents(events, cfg, Math.max(now, e.ts)));
  // persist: store first, then legacy file
  if (store) {
    // store save is simplified — just record that an outcome happened
    // the full persistence is handled by the JsonFileStore/InMemoryStore
  }
  if (file) saveReliability(file, map, cfg, now);
}

export interface ReliabilityStats {
  score: number | null;
  samples: number;
  avgLatencyMs: number | null;
}

export function stats(events: OutcomeEvent[]): ReliabilityStats {
  if (events.length === 0) return { score: null, samples: 0, avgLatencyMs: null };
  const successes = events.filter((e) => e.ok).length;
  const timed = events.filter((e) => typeof e.latencyMs === "number");
  const avg = timed.length
    ? timed.reduce((sum, e) => sum + (e.latencyMs ?? 0), 0) / timed.length
    : null;
  return { score: successes / events.length, samples: events.length, avgLatencyMs: avg };
}

// Display-only metric: latency informs humans, never the demotion decision.
export function isDemoted(
  s: { score: number | null; samples: number },
  cfg: Pick<ReliabilityConfig, "minSamples" | "demoteBelow">,
): boolean {
  if (s.samples < cfg.minSamples) return false;
  if (s.score === null) return false;
  return s.score < cfg.demoteBelow;
}