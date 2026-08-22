import Fastify, { type FastifyInstance } from "fastify";
import { resolve, estimateTokens, UnknownAliasError } from "./router.js";
import { execute } from "./executor.js";
import { formatRequestLog } from "./log.js";
import type { ActiveProvider, AppConfig } from "./config.js";
import type { AliasDef, RegistryEntry } from "./types.js";
import type { StateMap } from "./state.js";

export interface ServerDeps {
  config: AppConfig;
  providers: Record<string, ActiveProvider>;
  aliases: Record<string, AliasDef>;
  registry: RegistryEntry[];
  stateMap: StateMap;
  fetchImpl?: typeof fetch;
}

function err(type: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { type, message, ...extra } };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  let reqCounter = 0;

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

    let candidates: RegistryEntry[];
    try {
      candidates = resolve(
        alias,
        deps.aliases,
        deps.registry,
        liveState,
        {
          hasTools: Array.isArray(body.tools) && body.tools.length > 0,
          estTokens: estimateTokens(body),
        },
      );
    } catch (e) {
      if (e instanceof UnknownAliasError) {
        return reply.code(404).send(err("unknown_alias", e.message));
      }
      throw e;
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
        }),
      );
    }

    const servedId = result.servedBy.id;
    console.log(formatRequestLog(++reqCounter, alias, result.attempts, servedId, Date.now() - started));

    if (body.stream !== true) {
      const json = (await result.response.json()) as Record<string, unknown>;
      json.model = servedId;
      reply.header("x-freeroll-served-by", servedId);
      return json;
    }

    // Placeholder passthrough — Task 9 replaces this branch.
    reply.header("content-type", "text/event-stream");
    reply.header("x-freeroll-served-by", servedId);
    return reply.send(result.response.body);
  });

  return app;
}