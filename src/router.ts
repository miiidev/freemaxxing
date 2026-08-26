import type { AliasDef, DailyCaps, ModelState, RegistryEntry, RequestCtx, Speed, UsageRecord } from "./types.js";
import { effective } from "./state.js";
import { fitsBudget, usedFraction, utcDayKey } from "./usage.js";
import { isDemoted } from "./reliability.js";

export const SPEED_RANK: Record<Speed, number> = { fast: 0, medium: 1, slow: 2 };

export type SkipReason =
  | "tags" | "tools" | "context-too-small"
  | "cooldown" | "exhausted" | "retired"
  | "provider-blocked" | "budget";

export interface ConsideredCandidate {
  id: string;
  excludedBy?: SkipReason;
}

export const BUILT_IN_ALIASES: Record<string, AliasDef> = {
  "auto/coding": { tags: ["coding"], requireTools: true, sessionAffinity: true },
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
  skippedByContext: RegistryEntry[];
  considered: ConsideredCandidate[];
  winnerReason: string;
  widened: boolean;
}

// Requests reserve their model's worst-case output against the window;
// undeclared outputs assume a modest chat-sized completion.
export const OUTPUT_RESERVE_DEFAULT = 4096;

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

  const outReserve = (e: RegistryEntry) => e.maxOutput ?? OUTPUT_RESERVE_DEFAULT;
  const contextOk = (e: RegistryEntry) =>
    (def.minContext === undefined || e.context >= def.minContext) &&
    ctx.estTokens + outReserve(e) <= e.context;

  const stateReason = (e: RegistryEntry): SkipReason | undefined => {
    if (effective(getState(e.id), now).state !== "ok") {
      const ms = effective(getState(e.id), now);
      if (ms.state === "cooldown") return "cooldown";
      if (ms.state === "exhausted") return "exhausted";
      return "retired";
    }
    const ps = ctx.getProviderState?.(e.provider);
    if (ps && effective(ps, now).state !== "ok") return "provider-blocked";
    return undefined;
  };

  // Provider totals are derived lazily per provider to avoid rescanning per candidate.
  // computeProviderTotals is a pure function; getProviderTotals memoizes results.
  const providerTotalsCache = new Map<string, Pick<UsageRecord, "requests" | "tokensIn" | "tokensOut"> | undefined>();
  function computeProviderTotals(provider: string): Pick<UsageRecord, "requests" | "tokensIn" | "tokensOut"> {
    const totals = { requests: 0, tokensIn: 0, tokensOut: 0 };
    for (const other of registry) {
      if (other.provider !== provider) continue;
      const r = ctx.getUsage?.(other.id);
      if (!r || r.day !== utcDayKey(now)) continue;
      totals.requests += r.requests;
      totals.tokensIn += r.tokensIn;
      totals.tokensOut += r.tokensOut;
    }
    return totals;
  }
  function getProviderTotals(provider: string): Pick<UsageRecord, "requests" | "tokensIn" | "tokensOut"> | undefined {
    if (!providerTotalsCache.has(provider)) {
      const caps = ctx.getProviderCaps?.(provider);
      if (!caps) {
        providerTotalsCache.set(provider, undefined);
        return undefined;
      }
      providerTotalsCache.set(provider, computeProviderTotals(provider));
    }
    return providerTotalsCache.get(provider);
  }

  const provCapsOf = (e: RegistryEntry): DailyCaps | undefined => {
    return ctx.getProviderCaps?.(e.provider);
  };

  const budgetOk = (e: RegistryEntry) => {
    if (!harvest) return true;
    const caps = provCapsOf(e);
    const provTotals = caps ? getProviderTotals(e.provider) : undefined;
    return fitsBudget(
      {
        rec: ctx.getUsage?.(e.id),
        modelCaps: e.limits,
        provTotals,
        provCaps: caps,
      },
      ctx.estTokens,
      now,
    );
  };

  const kept: RegistryEntry[] = [];
  const skippedByBudget: RegistryEntry[] = [];
  const skippedByContext: RegistryEntry[] = [];
  const considered: ConsideredCandidate[] = [];

  const tagOk = (e: RegistryEntry) =>
    !def.tags?.length || (def.tags as string[]).some((t) => e.tags.includes(t));
  const needsTools = def.requireTools === true || ctx.hasTools;

  for (const entry of registry) {
    let excludedBy: SkipReason | undefined;
    if (!tagOk(entry)) excludedBy = "tags";
    else if (needsTools && !entry.tools) excludedBy = "tools";
    else if (!contextOk(entry)) excludedBy = "context-too-small";
    else excludedBy = stateReason(entry);

    if (excludedBy) {
      if (excludedBy === "context-too-small") skippedByContext.push(entry);
      considered.push({ id: entry.id, excludedBy });
      continue;
    }
    if (!budgetOk(entry)) {
      skippedByBudget.push(entry);
      considered.push({ id: entry.id, excludedBy: "budget" });
      continue;
    }
    kept.push(entry);
    considered.push({ id: entry.id });
  }

  let widened = false;
  if (kept.length === 0 && skippedByContext.length > 0) {
    const reAdmitted = new Set<string>();
    for (const entry of skippedByContext) {
      if (stateReason(entry) !== undefined) continue;
      if (budgetOk(entry)) {
        kept.push(entry);
        reAdmitted.add(entry.id);
      } else {
        skippedByBudget.push(entry);
      }
    }
    widened = kept.length > 0;
    skippedByContext.length = 0;
    for (let i = 0; i < considered.length; i++) {
      if (considered[i].excludedBy === "context-too-small" && reAdmitted.has(considered[i].id)) {
        considered[i] = { id: considered[i].id };
      }
    }
  }

  const headroom = (e: RegistryEntry) => {
    if (!harvest) return 0;
    const hasCaps = Boolean(e.limits || ctx.getProviderCaps?.(e.provider));
    const provTotals = hasCaps ? getProviderTotals(e.provider) : undefined;
    return usedFraction(
      {
        rec: ctx.getUsage?.(e.id),
        modelCaps: e.limits,
        provTotals,
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

  type LabeledCmp = [label: string, fn: (a: RegistryEntry, b: RegistryEntry) => number];
  const chain: LabeledCmp[] = def.preferSpeed
    ? [
        ["reliability-demoted", (a, b) => demoted(a) - demoted(b)],
        ["speed", (a, b) => SPEED_RANK[a.speed] - SPEED_RANK[b.speed]],
        ["headroom", (a, b) => headroom(a) - headroom(b)],
        ["limited", (a, b) => limitedKey(a) - limitedKey(b)],
        ["tier", (a, b) => a.tier - b.tier],
      ]
    : [
        ["reliability-demoted", (a, b) => demoted(a) - demoted(b)],
        ["tier", (a, b) => a.tier - b.tier],
        ["headroom", (a, b) => headroom(a) - headroom(b)],
        ["limited", (a, b) => limitedKey(a) - limitedKey(b)],
        ["speed", (a, b) => SPEED_RANK[a.speed] - SPEED_RANK[b.speed]],
      ];
  chain.push(["id-tiebreak", (a, b) => a.id.localeCompare(b.id)]);

  kept.sort((a, b) => chain.reduce((acc, [, fn]) => acc || fn(a, b), 0));

  let winnerReason = "sole-candidate";
  if (kept.length > 1) {
    winnerReason = chain.find(([, fn]) => fn(kept[0], kept[1]) !== 0)?.[0] ?? "id-tiebreak";
  }

  return { candidates: kept, skippedByBudget, skippedByContext, considered, winnerReason, widened };
}
