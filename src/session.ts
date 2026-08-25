import { createHash } from "node:crypto";

export const SESSION_HEADER = "x-maxout-session";

// Agents append rather than prepend, so hashing the first two turns yields a
// stable conversation identity without any caller cooperation.
export function deriveSessionKey(
  headers: Record<string, string | string[] | undefined>,
  messages: unknown[],
  firstN = 2,
): string | undefined {
  const explicit = headers[SESSION_HEADER];
  const h = Array.isArray(explicit) ? explicit[0] : explicit;
  if (h) return h.slice(0, 64);
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  return createHash("sha256")
    .update(JSON.stringify(messages.slice(0, firstN)))
    .digest("hex")
    .slice(0, 16);
}

// Insertion-order LRU: get() refreshes recency, set() evicts the oldest
// beyond cap. In-memory only — a restart merely re-selects a winner.
export class SessionAffinity {
  private map = new Map<string, string>();

  constructor(private readonly cap = 256) {}

  get(key: string): string | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, modelId: string): void {
    this.map.delete(key);
    this.map.set(key, modelId);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}