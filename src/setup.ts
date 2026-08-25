export interface SetupProvider {
  name: string;
  envVar: string;
  signupUrl: string;
  baseURL: string;
}

// Ordered by onboarding friction — groq is the recommended first key.
// GitHub Models omitted: provider retired July 2026.
export const SETUP_PROVIDERS: SetupProvider[] = [
  { name: "groq", envVar: "GROQ_API_KEY", signupUrl: "https://console.groq.com/keys", baseURL: "https://api.groq.com/openai/v1" },
  { name: "google", envVar: "GEMINI_API_KEY", signupUrl: "https://aistudio.google.com/apikey", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" },
  { name: "openrouter", envVar: "OPENROUTER_API_KEY", signupUrl: "https://openrouter.ai/settings/keys", baseURL: "https://openrouter.ai/api/v1" },
  { name: "mistral", envVar: "MISTRAL_API_KEY", signupUrl: "https://console.mistral.ai/api-keys", baseURL: "https://api.mistral.ai/v1" },
  { name: "cerebras", envVar: "CEREBRAS_API_KEY", signupUrl: "https://cloud.cerebras.ai", baseURL: "https://api.cerebras.ai/v1" },
];

// Whole-file rewrite after merge: keep lines we don't manage verbatim,
// replace every definition of an updated key with exactly one new line.
export function buildEnvContent(
  existing: string | undefined,
  updates: Record<string, string>,
): string {
  const kept: string[] = [];
  for (const rawLine of (existing ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!m || m[1] in updates) continue;
    kept.push(line);
  }
  for (const [k, v] of Object.entries(updates)) kept.push(`${k}=${v}`);
  return `${kept.sort().join("\n")}\n`;
}

function joinURL(base: string, pathPart: string): string {
  return base.replace(/\/+$/, "") + pathPart;
}

export interface KeyValidation {
  ok: boolean;
  detail?: string;
}

// Lightweight liveness/auth probe — GET /models is free on every provider.
export async function validateKey(
  baseURL: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyValidation> {
  try {
    const res = await fetchImpl(joinURL(baseURL, "/models"), {
      headers: { authorization: `Bearer ${key}` },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, detail: "invalid key" };
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}