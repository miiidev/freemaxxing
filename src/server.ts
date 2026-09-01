import Fastify, { type FastifyInstance } from "fastify";
import { resolve, estimateTokens, UnknownAliasError } from "./router.js";
import { execute } from "./executor.js";
import { formatRequestLog } from "./log.js";
import { aggregateProvider, maybeExhaust, maybeExhaustProvider, recordUsage } from "./usage.js";
import { validateCompletion, type ToolSpec } from "./toolcall.js";
import { recordMalformed } from "./malformed.js";
import { recordOutcome, type ReliabilityMap } from "./reliability.js";
import { Readable } from "node:stream";
import { setState, effective } from "./state.js";
import { sseModelRewriter, sseAnnotator, sseUsageCapture, sseToolCallGuard } from "./sse.js";
import type { ActiveProvider, AppConfig } from "./config.js";
import type { AliasDef, DailyCaps, RegistryEntry, UsageMap, UsageRecord, AttemptRecord } from "./types.js";
import type { StateMap } from "./state.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ServerDeps {
  config: AppConfig;
  providers: Record<string, ActiveProvider>;
  aliases: Record<string, AliasDef>;
  registry: RegistryEntry[];
  stateMap: StateMap;
  fetchImpl?: typeof fetch;
  usageMap?: UsageMap;
  providerCaps?: Record<string, DailyCaps>;
  reliabilityMap?: ReliabilityMap;
}

function err(type: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { type, message, ...extra } };
}

