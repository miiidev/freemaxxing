import { QUIRKS } from "./quirks/index.js";
import {
  isProviderBlocked, nextUtcMidnight, poolKey, recordFailure,
  retireModel, setState, type StateMap,
} from "./state.js";
import type { ActiveProvider } from "./config.js";
import type { AttemptRecord, DailyCaps, Failure, RegistryEntry } from "./types.js";

export interface ExecuteArgs {
  candidates: RegistryEntry[];
  providers: Record<string, ActiveProvider>;
  body: Record<string, unknown>;
  stateMap: StateMap;
  ttfbTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  providerCaps?: Record<string, DailyCaps>;
  retryBackoffMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  inspect?: (entry: RegistryEntry, response: Response) => Promise<string | undefined>;
  onMalformed?: (modelId: string, reason: string) => void;
}

export type ExecuteResult =
  | { ok: true; response: Response; servedBy: RegistryEntry; attempts: AttemptRecord[] }
  | { ok: false; attempts: AttemptRecord[] };

const DEFAULT_TTFB_MS = 30_000;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;

export function joinURL(base: string, pathPart: string): string {
  return base.replace(/\/+$/, "") + pathPart;
}

type AttemptOutcome =
  | { kind: "ok"; response: Response }
  | { kind: "fail"; failure: Failure; status?: number; detail?: string };

async function attemptOnce(
  entry: RegistryEntry,
  provider: ActiveProvider,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  ttfbTimeoutMs: number,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ttfbTimeoutMs);
  let response: Response;
  try {
    const { model: _ignored, ...upstreamBody } = body;
    response = await fetchImpl(joinURL(provider.baseURL, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({ ...upstreamBody, model: entry.upstream }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return { kind: "fail", failure: { kind: "outage" } };
  }
  clearTimeout(timer);

  if (response.ok) return { kind: "ok", response };

  const text = await response.text().catch(() => "");
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep raw text as the body for classification
  }
  const quirk = QUIRKS[provider.quirks];
  const failure = quirk
    ? quirk.classifyFailure(response.status, parsed, response.headers, Date.now())
    : ({ kind: "outage" } as const);
  return {
    kind: "fail",
    failure: { ...failure },
    status: response.status,
    detail: snippet(parsed),
  };
}

// Failover happens here only — i.e. before any byte reaches the client.
// Once a Response is returned, the caller owns the stream and never switches models.
export async function execute(args: ExecuteArgs): Promise<ExecuteResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const doSleep = args.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoffMs = args.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const attempts: AttemptRecord[] = [];
  const ttfb = args.ttfbTimeoutMs ?? DEFAULT_TTFB_MS;

  for (const entry of args.candidates) {
    if (isProviderBlocked(args.stateMap, entry.provider, Date.now())) {
      attempts.push({ model: entry.id, reason: "pool-exhausted" });
      continue;
    }

    const provider = args.providers[entry.provider];
    if (!provider) {
      attempts.push({ model: entry.id, reason: "no-key" });
      continue;
    }

    const first = await attemptOnce(entry, provider, args.body, fetchImpl, ttfb);
    if (first.kind === "ok") {
      // Quality gate runs only where failover is still legal: no bytes sent.
      if (args.inspect && args.body.stream !== true) {
        try {
          const reason = await args.inspect(entry, first.response.clone());
          if (reason !== undefined) {
            args.onMalformed?.(entry.id, reason);
            attempts.push({ model: entry.id, reason: `malformed ${reason}` });
            continue;
          }
        } catch {
          // a broken inspector must not break serving
        }
      }
      return { ok: true, response: first.response, servedBy: entry, attempts };
    }
    pushAttempt(attempts, entry.id, first);

    // Deterministic client errors say nothing about model health — move on silently.
    if (first.failure.kind === "bad_request") continue;

    if (first.failure.kind === "retired") {
      retireModel(args.stateMap, entry.id, Date.now());
      continue;
    }

    if (first.failure.kind === "quota") {
      markQuota(args, entry);
      continue;
    }

    if (first.failure.kind === "rate") {
      recordFailure(args.stateMap, entry.id, first.failure, provider.resetProfile, Date.now());
      continue;
    }

    // Transient (outage): one same-model retry after a short backoff.
    await doSleep(backoffMs);
    const second = await attemptOnce(entry, provider, args.body, fetchImpl, ttfb);
    if (second.kind === "ok") {
      return { ok: true, response: second.response, servedBy: entry, attempts };
    }
    pushAttempt(attempts, entry.id, second);
    recordFailure(args.stateMap, entry.id, first.failure, provider.resetProfile, Date.now());
  }

  return { ok: false, attempts };
}

function pushAttempt(
  attempts: AttemptRecord[],
  modelId: string,
  outcome: Extract<AttemptOutcome, { kind: "fail" }>,
): void {
  attempts.push({
    model: modelId,
    reason: outcome.status === undefined
      ? outcome.failure.kind
      : `${outcome.failure.kind} ${outcome.status}`,
    status: outcome.status,
    detail: outcome.detail,
  });
}

function markQuota(args: ExecuteArgs, entry: RegistryEntry): void {
  const now = Date.now();
  const until = nextUtcMidnight(now);
  const pooled = Boolean(args.providerCaps?.[entry.provider]);
  setState(args.stateMap, entry.id, {
    state: "exhausted",
    until,
    reason: pooled ? "pool" : "daily-cap",
  });
  if (pooled) {
    setState(args.stateMap, poolKey(entry.provider), {
      state: "exhausted",
      until,
      reason: "pool",
    });
  }
}

function snippet(body: unknown): string | undefined {
  let s = typeof body === "string" ? body : JSON.stringify(body) ?? "";
  if (!s) return undefined;
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}