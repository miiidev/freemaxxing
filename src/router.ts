import type { AliasDef, ModelState, RegistryEntry, RequestCtx, Speed } from "./types.js";

export const SPEED_RANK: Record<Speed, number> = { fast: 0, medium: 1, slow: 2 };

export const BUILT_IN_ALIASES: Record<string, AliasDef> = {
  "auto/coding": { tags: ["coding"], requireTools: true },
  "auto/fast": { preferSpeed: true },
  "auto/any": {},
};

export class UnknownAliasError extends Error {
  constructor(public alias: string) {
    super(`Unknown alias: ${alias}`);
    this.name = "UnknownAliasError";
  }
}

export function estimateTokens(body: unknown): number {
  let chars = 0;
  try {
    chars = JSON.stringify(body)?.length ?? 0;
  } catch {
    chars = 0;
  }
  return Math.ceil(chars / 4);
}

export function resolve(
  alias: string,
  aliases: Record<string, AliasDef>,
  registry: RegistryEntry[],
  getState: (id: string) => ModelState,
  ctx: RequestCtx,
): RegistryEntry[] {
  const def = aliases[alias];
  if (!def) throw new UnknownAliasError(alias);

  const tagOk =
    def.tags?.length
      ? (e: RegistryEntry) => (def.tags as string[]).some((t) => e.tags.includes(t))
      : (_e: RegistryEntry) => true;

  // Tools requirement: either the alias demands tools, or the request carries tools.
  const needsTools = def.requireTools === true || ctx.hasTools;
  const toolsOk = (e: RegistryEntry) => (needsTools ? e.tools : true);

  const contextOk = (e: RegistryEntry) =>
    (def.minContext === undefined || e.context >= def.minContext) &&
    ctx.estTokens <= Math.floor(e.context * 0.9);

  const stateOk = (e: RegistryEntry) => getState(e.id).state === "ok";

  const cmp = def.preferSpeed
    ? (a: RegistryEntry, b: RegistryEntry) =>
        SPEED_RANK[a.speed] - SPEED_RANK[b.speed] ||
        a.tier - b.tier ||
        a.id.localeCompare(b.id)
    : (a: RegistryEntry, b: RegistryEntry) =>
        a.tier - b.tier ||
        SPEED_RANK[a.speed] - SPEED_RANK[b.speed] ||
        a.id.localeCompare(b.id);

  return registry.filter(tagOk).filter(toolsOk).filter(contextOk).filter(stateOk).sort(cmp);
}
