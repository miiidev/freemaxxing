import Fastify, { type FastifyInstance } from "fastify";
import { resolve, estimateTokens, UnknownAliasError } from "./router.js";
import { execute } from "./executor.js";
import { formatRequestLog } from "./log.js";
import { aggregateProvider, maybeExhaust, recordUsage } from "./usage.js";
import { Readable } from "node:stream";
import { sseModelRewriter, sseAnnotator } from "./sse.js";
import type { ActiveProvider, AppConfig } from "./config.js";
import type { AliasDef, DailyCaps, RegistryEntry, UsageMap, UsageRecord } from "./types.js";
import type { StateMap } from "./state.js";

export interface ServerDeps {
  config: AppConfig;
  providers: Record<string, ActiveProvider>;
  aliases: Record<string, AliasDef>;
  registry: RegistryEntry[];
  stateMap: StateMap;
  fetchImpl?: typeof fetch;
  usageMap?: UsageMap;
  providerCaps?: Record<string, DailyCaps>;
}

function err(type: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { type, message, ...extra } };
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
      freeroll_alias: true,
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
          now: Date.now(),
        },
      );
    } catch (e) {
      if (e instanceof UnknownAliasError) {
        return reply.code(404).send(err("unknown_alias", e.message));
      }
      throw e;
    }
    const candidates = resolved.candidates;

    // Per-request closure: records the served call, then flags the model
    // exhausted proactively if its (or its provider's) budget is now spent.
    function recordServed(entry: RegistryEntry, real?: { tokensIn: number; tokensOut: number }) {
      const now = Date.now();
      recordUsage(usageMap, entry.id, {
        requests: 1,
        tokensIn: real?.tokensIn ?? estTokens,
        tokensOut: real?.tokensOut ?? 0,
      }, now);
      maybeExhaust(deps.stateMap, entry.id, {
        rec: usageMap.get(entry.id),
        modelCaps: entry.limits,
        provTotals: aggregateProvider(usageMap, entry.provider),
        provCaps: providerCaps[entry.provider],
      }, now);
    }

    const result = await execute({
      candidates,
      providers: deps.providers,
      body,
      stateMap: deps.stateMap,
      fetchImpl: deps.fetchImpl,
    });

    if (!result.ok) {
      return reply.code(503).send(
        err("all_models_exhausted", `No free model available for ${alias} right now.`, {
          attempts: result.attempts,
          skippedByBudget: resolved.skippedByBudget.map((e) => e.id),
        }),
      );
    }

    const servedId = result.servedBy.id;
    console.log(formatRequestLog(++reqCounter, alias, result.attempts, servedId, Date.now() - started));

    if (body.stream !== true) {
      const json = (await result.response.json()) as Record<string, unknown>;
      json.model = servedId;
      const u = json.usage as Record<string, unknown> | undefined;
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      recordServed(result.servedBy, {
        tokensIn: num(u?.prompt_tokens) ?? num(u?.total_tokens) ?? estTokens,
        tokensOut: num(u?.completion_tokens) ?? 0,
      });
      reply.header("x-freeroll-served-by", servedId);
      if (deps.config.annotateResponses) {
        const choices = json.choices as Array<Record<string, unknown>> | undefined;
        const choice0 = choices?.[0];
        const message = choice0?.message as Record<string, unknown> | undefined;
        if (choice0?.finish_reason === "stop" && typeof message?.content === "string") {
          message.content += `\n\n---\n*freeroll: ${servedId}*`;
        }
      }
      return json;
    }

    // Streaming: committed to result.servedBy — executor guarantees all
    // failover happened pre-first-byte. Mid-stream failure => single error
    // frame, never another model.
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-freeroll-served-by": servedId,
    });

    const upstream = Readable.fromWeb(result.response.body as import("stream/web").ReadableStream);
    const rewriter = sseModelRewriter(servedId);

    if (deps.config.annotateResponses) {
      const annotator = sseAnnotator(servedId);
      annotator.pipe(reply.raw);
      rewriter.pipe(annotator);
      upstream.pipe(rewriter);
      upstream.on("error", () => {
        if (!reply.raw.writableEnded) {
          reply.raw.write(`data: {"freeroll_error":"upstream_stream_failed"}\n\n`);
          reply.raw.end();
        }
      });
      rewriter.on("error", () => {
        if (!reply.raw.writableEnded) reply.raw.end();
      });
      annotator.on("error", () => {
        if (!reply.raw.writableEnded) reply.raw.end();
      });
      await new Promise<void>((resolveDone) => {
        reply.raw.on("close", () => resolveDone());
        annotator.on("close", () => resolveDone());
      });
    } else {
      rewriter.pipe(reply.raw);
      upstream.pipe(rewriter);
      upstream.on("error", () => {
        if (!reply.raw.writableEnded) {
          reply.raw.write(`data: {"freeroll_error":"upstream_stream_failed"}\n\n`);
          reply.raw.end();
        }
      });
      rewriter.on("error", () => {
        if (!reply.raw.writableEnded) reply.raw.end();
      });
      await new Promise<void>((resolveDone) => {
        reply.raw.on("close", () => resolveDone());
        rewriter.on("close", () => resolveDone());
      });
    }
    return reply;
  });

  return app;
}
