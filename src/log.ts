import type { AttemptRecord } from "./types.js";

export function formatRequestLog(
  reqNo: number,
  alias: string,
  attempts: AttemptRecord[],
  servedById: string,
  ms: number,
  now: number = Date.now(),
): string {
  const tried = attempts.length
    ? ` tried=${attempts.map((a) => `${a.model}(${a.reason})`).join(",")}`
    : "";
  return `${new Date(now).toISOString()} req=${reqNo} alias=${alias}${tried} served=${servedById} ms=${ms}`;
}
