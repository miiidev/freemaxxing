import fs from "node:fs";
import path from "node:path";
import { utcDayKey } from "./usage.js";

export interface SpendLedger {
  day: string;
  spentUSD: number;
}

export interface SpendStore {
  spentToday(now: number): number;
  record(usd: number, now: number): void;
}

export function saveLedger(target: string, l: SpendLedger): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2));
  fs.renameSync(tmp, target);
}

export function loadSpend(f: string, now: number = Date.now()): SpendLedger | null {
  if (!fs.existsSync(f)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<SpendLedger>;
    // stale days are money already un-spent again
    if (raw.day !== utcDayKey(now) || typeof raw.spentUSD !== "number") return null;
    return { day: raw.day, spentUSD: raw.spentUSD };
  } catch {
    return null;
  }
}

// filePath null = memory-only (tests, dry inspection); a real path makes the
// cap restart-proof within its UTC day.
export function fileSpendStore(filePath: string | null): SpendStore {
  let mem: SpendLedger | null = null;
  const read = (now: number): SpendLedger | null =>
    filePath ? loadSpend(filePath, now) : mem && mem.day === utcDayKey(now) ? mem : null;
  return {
    spentToday(now) {
      return read(now)?.spentUSD ?? 0;
    },
    record(usd, now) {
      const day = utcDayKey(now);
      const cur = read(now);
      const next: SpendLedger =
        cur && cur.day === day ? { day, spentUSD: cur.spentUSD + usd } : { day, spentUSD: usd };
      mem = next;
      if (filePath) saveLedger(filePath, next);
    },
  };
}