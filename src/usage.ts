import fs from "node:fs";
import path from "node:path";
import type { UsageMap, UsageRecord } from "./types.js";

export interface UsageDelta {
  requests?: number;
  tokensIn?: number;
  tokensOut?: number;
}

let usageFile: string | null = null;

export function bindUsageFile(file: string | null): void {
  usageFile = file;
}

export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function freshRecord(day: string): UsageRecord {
  return { day, requests: 0, tokensIn: 0, tokensOut: 0 };
}

function rolled(rec: UsageRecord | undefined, now: number): UsageRecord {
  const day = utcDayKey(now);
  if (!rec || rec.day !== day) return freshRecord(day);
  return rec;
}

export function saveUsage(file: string, map: UsageMap): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map), null, 2));
  fs.renameSync(tmp, file);
}

function isUsageRecord(v: unknown): v is UsageRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.day === "string" &&
    typeof r.requests === "number" &&
    typeof r.tokensIn === "number" &&
    typeof r.tokensOut === "number"
  );
}

export function loadUsage(file: string, now: number = Date.now()): UsageMap {
  const map: UsageMap = new Map();
  if (!fs.existsSync(file)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const day = utcDayKey(now);
    for (const [id, rec] of Object.entries(raw)) {
      // stale days are dropped on sight — counters only ever describe today
      if (isUsageRecord(rec) && rec.day === day) map.set(id, rec);
    }
  } catch {
    // corrupt snapshot: start fresh
  }
  return map;
}

export function recordUsage(
  map: UsageMap,
  id: string,
  delta: UsageDelta,
  now: number = Date.now(),
): void {
  const rec = rolled(map.get(id), now);
  rec.requests += delta.requests ?? 0;
  rec.tokensIn += delta.tokensIn ?? 0;
  rec.tokensOut += delta.tokensOut ?? 0;
  map.set(id, rec);
  if (usageFile) saveUsage(usageFile, map);
}

export interface ProviderTotals {
  requests: number;
  tokensIn: number;
  tokensOut: number;
}

export function aggregateProvider(map: UsageMap, provider: string): ProviderTotals {
  const prefix = `${provider}::`;
  const totals: ProviderTotals = { requests: 0, tokensIn: 0, tokensOut: 0 };
  for (const [id, rec] of map) {
    if (!id.startsWith(prefix)) continue;
    totals.requests += rec.requests;
    totals.tokensIn += rec.tokensIn;
    totals.tokensOut += rec.tokensOut;
  }
  return totals;
}