# Provider Enable/Disable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Allow users to enable and disable providers via CLI and configuration, independent of API key presence.

## Architecture

- Provider definitions extended with `enabled?: boolean` in `providers.json`
- `activeProviders()` in `src/config.ts` filters out disabled providers
- CLI commands `maxout enable` and `maxout disable` modify `~/.maxout/config.json`
- Status output shows `[disabled]` tag for disabled providers

## Files to Modify

| File | Changes |
|------|---------|
| `src/providers.json` | Add `"enabled": true` to each provider entry |
| `src/types.ts` | Add `enabled?: boolean` to `ProviderDef` interface |
| `src/config.ts` | Update `AppConfig.providers` type to include `enabled`; modify `activeProviders()` to skip disabled |
| `src/cli.ts` | Add `enable` and `disable` subcommands; update `printStatus()` to show enabled/disabled |

---

### Task 1: Add `enabled` field to provider definitions

**Files:** `src/providers.json`

Add `"enabled": true` to each provider entry in `providers.json`:

```json
{
  "openrouter": {
    "baseURL": "https://openrouter.ai/api/v1",
    "auth": "bearer",
    "quirks": "openrouter",
    "resetProfile": { "kind": "daily-utc-midnight" },
    "limits": { "rpd": 50 },
    "enabled": true
  },
  "groq": {
    "baseURL": "https://api.groq.com/openai/v1",
    "auth": "bearer",
    "quirks": "groq",
    "resetProfile": { "kind": "daily-utc-midnight" },
    "limits": { "rpd": 1000 },
    "enabled": true
  },
  "google": {
    "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "auth": "bearer",
    "quirks": "google",
    "resetProfile": { "kind": "daily-utc-midnight" },
    "enabled": true
  },
  "mistral": {
    "baseURL": "https://api.mistral.ai/v1",
    "auth": "bearer",
    "quirks": "mistral",
    "resetProfile": { "kind": "daily-utc-midnight" },
    "enabled": true
  },
  "cerebras": {
    "baseURL": "https://api.cerebras.ai/v1",
    "auth": "bearer",
    "quirks": "cerebras",
    "resetProfile": { "kind": "daily-utc-midnight" },
    "limits": { "tpd": 1000000 },
    "enabled": true
  },
  "local": {
    "baseURL": "http://localhost:11434",
    "auth": "none",
    "quirks": "ollama",
    "resetProfile": { "kind": "daily-utc-midnight" },
    "limits": { "rpd": 1000000, "tpd": 1000000 },
    "enabled": true
  }
}
```

**Step 1:** Add `"enabled": true` to each provider in `src/providers.json`
**Step 2:** Run `npm run build` — ensure TypeScript compilation passes (the field is optional so it should)

---

### Task 2: Add `enabled` to ProviderDef type

**Files:** `src/types.ts`

Add `enabled?: boolean` to the `ProviderDef` interface (line 17-23):

```typescript
export interface ProviderDef {
  baseURL: string;
  auth: "bearer";
  quirks: string;
  resetProfile: ResetProfile;
  limits?: DailyCaps;
  enabled?: boolean;
}
```

**Step 1:** Edit `src/types.ts` line 23 to add `enabled?: boolean;`
**Step 2:** Run `npm run build` — ensure no type errors

---

### Task 3: Update `activeProviders()` to filter disabled

**Files:** `src/config.ts`

Modify `activeProviders()` to respect the `enabled` flag. Two layers:

1. Read `enabled` from the per-provider config in `AppConfig.providers` (user override from config.json)
2. Fall back to `ProviderDef.enabled` (default from providers.json)

Current code (lines 131-143):
```typescript
export function activeProviders(
  cfg: AppConfig,
  env: Record<string, string | undefined>,
): Record<string, ActiveProvider> {
  const out: Record<string, ActiveProvider> = {};
  for (const [name, def] of Object.entries(PROVIDERS)) {
    const envKey = cfg.providers[name]?.apiKeyEnv ?? DEFAULT_ENV_KEYS[name];
    const apiKey = envKey ? env[envKey] : undefined;
    if (!apiKey) continue;
    out[name] = { ...def, apiKey };
  }
  return out;
}
```

New code:
```typescript
export function activeProviders(
  cfg: AppConfig,
  env: Record<string, string | undefined>,
): Record<string, ActiveProvider> {
  const out: Record<string, ActiveProvider> = {};
  for (const [name, def] of Object.entries(PROVIDERS)) {
    // Check enabled status: config override first, then ProviderDef default
    const cfgProvider = cfg.providers[name];
    const enabled = cfgProvider?.enabled ?? def.enabled ?? true;
    if (!enabled) continue; // skip disabled providers

    const envKey = cfgProvider?.apiKeyEnv ?? DEFAULT_ENV_KEYS[name];
    const apiKey = envKey ? env[envKey] : undefined;
    if (!apiKey) continue;
    out[name] = { ...def, apiKey };
  }
  return out;
}
```

**Step 1:** Edit `src/config.ts` — replace the `activeProviders` function with the new version
**Step 2:** Run `npm test` — ensure no regressions (the 3 pre-existing validateKey failures are acceptable)

---

### Task 4: Add `enabled` to AppConfig.providers type

