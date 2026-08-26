import Fastify, { type FastifyInstance } from "fastify";
import { resolve, estimateTokens, UnknownAliasError, aliasCandidates, OUTPUT_RESERVE_DEFAULT } from "./router.js";
import { execute } from "./executor.js";
import { formatRequestLog } from "./log.js";
import { aggregateProvider, maybeExhaust, maybeExhaustProvider, recordUsage } from "./usage.js";
import { validateCompletion, type ToolSpec } from "./toolcall.js";
import { recordMalformed } from "./malformed.js";
import { recordOutcome, type ReliabilityMap } from "./reliability.js";
import { appendTrace, tracesEnabled, type TraceRecord } from "./trace.js";
import { Readable } from "node:stream";
import { sseModelRewriter, sseAnnotator, sseUsageCapture, sseToolCallGuard } from "./sse.js";
import { localEntry, localProviderDef, probeLocal } from "./local.js";
import { deriveSessionKey, SessionAffinity } from "./session.js";
import { hybridEntry, isPaidEntry, extractCost } from "./hybrid.js";
import type { ActiveProvider, AppConfig, LocalConfig } from "./config.js";
import type { AliasDef, DailyCaps, RegistryEntry, UsageMap, UsageRecord } from "./types.js";
import type { StateMap } from "./state.js";
import type { SpendStore } from "./spend.js";

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
  localCfg?: LocalConfig;
  sessionAffinity?: SessionAffinity;
  spend?: SpendStore;
  liveTraceLog?: boolean;
}

