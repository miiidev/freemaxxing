import type { AttemptRecord } from "./types.js";

export function formatRequestLog(
  reqNo: number,
  alias: string,
  attempts: AttemptRecord[],
  servedById: string,
  ms: number,
): string {
  const tried = attempts.length
    ? ` tried=${attempts.map((a) => `${a.model}(${a.reason})`).join(",")}`
    : "";
  return `${new Date().toISOString()} req=${reqNo} alias=${alias}${tried} served=${servedById} ms=${ms}`;
}
