# OSINT Framework — Design Spec

Date: 2026-08-20
Status: Approved (design review)

## 1. Overview

A general-purpose OSINT (Open Source Intelligence) investigation framework with a pluggable collector system, built as a single-user local web application. The user creates an investigation seeded with identifiers (email, username, domain, phone, name); a pipeline of collectors gathers public-source facts; a correlation engine links facts into an entity graph; and a browser UI presents the graph as the front door with per-entity profile drill-down.

The framework itself is the value: unified results, cross-source correlation, deduplication, and a live graph — things no single OSINT tool provides. Collection is a mix of natively implemented collectors (whois, DNS, public APIs, search engines) and wrappers around a small curated set of best-of-breed external tools (Sherlock, Subfinder, Holehe).

## 2. Goals & Non-Goals

### Goals
- Feed an investigation one or more seed identifiers and get a correlated entity graph with evidence-backed edges.
- Pluggable collector architecture: adding a new source is writing one class + registering it.
- Free-only data sources in v1; runnable end-to-end without purchasing any API keys.
- Responsive UI that never freezes or hangs during scans (async pipeline, streaming progress).
- Crash-safe scans: job state persisted so restarts don't lose work.

### Non-Goals (v1 — YAGNI)
- Multi-user/auth — single-user localhost app.
- Paid API integrations (HIBP, Shodan, Censys, SecurityTraits, VirusTotal) — Provider abstraction exists for later, but no keys in v1.
- Distributed workers, Celery/RQ, Postgres.
- Phone/name deep-lookup — phone and name collectors are minimal (prefix/geo parsing, search snippets) and come last.
- Automated report export / PDF generation.

## 3. Tech Stack

- Backend: Python 3.12+, FastAPI, SQLAlchemy 2.x, SQLite (WAL mode), httpx, uvicorn.
- Frontend: React + Vite + Cytoscape.js, minimal other deps.
- Dev tooling: pytest + respx (HTTP mocking), Vitest for frontend logic.
- Repo layout (monorepo):

```
ideation/
  backend/
    app/
      main.py            # FastAPI app + static serving
      core/              # config, db, models
      api/               # routers: investigations, entities, facts, graph, jobs
      collectors/        # registry + native collectors
      tools/             # external tool wrappers
      pipeline/          # scan engine (asyncio queue), job tracking
      correlation/       # rule engine
    tests/
  frontend/
    src/                 # React app
  docs/superpowers/specs/
```

## 4. Architecture & Data Flow

```
┌─────────────────────────────────────────────────┐
│  React SPA (Vite) + Cytoscape.js               │
│  Graph view · Profile drawer · Scan controls   │
└──────────────────────┬──────────────────────────┘
                       │ REST + SSE (live progress)
┌──────────────────────▼──────────────────────────┐
│  FastAPI backend                                │
│  ┌──────────┬───────────┬───────────┬─────────┐ │
│  │ API layer│ Pipeline  │ Collectors │ Tools  │ │
│  │ (REST+SSE)│ (asyncio │  (native)  │ (ext.  │ │
│  │          │  queue)   │           │ wraps) │ │
│  └──────────┴───────────┴───────────┴─────────┘ │
│  Correlation engine ── SQLite (SQLAlchemy)      │
└─────────────────────────────────────────────────┘
```

- Single process: FastAPI serves the API; the built SPA is served statically at localhost:8000. Dev mode runs Vite on its own port with a proxy to the backend.
- Pipeline: in-process asyncio task queue. A scan = fan-out of one task per (collector, seed entity) match. No Celery/RQ.
- Data flow: create investigation with seeds → pipeline enqueues matched collectors → collectors emit `Fact` records → correlation engine upserts entities/facts → SSE pushes progress → UI updates the graph incrementally.

## 5. Data Model (SQLite, SQLAlchemy)

### Entity (graph nodes)
- `id` (PK), `type` (`email | username | domain | phone | name | ip`), `value` (normalized), `investigation_id` (FK), `created_at`
- Normalization: emails lowercased; domains punycoded + lowercased; phones normalized to E.164 when parseable; usernames kept as given (case-sensitive on the platform).

### Fact (graph edges + evidence)
- `id` (PK), `investigation_id` (FK), `source_collector`, `entity_a_id` (FK), `entity_b_id` (FK, nullable), `relation` (`profile_of | registered_by | found_on | resolves_to | exposed_in | hosted_by | ...`), `category` (`breach | profile | infra | metadata`), `confidence` (0–1), `raw_data` (JSON evidence payload), `first_seen`, `last_seen`
- Every fact is evidence-backed: clicking an edge shows its raw payload, source collector, and timestamps.

### Investigation
- `id` (PK), `title`, `status` (`running | done | failed`), `created_at`, seeds (many-to-many to Entity).

### Job (scan progress, drives SSE)
- `id` (PK), `investigation_id` (FK), `collector_name`, `status` (`queued | running | done | partial | failed | skipped`), `started_at`, `finished_at`, `error_message`, `result_count`

## 6. Collector System

### Interface — every collector (native or wrapper) implements:

```python
class Collector(Protocol):
    name: str
    input_types: list[EntityType]      # what it accepts
    produces: list[FactCategory]       # what it emits
    requires_external: bool            # True for tool wrappers
    async def run(self, ctx: CollectorContext) -> AsyncIterator[Fact]: ...
```

- `CollectorContext`: the seed entity, a shared `httpx.AsyncClient` (global ~15s timeout), config (politeness delay, enabled flag, max-results cap).

### Registry
- Central `collectors.py` mapping name → instance. Pipeline consults it to fan out per entity type.

