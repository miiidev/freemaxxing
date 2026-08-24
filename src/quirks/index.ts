import type { Failure } from "../types.js";

export interface Quirk {
  classifyFailure(status: number, body: unknown, headers: Headers, now: number): Failure;
}

const RATE_60S: Failure = { kind: "rate", retryAfterMs: 60_000 };
const QUOTA: Failure = { kind: "quota" };
const OUTAGE: Failure = { kind: "outage" };
const BAD_REQUEST: Failure = { kind: "bad_request" };
const RETIRED: Failure = { kind: "retired" };

// Deterministic client errors: the REQUEST is at fault, not the model or
// provider — retrying the same request elsewhere may work, but cooling this
// model down would be wrong, and treating it as transient masks the cause.
const CLIENT_ERROR_STATUSES = new Set([400, 405, 409, 413, 422]);

function bodyStr(body: unknown): string {
  try {
    return typeof body === "string" ? body : JSON.stringify(body) ?? "";
  } catch {
    return "";
  }
}

function matches(body: unknown, re: RegExp): boolean {
  return re.test(bodyStr(body));
}

function retryAfterHeader(headers: Headers, now: number): number | undefined {
  const v = headers.get("retry-after");
  if (!v) return undefined;
  const secs = Number(v);
  if (!Number.isNaN(secs)) return Math.max(0, Math.round(secs * 1000));
  const dateMs = Date.parse(v);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - now);
}

// Shared rules consulted BEFORE provider-specific heuristics, in order:
// status >= 500 -> outage; deterministic client errors -> bad_request (a
// Retry-After header does not rescue these — the request is at fault);
// only then a Retry-After header is honored as an authoritative rate limit.
function base(status: number, body: unknown, headers: Headers, now: number): Failure | null {
  if (status >= 500) return OUTAGE;
  // A 404 on /chat/completions is effectively always "model id unresolved".
  if (status === 404) return RETIRED;
  if (CLIENT_ERROR_STATUSES.has(status)) return BAD_REQUEST;
  const ra = retryAfterHeader(headers, now);
  if (ra !== undefined) return { kind: "rate", retryAfterMs: ra };
  return null;
}

const openrouter: Quirk = {
  classifyFailure(status, body, headers, now) {
    const shared = base(status, body, headers, now);
    if (shared) return shared;
    if (status === 402) return QUOTA;
    if (status === 429 && matches(body, /free-model|exceeded free/i)) return QUOTA;
    return RATE_60S;
  },
};

const groq: Quirk = {
  classifyFailure(status, body, headers, now) {
    const shared = base(status, body, headers, now);
    if (shared) return shared;
    if (status === 429 && matches(body, /tokens per day|\btpd\b/i)) return QUOTA;
    return RATE_60S;
  },
};

const google: Quirk = {
  classifyFailure(status, body, headers, now) {
    const shared = base(status, body, headers, now);
    if (shared) return shared;
    if (status === 429) {
      const details = (body as { error?: { details?: Array<{ retryDelay?: string }> } })
        ?.error?.details;
      const rd = details?.find((d) => typeof d.retryDelay === "string")?.retryDelay;
      if (rd) {
        const secs = Number(rd.replace(/s$/, ""));
        if (!Number.isNaN(secs)) return { kind: "rate", retryAfterMs: secs * 1000 };
      }
      return QUOTA;
    }
    return RATE_60S;
  },
};

const mistral: Quirk = {
  classifyFailure(status, body, headers, now) {
    const shared = base(status, body, headers, now);
    if (shared) return shared;
    if (status === 429 && matches(body, /quota|monthly/i)) return QUOTA;
    return RATE_60S;
  },
};

const github: Quirk = {
  classifyFailure(status, body, headers, now) {
    if (status === 429) {
      const reset = Number(headers.get("x-ratelimit-reset"));
      if (!Number.isNaN(reset) && reset > 0) {
        return { kind: "rate", retryAfterMs: Math.max(0, reset * 1000 - now) };
      }
    }
    return base(status, body, headers, now) ?? RATE_60S;
  },
};

const cerebras: Quirk = {
  classifyFailure(status, body, headers, now) {
    return base(status, body, headers, now) ?? RATE_60S;
  },
};

export const QUIRKS: Record<string, Quirk> = {
  openrouter,
  groq,
  google,
  mistral,
  github,
  cerebras,
};