**Files:** `src/config.ts`

Update the `AppConfig` interface to reflect that `providers` now carries per-provider config with `enabled`:

Current line 13: `providers: Record<string, { apiKeyEnv: string }>;`

New line 13: `providers: Record<string, { apiKeyEnv: string; enabled?: boolean }>;`

This ensures TypeScript knows the shape.

**Step 1:** Edit `src/config.ts` line 13 to add `enabled?: boolean`
**Step 2:** Run `npm run build` — ensure no type errors

---

### Task 5: Add `disable` CLI command

**Files:** `src/cli.ts`

Add new command handling after the existing `status`, `export-stats`, `serve`, `setup`, `revive` commands.

Add after line 284 (after `runSetup` return):

```typescript
if (cmd === "disable") {
  const provider = argv[1];
  if (!provider) {
    process.stderr.write("usage: maxout disable <provider>\n");
    return 64;
  }
  // Load config, set enabled=false for provider, save
  const configPath = defaultConfigPath();
  if (!fs.existsSync(configPath)) {
    process.stderr.write(`No config found at ${configPath}. Run maxout setup first.\n`);
    return 64;
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  if (!raw.providers) raw.providers = {};
  if (!raw.providers[provider]) {
    process.stderr.write(`Unknown provider '${provider}'. Options: ${Object.keys(PROVIDERS).join(", ")}\n`);
    return 64;
  }
  raw.providers[provider].enabled = false;
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
  console.log(`Disabled provider '${provider}'`);
  return 0;
}
```

**Step 1:** Edit `src/cli.ts` — add the `disable` command handler
**Step 2:** Run `npm test` — ensure no regressions

---

### Task 6: Add `enable` CLI command (with --force)

**Files:** `src/cli.ts`

Add new command after `disable`. The `--force` flag allows enabling even without API key.

```typescript
if (cmd === "enable") {
  const provider = argv[1];
  const force = argv.includes("--force");
  if (!provider) {
    process.stderr.write("usage: maxout enable <provider> [--force]\n");
    return 64;
  }
  const configPath = defaultConfigPath();
  if (!fs.existsSync(configPath)) {
    process.stderr.write(`No config found at ${configPath}. Run maxout setup first.\n`);
    return 64;
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  if (!raw.providers) raw.providers = {};
  if (!PROVIDERS[provider]) {
    process.stderr.write(`Unknown provider '${provider}'. Options: ${Object.keys(PROVIDERS).join(", ")}\n`);
    return 64;
  }
  raw.providers[provider].enabled = true;
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
  // Verify key exists when not forcing
  if (!force) {
    const envKey = raw.providers[provider].apiKeyEnv ?? DEFAULT_ENV_KEYS[provider];
    if (!envKey && !process.env[envKey]) {
      process.stderr.write(`No API key found for ${provider}. Set it first, or use --force.\n`);
      return 64;
    }
  }
  console.log(`Enabled provider '${provider}'`);
  return 0;
}
```

**Step 1:** Edit `src/cli.ts` — add the `enable` command handler with `--force`
**Step 2:** Run `npm test` — ensure no regressions

---

### Task 7: Update `printStatus()` to show enabled/disabled

**Files:** `src/cli.ts`

Modify the status output to show `[disabled]` after provider names that are disabled. Need to know which providers are disabled.

Add after computing `providerCount` and `registryProviderCount` in `printStatus()` (around line 184):

```typescript
// Track disabled providers for status display
const disabledProviders: string[] = [];
for (const [name, def] of Object.entries(PROVIDERS)) {
  const cfgProvider = cfg.providers[name];
  const enabled = cfgProvider?.enabled ?? def.enabled ?? true;
  if (!enabled) disabledProviders.push(name);
}
```

Then modify line 184:
```typescript
console.log(`maxout status - ${providerCount}/${registryProviderCount} providers enabled`);
```

And in the provider loop, add `[disabled]` after the provider name when printing:

In the provider loop (around line 201-206), modify the provider display:
```typescript
console.log(formatPoolLine(
  `${provider}${disabledProviders.includes(provider) ? " [disabled]" : ""}`,
  caps, aggregateProvider(usageMap, provider),
  states.get(poolKey(provider)) ?? { state: "ok" }, entries.length, now,
));
```

**Step 1:** Edit `src/cli.ts` — add disabled provider tracking and status display
**Step 2:** Run `npm test` — ensure no regressions

---

### Task 8: Run full verification

**Commands:**
- `npm test` — all 272 tests pass, no new failures
- `npm run build` — TypeScript compilation clean
- Manual test: `npx . disable groq` then `npx . status`, `npx . enable groq`, `npx . enable groq --force`

**Step 1:** Run `npm test` and `npm run build`
**Step 2:** Fix any issues
**Step 3:** Commit all changes with message: `feat: add provider enable/disable feature`

---

## Review Checklist

- [ ] `npm test` passes (272/272)
- [ ] `npm run build` passes (zero type errors)
- [ ] `npx . disable <provider>` works without API key
- [ ] `npx . enable <provider>` requires API key unless `--force`
- [ ] `npx . status` shows `[disabled]` for disabled providers
- [ ] Config persists across restarts
- [ ] No regressions in existing functionality