function err(type: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { type, message, ...extra } };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  let reqCounter = 0;
  const newRequestId = (): string => `r${++reqCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const usageMap = deps.usageMap ?? new Map<string, UsageRecord>();
  const providerCaps = deps.providerCaps ?? {};

  // The local tier exists only when configured; its provider def rides along
  // so execute() can attempt it like any cloud provider.
  const providers: Record<string, ActiveProvider> = deps.localCfg?.enabled
    ? { ...deps.providers, local: localProviderDef(deps.localCfg) }
    : deps.providers;

  const affinity = deps.sessionAffinity ?? new SessionAffinity();

  let localProbeMemo: { at: number; ok: boolean } | null = null;
  const LOCAL_PROBE_TTL_MS = 60_000;
  const localAvailable = async (now: number): Promise<boolean> => {
    const lc = deps.localCfg;
    if (!lc?.enabled) return false;
    if (localProbeMemo && now - localProbeMemo.at < LOCAL_PROBE_TTL_MS) return localProbeMemo.ok;
    const ok = await probeLocal(lc, deps.fetchImpl);
    localProbeMemo = { at: now, ok };
    return ok;
  };

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
    const requestId = newRequestId();
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
        },
      );
    } catch (e) {
      if (e instanceof UnknownAliasError) {
        return reply.code(404).send(err("unknown_alias", e.message));
      }
      throw e;
    }

    if (resolved.widened) {
      console.error(`maxout: no candidate fits ~${estTokens} tokens for ${alias}; widened context filter`);
    }

    let candidates = resolved.candidates;
    const aliasDef = deps.aliases[alias];

    // Local tier gate: only after EVERY tag/tools/context-eligible cloud model is in
    // a non-OK state — never preferred over available cloud capacity.
    if (candidates.length === 0 && deps.localCfg?.enabled && aliasDef) {
      const lc = deps.localCfg;
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const tagOk = (e: RegistryEntry) =>
        !aliasDef.tags?.length || (aliasDef.tags as string[]).some((t) => e.tags.includes(t));
      const needsTools = aliasDef.requireTools === true || hasTools;
      const outReserve = (e: RegistryEntry) => e.maxOutput ?? OUTPUT_RESERVE_DEFAULT;
      const contextOk = (e: RegistryEntry) =>
        (aliasDef.minContext === undefined || e.context >= aliasDef.minContext) &&
        estTokens + outReserve(e) <= e.context;
      const eligible = deps.registry.filter(tagOk).filter((e) => (needsTools ? e.tools : true)).filter(contextOk);
      const blocked = (e: RegistryEntry) =>
        liveState(e.id).state !== "ok" ||
        (() => { const ps = liveProviderState(e.provider); return !!ps && ps.state !== "ok"; })();
      if (eligible.length > 0 && eligible.every(blocked) && (await localAvailable(Date.now()))) {
        candidates = [localEntry(lc)];
      }
    }

    // Session stickiness: promote the session's previous model to the front —
    // sort order bends, filters don't. Failover re-sticks via post-success set().
    const sKey = aliasDef?.sessionAffinity === true
      ? deriveSessionKey(request.headers as Record<string, string | string[] | undefined>, body.messages)
      : undefined;
    let affinityApplied = false;
    if (sKey && candidates.length > 1) {
      const sticky = affinity.get(sKey);
      if (sticky) {
        const idx = candidates.findIndex((c) => c.id === sticky);
        if (idx > 0) {
          affinityApplied = true;
          candidates = [candidates[idx], ...candidates.filter((_, i) => i !== idx)];
        }
      }
    }

    // Hybrid tier rides LAST: only injected when all free/local candidates are exhausted.
    // Position-at-end means it is attempted only once every free and local candidate has failed.
    let hyb: typeof deps.config.hybrid;
    let paidEntry: RegistryEntry | undefined;
    if (candidates.length === 0) {
      hyb = deps.config.hybrid;
      if (
        hyb?.enabled === true &&
        deps.spend !== undefined &&
        deps.spend.spentToday(Date.now()) < hyb.dailyCapUSD &&
        providers[hyb.provider] !== undefined
      ) {
        const entry = hybridEntry(hyb);
        if (!candidates.some((c) => c.id === entry.id)) {
          candidates.push(entry);
          paidEntry = entry;
        }
      }
    }

    // Determine if this request needs tool validation.
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
      providers,
      body,
      stateMap: deps.stateMap,
      fetchImpl: deps.fetchImpl,
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
      if (tracesEnabled()) {
        appendTrace({
          requestId,
          ts: started,
          alias,
          ...(sKey ? { sessionKey: sKey } : {}),
          estTokens,
          widened: resolved.widened,
          considered: resolved.considered.map((c) => ({ ...c })),
          pickedReason: "all-exhausted",
          attempts: result.attempts.map((a) => ({ model: a.model, reason: a.reason })),
        });
      }
      return reply.code(503).send(
        err("all_models_exhausted", `No free model available for ${alias} right now.`, {
          attempts: result.attempts,
          skippedByBudget: resolved.skippedByBudget.map((e) => e.id),
        }),
      );
    }

    const servedId = result.servedBy.id;
    const wasSticky = sKey ? affinity.get(sKey) : undefined;
    if (sKey) affinity.set(sKey, servedId);
    console.log(formatRequestLog(++reqCounter, alias, result.attempts, servedId, Date.now() - started));

    const paid = paidEntry !== undefined && isPaidEntry(result.servedBy, hyb!);

    if (tracesEnabled()) {
      const pickedReason = paid
        ? "hybrid-paid"
        : result.servedBy.provider === "local"
          ? "local-fallback"
          : affinityApplied || wasSticky === servedId
            ? "session-affinity"
            : resolved.winnerReason;
      const record: TraceRecord = {
        requestId,
        ts: started,
        alias,
        ...(sKey ? { sessionKey: sKey } : {}),
        estTokens,
        widened: resolved.widened,
        considered: resolved.considered.map((c) => ({ ...c })),
        picked: servedId,
        pickedReason,
        attempts: result.attempts.map((a) => ({ model: a.model, reason: a.reason })),
        servedBy: servedId,
      };
      appendTrace(record);
      if (deps.liveTraceLog) {
        console.error(`trace ${requestId}: ${pickedReason} -> ${servedId}`);
      }
    }

if (body.stream !== true) {
      const json = (await result.response.json()) as Record<string, unknown>;
      json.model = servedId;
      const u = json.usage as Record<string, unknown> | undefined;
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      if (paid) {
        const cost = extractCost(json, hyb!);
        if (cost > 0 && deps.spend) deps.spend.record(cost, Date.now());
      } else {
        recordServed(result.servedBy, {
          tokensIn: num(u?.prompt_tokens) ?? num(u?.total_tokens) ?? estTokens,
          tokensOut: num(u?.completion_tokens) ?? 0,
        });
      }
      reply.header("x-maxout-served-by", servedId);
      reply.header("x-maxout-request-id", requestId);
      if (deps.config.annotateResponses) {
        const choices = json.choices as Array<Record<string, unknown>> | undefined;
        const choice0 = choices?.[0];
        const message = choice0?.message as Record<string, unknown> | undefined;
        if (choice0?.finish_reason === "stop" && typeof message?.content === "string") {
          message.content += `\n\n---\n*maxout: ${servedId}*`;
        }
      }
      if (!paid) note(servedId, true, started);
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
      "x-maxout-request-id": requestId,
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
    head.pipe(capture);
    last.pipe(reply.raw);
    upstream.pipe(rewriter);

    for (const link of [upstream, rewriter, ...(guard ? [guard] : []), capture, ...(tail ? [tail] : [])]) {
      link.on("error", () => {
        if (!reply.raw.writableEnded) {
          if (link === upstream) {
            upstreamDied = true;
            reply.raw.write(`data: {"maxout_error":"upstream_stream_failed"}\n\n`);
          }
          reply.raw.end();
        }
      });
    }

    await new Promise<void>((resolveDone) => {
      for (const link of [reply.raw, upstream, rewriter, ...(guard ? [guard] : []), capture, ...(tail ? [tail] : [])]) {
        link.on("close", () => resolveDone());
      }
    });

    if (paid) {
      if (deps.spend && hyb) {
        const cost = extractCost(
          { usage: { prompt_tokens: capturedUsage?.tokensIn ?? 0, completion_tokens: capturedUsage?.tokensOut ?? 0 } },
          hyb,
        );
        if (cost > 0) deps.spend.record(cost, Date.now());
      }
    } else {
      recordServed(result.servedBy, capturedUsage);
      note(servedId, !upstreamDied && streamVerdictBad === undefined, started,
        upstreamDied ? "stream-error" : streamVerdictBad !== undefined ? "malformed" : undefined);
    }
    return reply;
  });

  return app;
}
