export interface ToolSpec {
  type?: string;
  function: { name: string; parameters?: { required?: string[] } };
}

export interface ToolCallVerdict {
  ok: boolean;
  reason?: string;
}

// Pure structural check of a parsed chat.completion. Prose replies are always
// fine — agents legitimately get clarifying text even when they sent tools;
// only present-but-broken tool calls and provider-side cutoffs fail here.
export function validateCompletion(
  resp: Record<string, unknown>,
  tools?: ToolSpec[],
): ToolCallVerdict {
  const choices = resp.choices as Array<Record<string, unknown>> | undefined;
  const c0 = choices?.[0];
  if (!c0) return { ok: false, reason: "empty-choices" };

  if (c0.finish_reason === "length") return { ok: false, reason: "cutoff-length" };

  const msg = c0.message as Record<string, unknown> | undefined;
  const tcs = msg?.tool_calls as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tcs) || tcs.length === 0) return { ok: true };

  const byName = new Map((tools ?? []).map((t) => [t.function.name, t]));
  for (let i = 0; i < tcs.length; i++) {
    const tc = tcs[i];
    const fn = tc.function as { name?: unknown; arguments?: unknown } | undefined;
    const label = `tool_calls[${i}]`;
    if (!fn || typeof fn.name !== "string" || fn.name.length === 0) {
      return { ok: false, reason: `${label}:missing-name` };
    }
    if ((tools?.length ?? 0) > 0 && !byName.has(fn.name)) {
      return { ok: false, reason: `${label}:unknown-tool:${fn.name}` };
    }
    let args: unknown;
    if (typeof fn.arguments === "string") {
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        return { ok: false, reason: `${label}:arguments-not-json` };
      }
    } else if (fn.arguments !== undefined) {
      args = fn.arguments;
    } else {
      return { ok: false, reason: `${label}:missing-arguments` };
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return { ok: false, reason: `${label}:arguments-not-object` };
    }
    const required = byName.get(fn.name)?.function.parameters?.required ?? [];
    for (const key of required) {
      const v = (args as Record<string, unknown>)[key];
      if (v === undefined || v === null || v === "") {
        return { ok: false, reason: `${label}:missing-arg:${key}` };
      }
    }
  }
  return { ok: true };
}