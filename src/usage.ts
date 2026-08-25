import fs from "node:fs";
import path from "node:path";
import type { DailyCaps, UsageMap, UsageRecord } from "./types.js";
import { nextUtcMidnight, setState, poolKey, type StateMap } from "./state.js";

// Newest-wins cap keeps per-record growth bounded; rollover drops the rest.
export const MAX_REQ_TS = 500;

export function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

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
      if (isUsageRecord(rec) && rec.day === day) {
        if (Array.isArray(rec.reqTs)) {
          rec.reqTs = rec.reqTs.filter((t): t is number => typeof t === "number").slice(-MAX_REQ_TS);
        } else {
          delete rec.reqTs;
        }
        map.set(id, rec);
      }
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
  if ((delta.requests ?? 0) > 0) {
    rec.reqTs = [...(rec.reqTs ?? []), now].slice(-MAX_REQ_TS);
  }
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

export interface BudgetView {
  rec?: UsageRecord;
  modelCaps?: DailyCaps;
  provTotals?: Pick<UsageRecord, "requests" | "tokensIn" | "tokensOut">;
  provCaps?: DailyCaps;
}

export function usedFraction(view: BudgetView, now: number = Date.now()): number {
  const rec = rolled(view.rec, now);
  let frac = 0;
  if (view.modelCaps?.rpd) frac = Math.max(frac, rec.requests / view.modelCaps.rpd);
  if (view.modelCaps?.tpd) frac = Math.max(frac, (rec.tokensIn + rec.tokensOut) / view.modelCaps.tpd);
  if (view.provCaps?.rpd && view.provTotals) {
    frac = Math.max(frac, view.provTotals.requests / view.provCaps.rpd);
  }
  if (view.provCaps?.tpd && view.provTotals) {
    frac = Math.max(frac, (view.provTotals.tokensIn + view.provTotals.tokensOut) / view.provCaps.tpd);
  }
  return frac;
}

// each budget level is checked independently; any exhausted level blocks the call
export function fitsBudget(view: BudgetView, estTokens: number, now: number = Date.now()): boolean {
  const rec = rolled(view.rec, now);
  if (view.modelCaps?.rpd !== undefined && (view.modelCaps.rpd - rec.requests) < 1) return false;
  if (view.modelCaps?.tpd !== undefined && (view.modelCaps.tpd - (rec.tokensIn + rec.tokensOut)) < estTokens) {
    return false;
  }
  if (view.provCaps?.rpd !== undefined && view.provTotals &&
      (view.provCaps.rpd - view.provTotals.requests) < 1) {
    return false;
  }
  if (view.provCaps?.tpd !== undefined && view.provTotals &&
      (view.provCaps.tpd - (view.provTotals.tokensIn + view.provTotals.tokensOut)) < estTokens) {
    return false;
  }
  return true;
}

export function maybeExhaust(states: StateMap, id: string, view: BudgetView, now: number): void {
  if (!fitsBudget(view, 1, now)) {
    setState(states, id, { state: "exhausted", until: nextUtcMidnight(now), reason: "daily-cap" });
  }
}

export function maybeExhaustProvider(states: StateMap, provider: string, view: BudgetView, now: number): void {
  if (!fitsBudget(view, 1, now)) {
    setState(states, poolKey(provider), {
      state: "exhausted",
      until: nextUtcMidnight(now),
      reason: "pool",
    });
  }
}