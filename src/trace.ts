import fs from "node:fs";
import path from "node:path";

export interface TraceRecord {
  requestId: string;
  ts: number;
  alias: string;
  sessionKey?: string;
  estTokens: number;
  widened: boolean;
  considered: Array<{ id: string; excludedBy?: string }>;
  picked?: string;
  pickedReason: string;
  attempts: Array<{ model: string; reason: string }>;
  servedBy?: string;
}

// Bounded by design — routing forensics, not an audit archive.
export const TRACE_CAP = 500;

let file: string | null = null;

export function bindTraceFile(f: string | null): void {
  file = f;
}

export function getTraceFile(): string | null {
  return file;
}

export function tracesEnabled(): boolean {
  return file !== null;
}

export function loadTraces(f: string): TraceRecord[] {
  if (!fs.existsSync(f)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r): r is TraceRecord =>
        typeof r === "object" && r !== null &&
        typeof (r as TraceRecord).requestId === "string" &&
        typeof (r as TraceRecord).ts === "number" &&
        typeof (r as TraceRecord).alias === "string")
      .slice(-TRACE_CAP);
  } catch {
    return [];
  }
}

function saveTraces(target: string, records: TraceRecord[]): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records));
  fs.renameSync(tmp, target);
}

export function appendTrace(record: TraceRecord): TraceRecord[] {
  const all = file ? loadTraces(file) : [];
  const next = [...all, record].slice(-TRACE_CAP);
  if (file) saveTraces(file, next);
  return next;
}

export function formatTrace(t: TraceRecord): string {
  const lines: string[] = [];
  lines.push(`${t.requestId}  ${new Date(t.ts).toISOString()}  alias=${t.alias}  estTokens=${t.estTokens}`);
  if (t.sessionKey) lines.push(`session=${t.sessionKey}`);
  if (t.widened) lines.push("context filter widened (nothing fit)");
  lines.push(`picked=${t.picked ?? "-"} (${t.pickedReason})`);
  if (t.servedBy && t.servedBy !== t.picked) lines.push(`served=${t.servedBy}`);
  lines.push("considered:");
  t.considered.forEach((c, i) => {
    lines.push(`  ${c.excludedBy ? `skipped=${c.excludedBy}` : `candidate #${i + 1}`}  ${c.id}`);
  });
  if (t.attempts.length > 0) {
    lines.push("attempts:");
    for (const a of t.attempts) lines.push(`  ${a.model} -> ${a.reason}`);
  }
  return lines.join("\n");
}

export function formatTraceList(records: TraceRecord[]): string[] {
  return records.map(
    (r) => `${r.requestId}  ${new Date(r.ts).toISOString()}  ${r.alias}  -> ${r.picked ?? "-"} (${r.pickedReason})`,
  );
}