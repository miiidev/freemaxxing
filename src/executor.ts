import { QUIRKS } from "./quirks/index.js";
import { recordFailure, type StateMap } from "./state.js";
import type { ActiveProvider } from "./config.js";
import type { AttemptRecord, RegistryEntry } from "./types.js";

export interface ExecuteArgs {
  candidates: RegistryEntry[];
  providers: Record<string, ActiveProvider>;
  body: Record<string, unknown>;
  stateMap: StateMap;
  ttfbTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type ExecuteResult =
  | { ok: true; response: Response; servedBy: RegistryEntry; attempts: AttemptRecord[] }
  | { ok: false; attempts: AttemptRecord[] };

const DEFAULT_TTFB_MS = 30_000;

export function joinURL(base: string, pathPart: string): string {
  return base.replace(/\/+$/, "") + pathPart;
}

// Failover happens here only — i.e. before any byte reaches the client.
// Once a Response is returned, the caller owns the stream and never switches models.
export async function execute(args: ExecuteArgs): Promise<ExecuteResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const attempts: AttemptRecord[] = [];

  for (const entry of args.candidates) {
    const provider = args.providers[entry.provider];
    if (!provider) {
      attempts.push({ model: entry.id, reason: "no-key" });
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), args.ttfbTimeoutMs ?? DEFAULT_TTFB_MS);

    let response: Response;
    try {
      const { model: _ignored, ...upstreamBody } = args.body;
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
      attempts.push({ model: entry.id, reason: "outage" });
      recordFailure(args.stateMap, entry.id, { kind: "outage" }, provider.resetProfile, Date.now());
      continue;
    }
    clearTimeout(timer);

    if (response.ok) {
      return { ok: true, response, servedBy: entry, attempts };
    }

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
    attempts.push({ model: entry.id, reason: failure.kind });
    recordFailure(args.stateMap, entry.id, failure, provider.resetProfile, Date.now());
  }

  return { ok: false, attempts };
}