### Native collectors (v1)
| Collector | Input | Emits |
|---|---|---|
| whois | domain, ip | registrant email/org, dates → `registered_by`, `metadata` |
| dns_records | domain | A/AAAA/MX/TXT/NS records → `resolves_to`, `hosted_by` (MX provider) |
| crt_sh | domain | certificate transparency subdomains → `resolves_to` |
| http_fingerprint | domain | headers, server tech, title → `metadata` |
| github_user | username | profile info, repos → `profile_of` |
| github_commits | email | commit authors/emails → `found_on`, `profile_of` |
| search_snippets | name, email, username | search engine result snippets → `found_on` |
| phone_prefix | phone | country code, operator prefix, geo → `metadata` |

### Tool wrappers (v1)
| Tool | Purpose | Notes |
|---|---|---|
| Sherlock | username profiles across 400+ sites | JSON output parse |
| Subfinder | subdomain enumeration | list output parse |
| Holehe | email account existence on many sites | JSON output parse |

- Wrapper behavior: detect binary → run via `asyncio.create_subprocess_exec` with hard timeout → parse output into facts → **skip gracefully** (status `skipped`) with an install hint if the binary is missing. Never crash the scan.

## 7. Pipeline & Concurrency

- Scan trigger returns immediately (202 + job IDs); collection runs as background asyncio tasks.
- External tools run as subprocesses with hard timeouts; the event loop is never blocked.
- Per-collector guardrails: HTTP timeout (~15s), configurable politeness delay, max-results cap, per-scan deadline. A runaway collector is killed, marked `failed`, scan continues.
- SQLite in WAL mode; fact batches written in short transactions so reads never block long.
- Crash recovery: on startup, jobs left in `running`/`queued` are marked `failed`/`interrupted` and can be re-queued from the UI.
- Progress: SSE endpoint streams job status changes + new entity/fact counts to the UI.

## 8. Correlation Engine

Small rule set, each rule is a pure function over new facts:

1. **Identity merge** — same normalized entity value from different collectors is a single node; facts accumulate.
2. **Cross-link rules** (concrete, evidence-backed only):
   - whois registrant email ↔ domain → `registered_by`
   - MX host `google.com` / `outlook.com` / etc → `hosted_by`
   - GitHub commit email ↔ repo owner username → `profile_of`
   - crt.sh/Subfinder subdomain ↔ parent domain → `resolves_to`
   - Sherlock profile URL ↔ username → `profile_of`
3. **No speculative edges** — never "same name → same person". Edges exist only when a fact backs them.

## 9. API Surface

- `POST /api/investigations` — create + seed entities, returns investigation + job IDs
- `GET /api/investigations` — list
- `GET /api/investigations/{id}` — detail (entities, jobs)
- `POST /api/investigations/{id}/scan` — (re)start scan for current seeds
- `GET /api/investigations/{id}/graph` — nodes + edges (Cytoscape payload)
- `GET /api/investigations/{id}/entities/{entity_id}` — profile: facts grouped by category
- `GET /api/investigations/{id}/stream` — SSE: job status + incremental graph deltas
- `POST /api/investigations/{id}/resume` — re-queue failed/interrupted jobs

## 10. Frontend (React SPA)

- **Investigation list** — create new investigation, paste one or more seed identifiers (auto-detected by type), open existing.
- **Graph view (front door)** — Cytoscape; nodes = entities (color-coded by type), edges = facts; click node → profile drawer; click edge → evidence panel (raw data + source + timestamp). Node additions arrive as debounced incremental batches.
- **Profile drawer** — facts grouped by category (breach, profile, infra, metadata), each with source, confidence, timestamp, raw payload; expand/collapse raw JSON.
- **Scan panel** — per-collector status chips (queued/running/done/failed/skipped) fed by SSE.

## 11. Error Handling

- Collectors run in isolation; exceptions → job `failed` with captured error; scan continues.
- Malformed/empty responses → job `partial` status (via `result_count` vs expected) or `done` with 0 results; never a crash.
- Subprocesses: hard timeout kill; missing binary → `skipped` + install hint.
- DB writes transactional per fact batch; JSON payloads truncated if oversized.
- HTTP errors (429/5xx) → collector retries once with backoff, then `failed` with the status code recorded.

## 12. Testing

- Backend (pytest + respx):
  - Unit tests per native collector with mocked HTTP.
  - Correlation rule tests: feed facts, assert expected edges; assert no speculative edges.
  - API integration tests via FastAPI TestClient against a temp SQLite DB.
  - Tool wrapper tests using fake binaries producing canned output.
- Frontend: Vitest for state/reducer logic; manual smoke test of graph rendering.
- Verification commands: `pytest`, `npm run lint`, `npm run build`; backend run: `uvicorn app.main:app`.

## 13. Build Order (v1 milestones)

1. Backend skeleton: FastAPI app, SQLAlchemy models, config, SQLite WAL setup
2. Domain/infra collectors: whois, dns_records, crt_sh, http_fingerprint
3. Pipeline + job tracking + SSE
4. Correlation engine (rules above)
5. React SPA: investigation list, graph view, profile drawer, scan panel
6. Email collectors: github_commits, holehe wrapper
7. Username collectors: github_user, sherlock wrapper
8. Phone/name minimal collectors: phone_prefix, search_snippets
9. Hardening: retries, backoff, caps, crash recovery; full test pass
10. README with setup/run instructions and external tool install guide

## 14. Out of Scope (explicitly deferred)

- Paid provider integrations (design the Provider abstraction only when adding them)
- Multi-user, auth, remote deployment
- Report/PDF export
- Historical data retention policies beyond the single SQLite file