# Provider Enable/Disable

Allow users to enable and disable providers via CLI and configuration,
independent of API key presence.

## Problem

Every provider with a key is always active. There is no way to temporarily
suspend a provider without removing its API key from `.maxout/.env`.

## Configuration

Each provider in `providers.json` gets `"enabled": true`. Users override it
per-provider in `~/.maxout/config.json` under a `providers` entry:

```jsonc
{
  "providers": {
    "groq": {
      "apiKeyEnv": "GROQ_API_KEY",
      "enabled": false
    }
  }
}
```

`ProviderDef` gains an optional `enabled?: boolean` field. Absence means `true`.

## CLI

### `maxout disable <provider>`

Sets `enabled: false` for the named provider in `~/.maxout/config.json`.
Works even if no API key is set. Errors if provider name is unknown.

### `maxout enable <provider> [--force]`

Sets `enabled: true`. Without `--force`, checks whether the API key exists
and prints a message if not: `"No API key found for <provider>. Set one
first, or use --force."` With `--force`, enables regardless.

### `maxout status` update

Provider pools now show `enabled` or `disabled` after the status line.
Disabled providers are listed but marked `[disabled]` and dimmed.

## Data flow

1. `loadConfig()` reads `providers.<name>.enabled` from config or defaults to `true`.
2. `activeProviders()` in `src/config.ts` skips providers where `enabled === false`.
3. Disabled providers are invisible to the router — they never get tried.
4. Status still shows them (so users know they exist), with `[disabled]` tag.

## Files

| File | Change |
|------|--------|
| `src/providers.json` | Add `"enabled": true` to each entry |
| `src/types.ts` | Add `enabled?: boolean` to `ProviderDef` |
| `src/config.ts` | Read `enabled` from config; filter in `activeProviders()` |
| `src/cli.ts` | Add `enable` / `disable` commands; update `printStatus()` |

## Edge cases

- **All providers disabled** → server starts, status shows `0/N providers`, every
  request returns `all_models_exhausted`.
- **Disable a provider without a key** → no-op effectively (it wasn't active),
  but config is updated.
- **Enable without key, no `--force`** → CLI warns, does not enable.
- **Unknown provider name** → CLI error with list of valid names.