# Maxout rename + one-command start — design

Date: 2026-08-25

## Goals

1. Rename the project freeroll → **maxout**, everywhere, including wire-visible names.
2. Zero-to-serving in one command: fresh users get the setup wizard automatically on first `serve`.
3. Publish-ready packaging (nothing published): `npx github:<owner>/maxout` works today.

## Decisions

- **Rename everything**: CLI strings, package name/bin, `~/.maxout/` data dir,
  `x-maxout-served-by` header, `maxout_error` SSE frame key, `maxout_alias`
  model-list field, `*maxout: <id>*` credit line, SSE chunk id. Pre-publish is
  the only free window to change wire names.
- **Fresh start for local data**: no migration code; old `~/.freeroll/` is
  simply abandoned (user deletes/moves it manually).
- **Auto-setup guard** (`shouldAutoSetup(providerCount, interactive)` in
  src/cli.ts): wizard launches only when zero keys are configured AND
  stdin+stdout are TTYs. Pipes/CI keep today's behavior byte-for-byte
  (serve + printed hints). After the wizard the env file is reloaded and the
  server starts regardless of wizard outcome (still-zero-keys → hints only).
- **Packaging**: shebang atop src/cli.ts; `files: ["dist"]`,
  `prepare: "npm run build"` (makes git-based npx build on install),
  `prepublishOnly: "npm test && npm run build"`.

## New user journeys

- Repo: clone → `npm install` → `npm start` → (wizard if no keys) → serving.
- No clone: `npx github:<owner>/maxout` (prepare script builds first).
- In-repo short commands after install: `npx . status`, `npx . setup …`.

## Out of scope / manual follow-ups

- Renaming the OS folder and GitHub repo (owner action).
- Historical records under `.superpowers/` and `docs/superpowers/` intentionally
  still say freeroll — they document past work and stay untouched.
- `repository` field in package.json left unset until the GitHub URL is known.

## Verification performed

- 267/267 vitest tests pass (incl. new shouldAutoSetup unit tests).
- `tsc` clean; dist/cli.js starts with `#!/usr/bin/env node`; tarball contains dist/ only.
- Non-TTY smoke with isolated USERPROFILE: wizard correctly skipped,
  `maxout serving 0/6 providers` banner + hint block printed.
