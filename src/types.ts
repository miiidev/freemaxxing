export type Speed = "fast" | "medium" | "slow";

export type FailureKind = "rate" | "quota" | "outage" | "bad_request";

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
}

export type ModelState =
  | { state: "ok" }
  | { state: "cooldown"; until: number }
  | { state: "exhausted"; until: number };

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
