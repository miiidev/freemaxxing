# Rename maxout to freemaxxing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the project from "maxout" to "freemaxxing" across all files

**Architecture:** Find-and-replace all occurrences of "maxout" with "freemaxxing" in source, tests, config, and documentation

**Tech Stack:** TypeScript, Node.js

**Spec:** N/A - this is a rename task

## Global Constraints

- Preserve all existing functionality
- Ensure all tests pass after rename
- Update both code and documentation

## File Structure

Files to modify:
- `package.json` - project name and bin
- `src/cli.ts` - CLI output strings
- `src/config.ts` - config paths and defaults
- `src/server.ts` - server headers and error messages
- `src/setup.ts` - setup wizard strings
- `src/sse.ts` - SSE frame types
- `test/**/*.ts` - test assertions
- `README.md` - documentation

---

### Task 1: Update package.json

**Files:**
- Modify: `package.json:2,10`

- [ ] **Step 1: Update package name and bin**

```json
{
  "name": "freemaxxing",
  "bin": {
    "freemaxxing": "./dist/cli.js"
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: rename package to freemaxxing"
```

---

### Task 2: Update source files (cli.ts, config.ts, server.ts, setup.ts, sse.ts)

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/config.ts`
- Modify: `src/server.ts`
- Modify: `src/setup.ts`
- Modify: `src/sse.ts`

- [ ] **Step 1: Rename in cli.ts**

Replace all occurrences of:
- `"maxout"` → `"freemaxxing"`
- `maxout` → `freemaxxing` in console.log strings
- Keep variable names and imports unchanged

- [ ] **Step 2: Rename in config.ts**

Replace all occurrences of:
- `".maxout"` → `".freemaxxing"` in path defaults
- `"MAXOUT_"` → `"FREEMAXXING_"` in env var names (if any)

- [ ] **Step 3: Rename in server.ts**

Replace all occurrences of:
- `"x-maxout-served-by"` → `"x-freemaxxing-served-by"`
- `"maxout_error"` → `"freemaxxing_error"`
- `"maxout"` → `"freemaxxing"` in log messages

- [ ] **Step 4: Rename in setup.ts**

Replace all occurrences of:
- `"maxout"` → `"freemaxxing"` in user-facing strings

- [ ] **Step 5: Rename in sse.ts**

Replace all occurrences of:
- `"maxout_error"` → `"freemaxxing_error"`

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/config.ts src/server.ts src/setup.ts src/sse.ts
git commit -m "feat: rename maxout to freemaxxing in source"
```

---

### Task 3: Update test files

**Files:**
- Modify: `test/integration/server.test.ts`
- Modify: `test/integration/streaming.test.ts`
- Modify: `test/unit/sse.test.ts`
- Modify: `test/unit/sse-guard.test.ts`
- Modify: `test/unit/reliability.test.ts`
- Modify: `test/unit/state.test.ts`
- Modify: `test/unit/usage.test.ts`

- [ ] **Step 1: Rename in all test files**

Replace all occurrences of:
- `"maxout_error"` → `"freemaxxing_error"`
- `"x-maxout-served-by"` → `"x-freemaxxing-served-by"`
- `"maxout"` → `"freemaxxing"` in test strings

- [ ] **Step 2: Run tests to verify**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/
git commit -m "test: update test assertions for freemaxxing rename"
```

---

### Task 4: Update README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rename in README**

Replace all occurrences of:
- `maxout` → `freemaxxing` in documentation
- `MAXOUT_` → `FREEMAXXING_` in env var names

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rename maxout to freemaxxing in README"
```

---

### Task 5: Final verification

- [ ] **Step 1: Build and test**

Run: `npm run build && npm test`
Expected: All tests pass

- [ ] **Step 2: Push changes**

```bash
git push
```