function classifyFailures(attempts: AttemptRecord[]): string {
  let rates = 0, malformed = 0, quotas = 0, noKeys = 0, total = attempts.length;
  for (const a of attempts) {
    if (a.reason.startsWith("rate")) rates++;
    else if (a.reason.startsWith("malformed")) malformed++;
    else if (a.reason.startsWith("quota")) quotas++;
    else if (a.reason === "no-key") noKeys++;
  }
  if (malformed > total / 2) return "mostly_malformed";
  if (rates > total / 2) return "mostly_rate_limited";
  if (quotas > total / 2) return "mostly_budget_exhausted";
  if (noKeys > total / 2) return "mostly_no_key";
  return "unknown";
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  let reqCounter = 0;
  const usageMap = deps.usageMap ?? new Map<string, UsageRecord>();
  const providerCaps = deps.providerCaps ?? {};

  app.get("/v1/models", async () => {
    const aliasData = Object.keys(deps.aliases).map((alias) => ({
      id: alias,
      object: "model",
      maxout_alias: true,
    }));
    const modelData = deps.registry.map((e) => ({ id: e.id, object: "model" }));
    return { object: "list", data: [...aliasData, ...modelData] };
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const started = Date.now();
    const body = request.body as Record<string, unknown> | null;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.code(400).send(err("invalid_request", "messages array is required"));
    }

    const alias = typeof body.model === "string" && body.model ? body.model : "auto/coding";

    // Live view of state with lazy expiry (no timers anywhere).
    const liveState = (id: string) => {
      const ms = deps.stateMap.get(id);
      if (!ms) return { state: "ok" } as const;
      if ((ms.state === "cooldown" || ms.state === "exhausted") && ms.until <= Date.now()) {
        return { state: "ok" } as const;
      }
      return ms;
    };

    const liveProviderState = (provider: string) => {
      const ms = deps.stateMap.get(`pool::${provider}`);
      if (!ms) return undefined;
      if ((ms.state === "cooldown" || ms.state === "exhausted") && ms.until <= Date.now()) {
        return { state: "ok" } as const;
      }
      return ms;
    };

    const estTokens = estimateTokens(body);
    let resolved: ReturnType<typeof resolve>;
    try {
      resolved = resolve(
        alias,
        deps.aliases,
        deps.registry,
        liveState,
        {
          hasTools: Array.isArray(body.tools) && body.tools.length > 0,
          estTokens,
          harvest: deps.config.harvest === true,
          getUsage: (id) => usageMap.get(id),
          getProviderCaps: (p) => providerCaps[p],
          getProviderState: liveProviderState,
          now: Date.now(),
          pacing: deps.config.pacing,
        },
      );
    } catch (e) {
      if (e instanceof UnknownAliasError) {
        return reply.code(404).send(err("unknown_alias", e.message));
      }
      throw e;
    }
const candidates = resolved.candidates;

    // Determine if this request needs tool validation.
    const aliasDef = deps.aliases[alias];
    const needsTools = aliasDef?.requireTools === true || (Array.isArray(body.tools) && body.tools.length > 0);
    const requestedTools = Array.isArray(body.tools) ? (body.tools as ToolSpec[]) : undefined;

    // Per-request closure: records the served call, then flags the model
    // exhausted proactively if its (or its provider's) budget is now spent.
    function recordServed(entry: RegistryEntry, real?: { tokensIn: number; tokensOut: number }) {
      const now = Date.now();
      recordUsage(usageMap, entry.id, {
        requests: 1,
        tokensIn: real?.tokensIn ?? estTokens,
        tokensOut: real?.tokensOut ?? 0,
      }, now);
      const view = {
        rec: usageMap.get(entry.id),
        modelCaps: entry.limits,
        provTotals: aggregateProvider(usageMap, entry.provider),
        provCaps: providerCaps[entry.provider],
      };
      maybeExhaust(deps.stateMap, entry.id, view, now);
      if (providerCaps[entry.provider]) {
        maybeExhaustProvider(deps.stateMap, entry.provider, view, now);
      }
    }

    // Reliability outcomes are recorded per served model; absent map = inert.
    const relMap = deps.reliabilityMap;
    const relCfg = deps.config.reliability;
    const note = (servedModelId: string, ok: boolean, startedAt: number, kind?: string) => {
      if (!relMap) return;
      recordOutcome(relMap, servedModelId, {
        ts: Date.now(),
        ok,
        ...(kind ? { kind } : {}),
        latencyMs: Date.now() - startedAt,
      }, relCfg);
    };

    // Quality failures count against the model's reliability score too.
    const onMalformed = needsTools
      ? (modelId: string, reason: string) => {
          recordMalformed(modelId, reason);
          if (relMap) {
            recordOutcome(relMap, modelId, {
              ts: Date.now(),
              ok: false,
              kind: "malformed",
              latencyMs: Date.now() - started,
            }, relCfg);
          }
        }
      : undefined;

    const result = await execute({
      candidates,
      providers: deps.providers,
      body,
      stateMap: deps.stateMap,
      fetchImpl: deps.fetchImpl,
      ttfbTimeoutMs: deps.config.ttfbTimeoutMs,
      retryBackoffMs: deps.config.retryBackoffMs,
      inspect: needsTools
        ? async (_entry, upstreamResponse) => {
            const parsed = (await upstreamResponse.json()) as Record<string, unknown>;
            const verdict = validateCompletion(parsed, requestedTools);
            return verdict.ok ? undefined : verdict.reason;
          }
        : undefined,
      onMalformed,
    });

    if (!result.ok) {
      const exhaustedCount = [...deps.stateMap.values()].filter(
        (ms) => effective(ms, Date.now()).state === "exhausted",
      ).length;
      const hint = exhaustedCount > 0
        ? `Run: maxout revive <model-id> to clear exhaustion, or wait for UTC midnight reset`
        : `All models are cooling down - try again later, or run: maxout revive <model-id>`;
      return reply.code(503).send(
        err("all_models_exhausted", `No free model available for ${alias} right now.`, {
          attempts: result.attempts,
          skippedByBudget: resolved.skippedByBudget.map((e) => e.id),
          allExhaustedKind: classifyFailures(result.attempts),
          hint,
        }),
      );
    }

    const servedId = result.servedBy.id;
    console.log(formatRequestLog(++reqCounter, alias, result.attempts, servedId, Date.now() - started));

    if (body.stream !== true) {
      const json = safeJsonParse(await result.response.text()) ?? {};
      json.model = servedId;
      const u = json.usage as Record<string, unknown> | undefined;
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      recordServed(result.servedBy, {
        tokensIn: num(u?.prompt_tokens) ?? num(u?.total_tokens) ?? estTokens,
        tokensOut: num(u?.completion_tokens) ?? 0,
      });
      reply.header("x-maxout-served-by", servedId);
      if (deps.config.annotateResponses) {
        const choices = json.choices as Array<Record<string, unknown>> | undefined;
        const choice0 = choices?.[0];
        const message = choice0?.message as Record<string, unknown> | undefined;
        if (choice0?.finish_reason === "stop" && typeof message?.content === "string") {
          message.content += `\n\n---\n*maxout: ${servedId}*`;
        }
      }
      note(servedId, true, started);
      return json;
    }

    // Streaming: committed to result.servedBy — executor guarantees all
    // failover happened pre-first-byte. Mid-stream failure => single error
    // frame, never another model.
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-maxout-served-by": servedId,
    });

    const upstream = Readable.fromWeb(result.response.body as import("stream/web").ReadableStream);
    const rewriter = sseModelRewriter(servedId);
    let capturedUsage: { tokensIn: number; tokensOut: number } | undefined;
    const capture = sseUsageCapture((u) => { capturedUsage = u; });

    let upstreamDied = false;
    let streamVerdictBad: string | undefined;
    const guard = needsTools
      ? sseToolCallGuard({
          tools: requestedTools,
          onVerdict: (v) => {
            if (!v.ok) {
              streamVerdictBad = v.reason ?? "unknown";
              recordMalformed(servedId, streamVerdictBad);
              setState(deps.stateMap, servedId, {
                state: "cooldown",
                until: Date.now() + 60_000,
                reason: "malformed",
              });
            }
          },
        })
      : undefined;

    // Build the transform chain: rewriter -> [guard?] -> capture -> [annotator?] -> reply.raw
    const head = guard ? rewriter.pipe(guard) : rewriter;
    const tail = deps.config.annotateResponses ? sseAnnotator(servedId) : null;
    const last = tail ?? capture;
    if (tail) {
      capture.pipe(tail);
    }

    // Attach error handlers before data flow starts
    for (const link of [upstream, rewriter, ...(guard ? [guard] : []), capture, ...(tail ? [tail] : [])]) {
      link.on("error", () => {
        if (!reply.raw.writableEnded) {
          if (link === upstream) {
            upstreamDied = true;
            const hint = deps.stateMap.size > 0
              ? `Run: maxout revive <model-id> to clear exhaustion`
              : `Run: maxout setup to add providers`;
            reply.raw.write(`data: {"maxout_error":"upstream_stream_failed","hint":"${hint}"}\n\n`);
          }
          reply.raw.end();
        }
      });
    }

    // Now establish pipes (data starts flowing)
    head.pipe(capture);
    last.pipe(reply.raw);
    upstream.pipe(rewriter);

    await new Promise<void>((resolveDone) => {
      for (const link of [reply.raw, upstream, rewriter, ...(guard ? [guard] : []), capture, ...(tail ? [tail] : [])]) {
        link.on("close", () => resolveDone());
      }
    });

    note(servedId, !upstreamDied && streamVerdictBad === undefined, started,
      upstreamDied ? "stream-error" : streamVerdictBad !== undefined ? "malformed" : undefined);
    recordServed(result.servedBy, capturedUsage);
    return reply;
  });

  return app;
}
