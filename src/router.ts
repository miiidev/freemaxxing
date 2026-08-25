import type { AliasDef, DailyCaps, ModelState, RegistryEntry, RequestCtx, Speed, UsageRecord } from "./types.js";
import { effective } from "./state.js";
import { fitsBudget, usedFraction, utcDayKey } from "./usage.js";
import { isDemoted } from "./reliability.js";

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

// Tag+tools eligibility — also the server's local-fallback gate input, which
// must consider exactly the set resolve() would have considered pre-context.
export function aliasCandidates(
  def: AliasDef,
  registry: RegistryEntry[],
  hasTools: boolean,
): RegistryEntry[] {
  const tagOk = def.tags?.length
    ? (e: RegistryEntry) => (def.tags as string[]).some((t) => e.tags.includes(t))
    : (_e: RegistryEntry) => true;
  const needsTools = def.requireTools === true || hasTools;
  return registry.filter(tagOk).filter((e) => (needsTools ? e.tools : true));
}

export interface ResolveResult {
  candidates: RegistryEntry[];
  skippedByBudget: RegistryEntry[];
}

export function resolve(
  alias: string,
  aliases: Record<string, AliasDef>,
  registry: RegistryEntry[],
  getState: (id: string) => ModelState,
  ctx: RequestCtx,
): ResolveResult {
  const def = aliases[alias];
  if (!def) throw new UnknownAliasError(alias);

  const harvest = ctx.harvest === true;
  const now = ctx.now ?? Date.now();

  const contextOk = (e: RegistryEntry) =>
    (def.minContext === undefined || e.context >= def.minContext) &&
    ctx.estTokens <= Math.floor(e.context * 0.9);

  const stateOk = (e: RegistryEntry) => {
    if (getState(e.id).state !== "ok") return false;
    const ps = ctx.getProviderState?.(e.provider);
    return !ps || effective(ps, now).state === "ok";
  };

  // provider totals are derived lazily per provider to avoid rescanning per candidate
  const provCache = new Map<string, Pick<UsageRecord, "requests" | "tokensIn" | "tokensOut"> | null>();
  const provCapsOf = (e: RegistryEntry): DailyCaps | undefined => {
    const caps = ctx.getProviderCaps?.(e.provider);
    if (!caps) return undefined;
    if (!provCache.has(e.provider)) {
      const totals = { requests: 0, tokensIn: 0, tokensOut: 0 };
      for (const other of registry) {
        if (other.provider !== e.provider) continue;
        const r = ctx.getUsage?.(other.id);
        if (!r || r.day !== utcDayKey(now)) continue;
        totals.requests += r.requests;
        totals.tokensIn += r.tokensIn;
        totals.tokensOut += r.tokensOut;
      }
      provCache.set(e.provider, totals);
    }
    return { ...caps };
  };

  const budgetOk = (e: RegistryEntry) => {
    if (!harvest) return true;
    const caps = provCapsOf(e);
    return fitsBudget(
      {
        rec: ctx.getUsage?.(e.id),
        modelCaps: e.limits,
        provTotals: caps ? (provCache.get(e.provider) ?? undefined) : undefined,
        provCaps: caps,
      },
      ctx.estTokens,
      now,
    );
  };

  const kept: RegistryEntry[] = [];
  const skippedByBudget: RegistryEntry[] = [];
  const loopInput = aliasCandidates(def, registry, ctx.hasTools);
  for (const entry of loopInput.filter(contextOk).filter(stateOk)) {
    if (budgetOk(entry)) kept.push(entry);
    else skippedByBudget.push(entry);
  }

  const headroom = (e: RegistryEntry) => {
    if (!harvest) return 0;
    const hasCaps = Boolean(e.limits || ctx.getProviderCaps?.(e.provider));
    // provCapsOf must run BEFORE reading provCache — it populates the cache.
    if (hasCaps) provCapsOf(e);
    return usedFraction(
      {
        rec: ctx.getUsage?.(e.id),
        modelCaps: e.limits,
        provTotals: hasCaps ? (provCache.get(e.provider) ?? undefined) : undefined,
        provCaps: ctx.getProviderCaps?.(e.provider),
      },
      now,
    );
  };

  const limitedKey = (e: RegistryEntry) => (e.limits ? 1 : 0);

  // Self-healing override: proven-flaky models sink below everyone, whatever
  // their static tier; under-sampled models are never penalized.
  const demoted = (e: RegistryEntry): number => {
    if (!ctx.getReliability || !ctx.reliabilityCfg) return 0;
    const s = ctx.getReliability(e.id);
    if (!s || s.samples < ctx.reliabilityCfg.minSamples || s.score === null) return 0;
    return s.score < ctx.reliabilityCfg.demoteBelow ? 1 : 0;
  };

  const cmp = def.preferSpeed
    ? (a: RegistryEntry, b: RegistryEntry) =>
        demoted(a) - demoted(b) ||
        SPEED_RANK[a.speed] - SPEED_RANK[b.speed] ||
        headroom(a) - headroom(b) ||
        limitedKey(a) - limitedKey(b) ||
        a.tier - b.tier ||
        a.id.localeCompare(b.id)
    : (a: RegistryEntry, b: RegistryEntry) =>
        demoted(a) - demoted(b) ||
        a.tier - b.tier ||
        headroom(a) - headroom(b) ||
        limitedKey(a) - limitedKey(b) ||
        SPEED_RANK[a.speed] - SPEED_RANK[b.speed] ||
        a.id.localeCompare(b.id);

  kept.sort(cmp);
  return { candidates: kept, skippedByBudget };
}
