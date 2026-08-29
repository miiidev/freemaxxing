export type Speed = "fast" | "medium" | "slow";

export type FailureKind = "rate" | "quota" | "outage" | "bad_request" | "retired";

export type CooldownReason = "peak-throttle" | "transient" | "malformed";
export type ExhaustReason = "pool" | "daily-cap";

export interface Failure {
  kind: FailureKind;
  retryAfterMs?: number;
}

export interface ResetProfile {
  kind: "daily-utc-midnight";
}

export interface ProviderDef {
  baseURL: string;
  auth: "bearer";
  quirks: string;
  resetProfile: ResetProfile;
  limits?: DailyCaps;
}

export interface RegistryEntry {
  id: string;
  provider: string;
  upstream: string;
  tags: string[];
  tier: number;
  speed: Speed;
  context: number;
  tools: boolean;
  limits?: DailyCaps;
}

export type ModelState =
  | { state: "ok" }
  | { state: "cooldown"; until: number; reason?: CooldownReason }
  | { state: "exhausted"; until: number; reason?: ExhaustReason }
  | { state: "retired"; since: number };

export interface AttemptRecord {
  model: string;
  reason: string;
  status?: number;
  detail?: string;
}

export interface AliasDef {
  tags?: string[];
  requireTools?: boolean;
  minContext?: number;
  preferSpeed?: boolean;
}

export interface RequestCtx {
  hasTools: boolean;
  estTokens: number;
  harvest?: boolean;
  hasKey?: (provider: string) => boolean;
  getUsage?: (id: string) => UsageRecord | undefined;
  getProviderCaps?: (provider: string) => DailyCaps | undefined;
  getProviderState?: (provider: string) => ModelState | undefined;
  getReliability?: (id: string) => { score: number | null; samples: number } | undefined;
  reliabilityCfg?: { minSamples: number; demoteBelow: number };
  now?: number;
}

export interface DailyCaps {
  rpd?: number;
  tpd?: number;
}

export interface UsageRecord {
  day: string; // "YYYY-MM-DD" (UTC) this record belongs to
  requests: number;
  tokensIn: number;
  tokensOut: number;
}

export type UsageMap = Map<string, UsageRecord>;
