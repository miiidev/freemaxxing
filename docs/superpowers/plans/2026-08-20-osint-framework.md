# OSINT Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-user local web app (FastAPI + React) that runs OSINT investigations on email/username/domain/phone seeds, collecting facts via pluggable collectors (native + external tool wrappers), correlating them into an evidence-backed entity graph shown in a Cytoscape UI.

**Architecture:** Python FastAPI backend with SQLite (WAL), an in-process scan engine (one background thread + asyncio loop per scan, per-collector jobs tracked in DB, progress via SSE), a collector registry where each collector yields `Fact` records, and a correlation layer that normalizes/merges entities and dedupes facts. React SPA (Vite) renders the graph and streams scan progress; the built SPA is served statically by FastAPI.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.x, SQLite (WAL), httpx, dnspython, idna, pytest + respx + pytest-asyncio; React 18, Vite 5, Cytoscape.js, Vitest.

## Global Constraints

- Python >= 3.12; backend deps pinned in `backend/requirements.txt` (fastapi 0.115.*, uvicorn[standard] 0.30.*, sqlalchemy 2.0.*, httpx 0.27.*, dnspython 2.6.*, idna 3.*, pytest 8.*, pytest-asyncio 0.24.*, respx 0.21.*).
- Free-only data sources in v1. No paid API keys anywhere. External tools are detected at runtime and skipped (job status `skipped`) with an install hint if missing.
- Entity types are exactly: `email | username | domain | phone | name | ip`.
- Fact categories exactly: `breach | profile | infra | metadata`.
- Job statuses exactly: `queued | running | done | partial | failed | skipped`. `partial` = finished with 0 results, `done` = finished with >= 1 result.
- No speculative correlation: edges exist only when a collector fact backs them. Never link two entities on name similarity.
- All collectors must be isolation-safe: exceptions become a `failed` job; the scan continues.
- Single-user, localhost only. No auth, no Celery, no Postgres.
- Repo layout: `backend/` and `frontend/` at repo root; specs in `docs/superpowers/specs/`.
- SQLite in WAL mode; jobs survive restarts (running/queued jobs are not auto-recovered in v1; user clicks resume).
- Commit after every task with a conventional message (`feat:`, `test:`, `docs:`).

---

### Task 1: Backend skeleton — config, DB, models

**Files:**
- Create: `backend/requirements.txt`
- Create: `backend/pytest.ini`
- Create: `backend/app/__init__.py`
- Create: `backend/app/config.py`
- Create: `backend/app/core/__init__.py`
- Create: `backend/app/core/db.py`
- Create: `backend/app/core/models.py`
- Create: `backend/app/main.py`
- Create: `backend/tests/__init__.py`
- Create: `backend/tests/conftest.py`
- Test: `backend/tests/test_models.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `app.config.Settings` dataclass with fields `db_path: str`, `http_timeout: float`, `politeness_delay: float`, `max_results_per_collector: int` (env-overridable via `OSINT_DB`, `OSINT_HTTP_TIMEOUT`, `OSINT_POLITENESS_DELAY`, `OSINT_MAX_RESULTS`).
  - `app.core.db.engine`, `app.core.db.SessionLocal`, `app.core.db.init_db()`.
  - SQLAlchemy models: `Investigation(id, title, status, created_at, entities, jobs, facts)`, `Entity(id, type, value, created_at, investigations, facts_as_a, facts_as_b)` with unique constraint on `(type, value)`, `Fact(id, investigation_id, source_collector, entity_a_id, entity_b_id, relation, category, confidence, raw_data, first_seen, last_seen)`, `Job(id, investigation_id, entity_id, collector_name, status, started_at, finished_at, error_message, result_count)`.
  - `app.main.create_app()` returning a configured `FastAPI` instance; module-level `app = create_app()`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_models.py`:

```python
from datetime import datetime

from sqlalchemy.exc import IntegrityError

from app.core.db import SessionLocal
from app.core.models import Entity, Fact, Investigation, Job


def test_entity_unique_type_value():
    db = SessionLocal()
    db.add_all([Entity(type="email", value="a@b.com"), Entity(type="email", value="a@b.com")])
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
    else:
        raise AssertionError("expected IntegrityError for duplicate (type, value)")
    db.close()


def test_investigation_with_entity_and_fact_roundtrip():
    db = SessionLocal()
    inv = Investigation(title="t1", status="running")
    e1 = Entity(type="domain", value="example.com")
    e2 = Entity(type="email", value="admin@example.com")
    inv.entities.extend([e1, e2])
    db.add(inv)
    db.flush()
    fact = Fact(
        investigation_id=inv.id,
        source_collector="whois",
        entity_a_id=e1.id,
        entity_b_id=e2.id,
        relation="registered_by",
        category="metadata",
        confidence=1.0,
        raw_data={"email": "admin@example.com"},
    )
    db.add(fact)
    job = Job(investigation_id=inv.id, entity_id=e1.id, collector_name="whois", status="queued")
    db.add(job)
    db.commit()
    got = db.get(Investigation, inv.id)
    assert got.title == "t1"
    assert {e.value for e in got.entities} == {"example.com", "admin@example.com"}
    assert got.facts[0].relation == "registered_by"
    assert got.jobs[0].status == "queued"
    assert isinstance(got.facts[0].first_seen, datetime)
    db.close()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_models.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app'` (no `app` package yet).

- [ ] **Step 3: Write minimal implementation**

Create `backend/requirements.txt`:

```
fastapi==0.115.*
uvicorn[standard]==0.30.*
sqlalchemy==2.0.*
httpx==0.27.*
dnspython==2.6.*
idna==3.*
pytest==8.*
pytest-asyncio==0.24.*
respx==0.21.*
```

Create `backend/pytest.ini`:

```ini
[pytest]
asyncio_mode = auto
```

Create `backend/app/__init__.py` and `backend/app/core/__init__.py` as empty files.

Create `backend/app/config.py`:

```python
import os
from dataclasses import dataclass


@dataclass
class Settings:
    db_path: str = os.environ.get("OSINT_DB", "osint.db")
    http_timeout: float = float(os.environ.get("OSINT_HTTP_TIMEOUT", "15"))
    politeness_delay: float = float(os.environ.get("OSINT_POLITENESS_DELAY", "0.5"))
    max_results_per_collector: int = int(os.environ.get("OSINT_MAX_RESULTS", "50"))


settings = Settings()
```

Create `backend/app/core/db.py`:

```python
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from ..config import settings
from .models import Base

engine = create_engine(
    f"sqlite:///{settings.db_path}", connect_args={"check_same_thread": False}
)
event.listen(engine, "connect", lambda dbapi_conn, _: dbapi_conn.execute("PRAGMA journal_mode=WAL"))

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db() -> None:
    Base.metadata.create_all(engine)
```

Create `backend/app/core/models.py`:

```python
from datetime import datetime, timezone

from sqlalchemy import (
    Column, DateTime, Float, ForeignKey, Integer, JSON, String, Table, Text,
    UniqueConstraint,
)
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()

investigation_entities = Table(
    "investigation_entities",
    Base.metadata,
    Column("investigation_id", Integer, ForeignKey("investigations.id"), primary_key=True),
    Column("entity_id", Integer, ForeignKey("entities.id"), primary_key=True),
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Investigation(Base):
    __tablename__ = "investigations"

    id = Column(Integer, primary_key=True)
    title = Column(String(200), nullable=False)
    status = Column(String(20), nullable=False, default="running")
    created_at = Column(DateTime, nullable=False, default=utcnow)

    entities = relationship("Entity", secondary=investigation_entities, back_populates="investigations")
    jobs = relationship("Job", back_populates="investigation", cascade="all, delete-orphan")
    facts = relationship("Fact", back_populates="investigation", cascade="all, delete-orphan")


class Entity(Base):
    __tablename__ = "entities"
    __table_args__ = (UniqueConstraint("type", "value", name="uq_entity_type_value"),)

    id = Column(Integer, primary_key=True)
    type = Column(String(20), nullable=False)
    value = Column(String(500), nullable=False)
    created_at = Column(DateTime, nullable=False, default=utcnow)

    investigations = relationship("Investigation", secondary=investigation_entities, back_populates="entities")
    facts_as_a = relationship("Fact", foreign_keys="Fact.entity_a_id", back_populates="entity_a", cascade="all, delete-orphan")
    facts_as_b = relationship("Fact", foreign_keys="Fact.entity_b_id", back_populates="entity_b")


class Fact(Base):
    __tablename__ = "facts"

    id = Column(Integer, primary_key=True)
    investigation_id = Column(Integer, ForeignKey("investigations.id"), nullable=False)
    source_collector = Column(String(100), nullable=False)
    entity_a_id = Column(Integer, ForeignKey("entities.id"), nullable=False)
    entity_b_id = Column(Integer, ForeignKey("entities.id"), nullable=True)
    relation = Column(String(50), nullable=False)
    category = Column(String(20), nullable=False)
    confidence = Column(Float, nullable=False, default=1.0)
    raw_data = Column(JSON, nullable=False, default=dict)
    first_seen = Column(DateTime, nullable=False, default=utcnow)
    last_seen = Column(DateTime, nullable=False, default=utcnow)

    investigation = relationship("Investigation", back_populates="facts")
    entity_a = relationship("Entity", foreign_keys=[entity_a_id], back_populates="facts_as_a")
    entity_b = relationship("Entity", foreign_keys=[entity_b_id], back_populates="facts_as_b")


class Job(Base):
    __tablename__ = "jobs"

    id = Column(Integer, primary_key=True)
    investigation_id = Column(Integer, ForeignKey("investigations.id"), nullable=False)
    entity_id = Column(Integer, ForeignKey("entities.id"), nullable=False)
    collector_name = Column(String(100), nullable=False)
    status = Column(String(20), nullable=False, default="queued")
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    error_message = Column(Text, nullable=True)
    result_count = Column(Integer, nullable=False, default=0)

    investigation = relationship("Investigation", back_populates="jobs")
    entity = relationship("Entity")
```

Create `backend/app/main.py`:

```python
from fastapi import FastAPI

from .core.db import init_db


def create_app() -> FastAPI:
    init_db()
    return FastAPI(title="OSINT Framework")


app = create_app()
```

Create `backend/tests/__init__.py` as an empty file.

Create `backend/tests/conftest.py`:

```python
import os

os.environ["OSINT_DB"] = os.path.join(os.path.dirname(__file__), "test.db")

import pytest  # noqa: E402

from app.core import models  # noqa: E402
from app.core.db import SessionLocal, init_db  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _db_init():
    init_db()
    yield
    path = os.environ["OSINT_DB"]
    if os.path.exists(path):
        os.remove(path)


@pytest.fixture(autouse=True)
def _clean_tables():
    yield
    db = SessionLocal()
    db.execute(models.investigation_entities.delete())
    for model in (models.Fact, models.Job, models.Entity, models.Investigation):
        db.query(model).delete()
    db.commit()
    db.close()
```

- [ ] **Step 4: Install deps and run tests to verify they pass**

Run (from `backend/`):
```
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m pytest tests/ -v
```
(On macOS/Linux use `.venv/bin/pip` / `.venv/bin/python`.)

Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/
git commit -m "feat: backend skeleton with SQLAlchemy models, config, sqlite WAL"
```

---

### Task 2: Collector base, whois collector (RDAP), registry

**Files:**
- Create: `backend/app/collectors/__init__.py`
- Create: `backend/app/collectors/base.py`
- Create: `backend/app/collectors/whois.py`
- Create: `backend/app/collectors/registry.py`
- Test: `backend/tests/test_collectors_whois.py`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `app.collectors.base.EntityType` (str Enum: `EMAIL="email"`, `USERNAME="username"`, `DOMAIN="domain"`, `PHONE="phone"`, `NAME="name"`, `IP="ip"`).
  - `app.collectors.base.FactCategory` (str Enum: `BREACH="breach"`, `PROFILE="profile"`, `INFRA="infra"`, `METADATA="metadata"`).
  - `app.collectors.base.Fact` dataclass: `source_collector: str`, `entity_a_type: EntityType`, `entity_a_value: str`, `relation: str`, `category: FactCategory`, `raw_data: dict`, `entity_b_type: EntityType | None = None`, `entity_b_value: str | None = None`, `confidence: float = 1.0`.
  - `app.collectors.base.CollectorContext` dataclass: `entity_type: EntityType`, `entity_value: str`, `client: httpx.AsyncClient`, `max_results: int`, `politeness_delay: float`.
  - `app.collectors.base.Collector` Protocol: `name: str`, `input_types: list[EntityType]`, `produces: list[FactCategory]`, `requires_external: bool = False`, `async def run(self, ctx: CollectorContext) -> AsyncIterator[Fact]`.
  - `app.collectors.whois.collector` — instance of `WhoisCollector`, `name="whois"`, inputs `[DOMAIN, IP]`, queries RDAP (`https://rdap.org/domain/{value}` or `https://rdap.org/ip/{value}`), yields a `has_registrant` metadata fact (no entity_b) and, when a registrant email exists, a `registered_by` fact with `entity_b_type=EMAIL`.
  - `app.collectors.registry.all_collectors_for(entity_type: str) -> list[Collector]`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_collectors_whois.py`:

```python
import httpx
import pytest
import respx

from app.collectors.base import CollectorContext, EntityType, FactCategory
from app.collectors.whois import collector

RDAP_DOMAIN = {
    "handle": "REDACTED FOR PRIVACY",
    "entities": [
        {
            "handle": "example-registrar",
            "vcardArray": ["vcard", [["fn", {}, "text", "Admin"], ["email", {}, "text", "admin@example.com"]]],
        }
    ],
    "events": [{"eventAction": "registration", "eventDate": "2000-01-01T00:00:00Z"}],
}


@pytest.mark.asyncio
async def test_whois_domain_yields_registered_by_fact():
    async with respx.mock:
        respx.get("https://rdap.org/domain/example.com").mock(return_value=httpx.Response(200, json=RDAP_DOMAIN))
        async with httpx.AsyncClient() as client:
            ctx = CollectorContext(
                entity_type=EntityType.DOMAIN, entity_value="example.com",
                client=client, max_results=50, politeness_delay=0.0,
            )
            facts = [f async for f in collector.run(ctx)]
    assert len(facts) == 2
    assert facts[0].relation == "has_registrant"
    assert facts[0].category == FactCategory.METADATA
    registered_by = next(f for f in facts if f.relation == "registered_by")
    assert registered_by.entity_b_type == EntityType.EMAIL
    assert registered_by.entity_b_value == "admin@example.com"
    assert registered_by.raw_data == {"email": "admin@example.com"}


@pytest.mark.asyncio
async def test_whois_non_200_yields_nothing():
    async with respx.mock:
        respx.get("https://rdap.org/domain/example.com").mock(return_value=httpx.Response(404))
        async with httpx.AsyncClient() as client:
            ctx = CollectorContext(
                entity_type=EntityType.DOMAIN, entity_value="example.com",
                client=client, max_results=50, politeness_delay=0.0,
            )
            facts = [f async for f in collector.run(ctx)]
    assert facts == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python -m pytest tests/test_collectors_whois.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.collectors'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/app/collectors/__init__.py` as an empty file.

Create `backend/app/collectors/base.py`:

```python
from dataclasses import dataclass
from enum import Enum
from typing import AsyncIterator, Optional, Protocol

import httpx


class EntityType(str, Enum):
    EMAIL = "email"
    USERNAME = "username"
    DOMAIN = "domain"
    PHONE = "phone"
    NAME = "name"
    IP = "ip"


class FactCategory(str, Enum):
    BREACH = "breach"
    PROFILE = "profile"
    INFRA = "infra"
    METADATA = "metadata"


@dataclass
class Fact:
    source_collector: str
    entity_a_type: EntityType
    entity_a_value: str
    relation: str
    category: FactCategory
    raw_data: dict
    entity_b_type: Optional[EntityType] = None
    entity_b_value: Optional[str] = None
    confidence: float = 1.0


@dataclass
class CollectorContext:
    entity_type: EntityType
    entity_value: str
    client: httpx.AsyncClient
    max_results: int
    politeness_delay: float


class Collector(Protocol):
    name: str
    input_types: list[EntityType]
    produces: list[FactCategory]
    requires_external: bool = False

    async def run(self, ctx: CollectorContext) -> AsyncIterator[Fact]:
        ...
```

Create `backend/app/collectors/whois.py`:

```python
import httpx

from .base import Collector, CollectorContext, EntityType, Fact, FactCategory


class WhoisCollector:
    name = "whois"
    input_types = [EntityType.DOMAIN, EntityType.IP]
    produces = [FactCategory.METADATA]
    requires_external = False

    async def run(self, ctx: CollectorContext):
        endpoint = (
            f"https://rdap.org/domain/{ctx.entity_value}"
            if ctx.entity_type == EntityType.DOMAIN
            else f"https://rdap.org/ip/{ctx.entity_value}"
        )
        resp = await ctx.client.get(endpoint)
        if resp.status_code != 200:
            return
        data = resp.json()
        registrant_email = None
        for ent in data.get("entities", []):
            for field in ent.get("vcardArray", [[], []])[1]:
                if field[0] == "email":
                    registrant_email = field[3]
                    break
        events = {e["eventAction"]: e["eventDate"] for e in data.get("events", [])}
        registrar = data.get("entities", [{}])[0].get("handle") if data.get("entities") else None
        yield Fact(
            source_collector=self.name,
            entity_a_type=ctx.entity_type,
            entity_a_value=ctx.entity_value,
            relation="has_registrant",
            category=FactCategory.METADATA,
            raw_data={"registrar": registrar, "events": events, "handle": data.get("handle")},
        )
        if registrant_email:
            yield Fact(
                source_collector=self.name,
                entity_a_type=ctx.entity_type,
                entity_a_value=ctx.entity_value,
                entity_b_type=EntityType.EMAIL,
                entity_b_value=registrant_email,
                relation="registered_by",
                category=FactCategory.METADATA,
                raw_data={"email": registrant_email},
            )


collector = WhoisCollector()
```

Create `backend/app/collectors/registry.py`:

```python
from typing import TYPE_CHECKING

from .base import EntityType
from . import whois

if TYPE_CHECKING:
    from .base import Collector

_NATIVE: list = [whois.collector]
_EXTERNAL: list = []


def all_collectors_for(entity_type: str) -> list["Collector"]:
    t = EntityType(entity_type)
    return [c for c in _NATIVE + _EXTERNAL if t in c.input_types]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python -m pytest tests/test_collectors_whois.py -v`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/collectors/ backend/tests/test_collectors_whois.py
git commit -m "feat: collector base protocol, registry, and RDAP whois collector"
```

---

### Task 3: dns_records collector (dnspython)

**Files:**
- Create: `backend/app/collectors/dns_records.py`
- Modify: `backend/app/collectors/registry.py`
- Test: `backend/tests/test_collectors_dns.py`

**Interfaces:**
- Consumes: `CollectorContext`, `Fact`, `EntityType`, `FactCategory` from `app.collectors.base`.
- Produces:
  - `app.collectors.dns_records.collector` — `name="dns_records"`, inputs `[DOMAIN]`.
  - Emits `resolves_to` facts (A/AAAA → entity_b `IP`), `hosted_by` facts (MX → entity_b `DOMAIN` provider domain from `MX_PROVIDERS` mapping), and `has_record` facts (MX/TXT/NS → no entity_b). `MX_PROVIDERS` maps substrings to provider domains: google→google.com, outlook→outlook.com, microsoft→microsoft.com, mail.protection→microsoft.com, cloudflare→cloudflare.com, amazonaws→amazonaws.com, zoho→zoho.com, protonmail→protonmail.com, fastmail→fastmail.com.
- Registry gains `dns_records.collector`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_collectors_dns.py`:

```python
from types import SimpleNamespace

import httpx
import pytest

from app.collectors.base import CollectorContext, EntityType, FactCategory
from app.collectors.dns_records import collector


def _make_answer(rtype, *values):
    records = []
    for v in values:
        rec = SimpleNamespace(rdtype=rtype)
        if rtype == "MX":
            rec.exchange = v
        else:
            rec.to_text = lambda: v
        records.append(rec)
    return records


@pytest.mark.asyncio
async def test_dns_emits_resolves_to_and_hosted_by(monkeypatch):
    def fake_resolve(name, rtype, lifetime=None):
        return _make_answer(rtype,
                            "gmail-smtp-in.google.com" if rtype == "MX" else "93.184.216.34")

    monkeypatch.setattr("dns.resolver.resolve", fake_resolve)
    async with httpx.AsyncClient() as client:
        ctx = CollectorContext(entity_type=EntityType.DOMAIN, entity_value="example.com",
                               client=client, max_results=50, politeness_delay=0.0)
        facts = [f async for f in collector.run(ctx)]
    relations = {(f.relation, f.entity_b_value if f.entity_b_value else None) for f in facts}
    assert ("resolves_to", "93.184.216.34") in relations
    assert ("hosted_by", "google.com") in relations
    assert any(f.category == FactCategory.INFRA for f in facts)
    a_fact = next(f for f in facts if f.entity_b_type == EntityType.IP)
    assert a_fact.raw_data["record_type"] == "A"


@pytest.mark.asyncio
async def test_dns_unresolvable_domain_yields_nothing(monkeypatch):
    def fake_resolve(name, rtype, lifetime=None):
        raise Exception("NXDOMAIN")

    monkeypatch.setattr("dns.resolver.resolve", fake_resolve)
    async with httpx.AsyncClient() as client:
        ctx = CollectorContext(entity_type=EntityType.DOMAIN, entity_value="nope.invalid",
                               client=client, max_results=50, politeness_delay=0.0)
        facts = [f async for f in collector.run(ctx)]
    assert facts == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python -m pytest tests/test_collectors_dns.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.collectors.dns_records'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/app/collectors/dns_records.py`:

```python
import dns.resolver

from .base import Collector, CollectorContext, EntityType, Fact, FactCategory

MX_PROVIDERS = [
    ("google", "google.com"),
    ("outlook", "outlook.com"),
    ("microsoft", "microsoft.com"),
    ("mail.protection", "microsoft.com"),
    ("cloudflare", "cloudflare.com"),
    ("amazonaws", "amazonaws.com"),
    ("zoho", "zoho.com"),
    ("protonmail", "protonmail.com"),
    ("fastmail", "fastmail.com"),
]

RECORD_TYPES = ("A", "AAAA", "MX", "TXT", "NS")


class DnsCollector:
    name = "dns_records"
    input_types = [EntityType.DOMAIN]
    produces = [FactCategory.INFRA]
    requires_external = False

    async def run(self, ctx: CollectorContext):
        for rtype in RECORD_TYPES:
            try:
                answers = dns.resolver.resolve(ctx.entity_value, rtype, lifetime=10)
            except Exception:
                continue
            for rdata in answers:
                if rtype in ("A", "AAAA"):
                    value = rdata.to_text()
                    yield Fact(
                        source_collector=self.name,
                        entity_a_type=ctx.entity_type,
                        entity_a_value=ctx.entity_value,
                        entity_b_type=EntityType.IP,
                        entity_b_value=value,
                        relation="resolves_to",
                        category=FactCategory.INFRA,
                        raw_data={"record_type": rtype, "value": value},
                    )
                elif rtype == "MX":
                    host = str(rdata.exchange).rstrip(".")
                    provider = next(
                        (d for needle, d in MX_PROVIDERS if needle in host.lower()), None
                    )
                    if provider:
                        yield Fact(
                            source_collector=self.name,
                            entity_a_type=ctx.entity_type,
                            entity_a_value=ctx.entity_value,
                            entity_b_type=EntityType.DOMAIN,
                            entity_b_value=provider,
                            relation="hosted_by",
                            category=FactCategory.INFRA,
                            raw_data={"mx_host": host, "provider": provider},
                        )
                    else:
                        yield Fact(
                            source_collector=self.name,
                            entity_a_type=ctx.entity_type,
                            entity_a_value=ctx.entity_value,
                            relation="has_record",
                            category=FactCategory.INFRA,
                            raw_data={"record_type": "MX", "value": host},
                        )
                else:
                    yield Fact(
                        source_collector=self.name,
                        entity_a_type=ctx.entity_type,
                        entity_a_value=ctx.entity_value,
                        relation="has_record",
                        category=FactCategory.INFRA,
                        raw_data={"record_type": rtype, "value": rdata.to_text()},
                    )


collector = DnsCollector()
```

Modify `backend/app/collectors/registry.py` — change the import and `_NATIVE` lines:

```python
from . import dns_records, whois

_NATIVE: list = [whois.collector, dns_records.collector]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python -m pytest tests/test_collectors_dns.py -v`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/collectors/ backend/tests/test_collectors_dns.py
git commit -m "feat: dns_records collector with mx provider mapping"
```

---

### Task 4: crt.sh collector

**Files:**
- Create: `backend/app/collectors/crt_sh.py`
- Modify: `backend/app/collectors/registry.py`
- Test: `backend/tests/test_collectors_crt.py`

**Interfaces:**
- Consumes: `CollectorContext`, `Fact`, `EntityType`, `FactCategory` from `app.collectors.base`.
- Produces:
  - `app.collectors.crt_sh.collector` — `name="crt_sh"`, inputs `[DOMAIN]`.
  - GETs `https://crt.sh/?q=%25.{domain}&output=json`, parses `name_value` (split on newlines), keeps only names ending in `.{domain}` (lowercased, excluding the bare domain), dedupes, caps at `ctx.max_results`, emits `resolves_to` facts (entity_a = seed domain, entity_b = subdomain `DOMAIN`, raw_data `{"cert_name": name}`).
- Registry gains `crt_sh.collector`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_collectors_crt.py`:

```python
import httpx
import pytest
import respx

from app.collectors.base import CollectorContext, EntityType
from app.collectors.crt_sh import collector

CERT_JSON = [
    {"name_value": "www.example.com\napi.example.com"},
    {"name_value": "example.com"},
    {"name_value": "www.example.com"},
]


@pytest.mark.asyncio
async def test_crt_sh_yields_unique_subdomains():
    async with respx.mock:
        respx.get("https://crt.sh/", params={"q": "%25.example.com", "output": "json"}).mock(
            return_value=httpx.Response(200, json=CERT_JSON)
        )
        async with httpx.AsyncClient() as client:
            ctx = CollectorContext(entity_type=EntityType.DOMAIN, entity_value="example.com",
                                   client=client, max_results=50, politeness_delay=0.0)
            facts = [f async for f in collector.run(ctx)]
    values = {f.entity_b_value for f in facts}
    assert values == {"www.example.com", "api.example.com"}
    assert all(f.relation == "resolves_to" for f in facts)
    assert all(f.entity_b_type == EntityType.DOMAIN for f in facts)


@pytest.mark.asyncio
async def test_crt_sh_ignores_unrelated_names():
    async with respx.mock:
        respx.get("https://crt.sh/", params={"q": "%25.example.com", "output": "json"}).mock(
            return_value=httpx.Response(200, json=[{"name_value": "evil.net\nother.com"}])
        )
        async with httpx.AsyncClient() as client:
            ctx = CollectorContext(entity_type=EntityType.DOMAIN, entity_value="example.com",
                                   client=client, max_results=50, politeness_delay=0.0)
            facts = [f async for f in collector.run(ctx)]
    assert facts == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python -m pytest tests/test_collectors_crt.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.collectors.crt_sh'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/app/collectors/crt_sh.py`:

```python
from .base import Collector, CollectorContext, EntityType, Fact, FactCategory


class CrtShCollector:
    name = "crt_sh"
    input_types = [EntityType.DOMAIN]
    produces = [FactCategory.INFRA]
    requires_external = False

    async def run(self, ctx: CollectorContext):
        resp = await ctx.client.get(
            "https://crt.sh/", params={"q": f"%25.{ctx.entity_value}", "output": "json"}
        )
        if resp.status_code != 200:
            return
        names: set[str] = set()
        suffix = "." + ctx.entity_value.lower()
        for row in resp.json():
            for name in row.get("name_value", "").split("\n"):
                name = name.strip().lower()
                if name and name.endswith(suffix) and name != ctx.entity_value.lower():
                    names.add(name)
        for name in list(names)[: ctx.max_results]:
            yield Fact(
                source_collector=self.name,
                entity_a_type=ctx.entity_type,
                entity_a_value=ctx.entity_value,
                entity_b_type=EntityType.DOMAIN,
                entity_b_value=name,
                relation="resolves_to",
                category=FactCategory.INFRA,
                raw_data={"cert_name": name},
            )


collector = CrtShCollector()
```

Modify `backend/app/collectors/registry.py` — imports and `_NATIVE`:

```python
from . import crt_sh, dns_records, whois

_NATIVE: list = [whois.collector, dns_records.collector, crt_sh.collector]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python -m pytest tests/test_collectors_crt.py -v`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/collectors/ backend/tests/test_collectors_crt.py
git commit -m "feat: certificate transparency subdomain collector"
```

---

### Task 5: http_fingerprint collector

**Files:**
- Create: `backend/app/collectors/http_fingerprint.py`
- Modify: `backend/app/collectors/registry.py`
- Test: `backend/tests/test_collectors_fingerprint.py`

**Interfaces:**
- Consumes: `CollectorContext`, `Fact`, `EntityType`, `FactCategory` from `app.collectors.base`.
- Produces:
  - `app.collectors.http_fingerprint.collector` — `name="http_fingerprint"`, inputs `[DOMAIN]`.
  - GETs `https://{domain}` with follow_redirects; on any `httpx.HTTPError` or non-200 response, yields nothing. Otherwise yields one `has_metadata` fact (category METADATA) with `raw_data` = `{"status", "server", "title", "tech"}` where `tech` collects `x-powered-by` / `x-generator` header values and `title` is the `<title>` text (whitespace-collapsed, max 200 chars).
- Registry gains `http_fingerprint.collector`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_collectors_fingerprint.py`:

```python
import httpx
import pytest
import respx

from app.collectors.base import CollectorContext, EntityType, FactCategory
from app.collectors.http_fingerprint import collector

HTML = "<html><head><title>  Example \n Site </title></head><body>hi</body></html>"


@pytest.mark.asyncio
async def test_fingerprint_parses_title_and_headers():
    async with respx.mock:
        respx.get("https://example.com").mock(
            return_value=httpx.Response(
                200,
                headers={"server": "nginx", "x-powered-by": "Express"},
                text=HTML,
            )
        )
        async with httpx.AsyncClient(follow_redirects=True) as client:
            ctx = CollectorContext(entity_type=EntityType.DOMAIN, entity_value="example.com",
                                   client=client, max_results=50, politeness_delay=0.0)
            facts = [f async for f in collector.run(ctx)]
    assert len(facts) == 1
    f = facts[0]
    assert f.relation == "has_metadata"
    assert f.category == FactCategory.METADATA
    assert f.raw_data["title"] == "Example Site"
    assert f.raw_data["server"] == "nginx"
    assert f.raw_data["tech"] == ["Express"]


@pytest.mark.asyncio
async def test_fingerprint_connection_error_yields_nothing():
    async with respx.mock:
        respx.get("https://example.com").mock(side_effect=httpx.ConnectError("refused"))
        async with httpx.AsyncClient(follow_redirects=True) as client:
            ctx = CollectorContext(entity_type=EntityType.DOMAIN, entity_value="example.com",
                                   client=client, max_results=50, politeness_delay=0.0)
            facts = [f async for f in collector.run(ctx)]
    assert facts == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python -m pytest tests/test_collectors_fingerprint.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.collectors.http_fingerprint'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/app/collectors/http_fingerprint.py`:

```python
import re

import httpx

from .base import Collector, CollectorContext, EntityType, Fact, FactCategory

TECH_HEADERS = ("x-powered-by", "x-generator")


class HttpFingerprintCollector:
    name = "http_fingerprint"
    input_types = [EntityType.DOMAIN]
    produces = [FactCategory.METADATA]
    requires_external = False

    async def run(self, ctx: CollectorContext):
        try:
            resp = await ctx.client.get(f"https://{ctx.entity_value}", follow_redirects=True)
        except httpx.HTTPError:
            return
        if resp.status_code != 200:
            return
        title = ""
        m = re.search(r"<title[^>]*>(.*?)</title>", resp.text, re.I | re.S)
        if m:
            title = re.sub(r"\s+", " ", m.group(1)).strip()[:200]
        tech = [v for k, v in resp.headers.items() if k.lower() in TECH_HEADERS]
        yield Fact(
            source_collector=self.name,
            entity_a_type=ctx.entity_type,
            entity_a_value=ctx.entity_value,
            relation="has_metadata",
            category=FactCategory.METADATA,
            raw_data={
                "status": resp.status_code,
                "server": resp.headers.get("server"),
                "title": title,
                "tech": tech,
            },
        )


collector = HttpFingerprintCollector()
```

Modify `backend/app/collectors/registry.py` — imports and `_NATIVE`:

```python
from . import crt_sh, dns_records, http_fingerprint, whois

_NATIVE: list = [whois.collector, dns_records.collector, crt_sh.collector, http_fingerprint.collector]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python -m pytest tests/test_collectors_fingerprint.py -v`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/collectors/ backend/tests/test_collectors_fingerprint.py
git commit -m "feat: http fingerprint collector"
```

---

### Task 6: Correlation rules — normalization, merge, dedup

**Files:**
- Create: `backend/app/correlation/__init__.py`
- Create: `backend/app/correlation/rules.py`
- Test: `backend/tests/test_correlation.py`

**Interfaces:**
- Consumes: `app.core.models` (Investigation, Entity, Fact, Job), `app.core.db.SessionLocal`, `app.collectors.base.Fact`.
- Produces:
  - `app.correlation.rules.normalize_entity(entity_type: str, value: str) -> str` — email → lowercase; domain/ip → idna-encode + lowercase + strip trailing dots; phone → strip non-digits; else strip whitespace.
  - `app.correlation.rules.get_or_create(session, investigation, entity_type: str, value: str) -> Entity` — normalized lookup, insert on miss with `IntegrityError` rollback+requery race handling, appends entity to `investigation.entities`.
  - `app.correlation.rules.apply_fact(investigation_id: int, fact: Fact) -> Fact | None` — opens its own session; resolves entity_a and optional entity_b; dedupes: if a fact with the same `(source_collector, entity_a_id, relation, entity_b_id)` exists, updates `last_seen` and returns it; otherwise inserts. Returns the row, or None if the investigation is missing.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_correlation.py`:

```python
from app.collectors.base import EntityType, Fact, FactCategory
from app.core.db import SessionLocal
from app.core.models import Investigation
from app.correlation.rules import apply_fact, normalize_entity


def _make_fact(relation="registered_by", email="Admin@Example.COM"):
    return Fact(
        source_collector="whois",
        entity_a_type=EntityType.DOMAIN,
        entity_a_value="Example.com",
        entity_b_type=EntityType.EMAIL,
        entity_b_value=email,
        relation=relation,
        category=FactCategory.METADATA,
        raw_data={"email": email},
    )


def test_normalize_entity():
    assert normalize_entity("email", "Admin@Example.COM") == "admin@example.com"
    assert normalize_entity("domain", "EXAMPLE.com.") == "example.com"
    assert normalize_entity("phone", "+1 (234) 567-8900") == "12345678900"


def test_apply_fact_merges_entities_and_dedupes():
    db = SessionLocal()
    inv = Investigation(title="t", status="running")
    db.add(inv)
    db.commit()

    row1 = apply_fact(inv.id, _make_fact())
    row2 = apply_fact(inv.id, _make_fact())
    assert row1 is not None and row1.id == row2.id

    db = SessionLocal()
    got = db.get(Investigation, inv.id)
    assert {e.value for e in got.entities} == {"example.com", "admin@example.com"}
    assert len(got.facts) == 1
    db.close()


def test_apply_fact_creates_separate_edges_for_different_relations():
    db = SessionLocal()
    inv = Investigation(title="t", status="running")
    db.add(inv)
    db.commit()
    apply_fact(inv.id, _make_fact(relation="registered_by"))
    apply_fact(inv.id, _make_fact(relation="found_on"))
    db = SessionLocal()
    got = db.get(Investigation, inv.id)
    assert len(got.facts) == 2
    db.close()


def test_no_speculative_merging_of_different_people():
    db = SessionLocal()
    inv = Investigation(title="t", status="running")
    db.add(inv)
    db.commit()
    apply_fact(inv.id, Fact(
        source_collector="search_snippets", entity_a_type=EntityType.NAME,
        entity_a_value="John Smith", relation="found_on", category=FactCategory.PROFILE,
        raw_data={},
    ))
    apply_fact(inv.id, Fact(
        source_collector="search_snippets", entity_a_type=EntityType.NAME,
        entity_a_value="John Smith", relation="found_on", category=FactCategory.PROFILE,
        raw_data={"url": "https://x.com/jsmith"},
    ))
    db = SessionLocal()
    got = db.get(Investigation, inv.id)
    assert len(got.entities) == 1
    assert len(got.facts) == 1
    db.close()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python -m pytest tests/test_correlation.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.correlation'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/app/correlation/__init__.py` as an empty file.

Create `backend/app/correlation/rules.py`:

```python
import re

import idna
from sqlalchemy.exc import IntegrityError

from ..collectors.base import Fact
from ..core.db import SessionLocal
from ..core.models import Entity, Fact as FactModel, Investigation


def normalize_entity(entity_type: str, value: str) -> str:
    value = value.strip()
    if entity_type == "email":
        return value.lower()
    if entity_type in ("domain", "ip"):
        try:
            return idna.encode(value).decode().lower().rstrip(".")
        except Exception:
            return value.lower().rstrip(".")
    if entity_type == "phone":
        return re.sub(r"\D", "", value)
    return value


def get_or_create(session, investigation: Investigation, entity_type: str, value: str) -> Entity:
    normalized = normalize_entity(entity_type, value)
    ent = session.query(Entity).filter_by(type=entity_type, value=normalized).first()
    if ent is None:
        ent = Entity(type=entity_type, value=normalized)
        session.add(ent)
        try:
            session.flush()
        except IntegrityError:
            session.rollback()
            ent = session.query(Entity).filter_by(type=entity_type, value=normalized).first()
    if ent not in investigation.entities:
        investigation.entities.append(ent)
    return ent


def apply_fact(investigation_id: int, fact: Fact) -> FactModel | None:
    session = SessionLocal()
    try:
        investigation = session.get(Investigation, investigation_id)
        if investigation is None:
            return None
        a = get_or_create(session, investigation, fact.entity_a_type.value, fact.entity_a_value)
        b = None
        if fact.entity_b_type is not None and fact.entity_b_value is not None:
            b = get_or_create(session, investigation, fact.entity_b_type.value, fact.entity_b_value)
        existing = (
            session.query(FactModel)
            .filter_by(
                investigation_id=investigation_id,
                source_collector=fact.source_collector,
                entity_a_id=a.id,
                relation=fact.relation,
                entity_b_id=b.id if b else None,
            )
            .first()
        )
        if existing is not None:
            session.commit()
            return existing
        row = FactModel(
            investigation_id=investigation_id,
            source_collector=fact.source_collector,
            entity_a_id=a.id,
            entity_b_id=b.id if b else None,
            relation=fact.relation,
            category=fact.category.value,
            confidence=fact.confidence,
            raw_data=fact.raw_data,
        )
        session.add(row)
        session.commit()
        return row
    finally:
        session.close()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python -m pytest tests/test_correlation.py -v`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/correlation/ backend/tests/test_correlation.py
git commit -m "feat: correlation rules with entity normalization, merge, and fact dedup"
```

---

### Task 7: Pipeline — scan engine, job tracking, SSE events

**Files:**
- Create: `backend/app/pipeline/__init__.py`
- Create: `backend/app/pipeline/events.py`
- Create: `backend/app/pipeline/runner.py`
- Test: `backend/tests/test_pipeline.py`

**Interfaces:**
- Consumes: `app.collectors.base` (EntityType, CollectorContext), `app.collectors.registry.all_collectors_for`, `app.correlation.rules.apply_fact`, `app.core.models`, `app.core.db.SessionLocal`, `app.config.settings`.
- Produces:
  - `app.pipeline.events.publish(investigation_id: int, event: dict) -> None` — thread-safe (uses `queue.Queue`).
  - `app.pipeline.events.stream(investigation_id: int) -> queue.Queue` — returns the queue for an investigation.
  - `app.pipeline.runner.trigger_scan(investigation_id: int) -> None` — starts a daemon thread running `asyncio.run(run_scan(investigation_id))`; returns immediately.
  - `app.pipeline.runner.run_scan(investigation_id: int) -> None` — sets investigation `running`; for each seed entity × matching collector, skips if a Job with the same `(entity_id, collector_name)` exists in `queued|running|done|partial`; otherwise spawns `run_job`; gathers all; sets investigation `done`; publishes `{"type": "scan_done", "investigation_id": n}`.
  - `app.pipeline.runner.run_job(investigation_id: int, entity: Entity, collector) -> None` — creates Job `running` (publishes `job_status`); if `collector.requires_external` and `is_available()` is falsy → `skipped` with `collector.install_hint`; runs the collector with a `CollectorContext` using a per-job `httpx.AsyncClient` (timeout from settings, UA `osint-framework/0.1`); applies each fact via `apply_fact`; publishes `{"type": "graph_delta", "fact": {...}}` every 5 facts; sets final status `done` (≥1 result) or `partial` (0 results); exceptions → `failed` with error message; publishes `job_status` on every transition.
- Event shapes: `{"type": "job_status", "job": {"id", "collector_name", "status", "result_count", "error_message", "entity": {"type","value"}}}`, `{"type": "graph_delta", "fact": {"source_collector", "relation", "entity_a": {"type","value"}, "entity_b": {"type","value"}|null}}`, `{"type": "scan_done", "investigation_id": int}`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_pipeline.py`:

```python
import asyncio
import time

from app.collectors import registry
from app.collectors.base import EntityType, Fact, FactCategory
from app.core.db import SessionLocal
from app.core.models import Entity, Fact as FactRow, Investigation, Job
from app.pipeline.runner import run_scan


class _FakeCollector:
    name = "fake_collector"
    input_types = [EntityType.DOMAIN]
    produces = [FactCategory.METADATA]
    requires_external = False

    async def run(self, ctx):
        yield Fact(
            source_collector=self.name,
            entity_a_type=ctx.entity_type,
            entity_a_value=ctx.entity_value,
            entity_b_type=EntityType.EMAIL,
            entity_b_value="admin@fake.test",
            relation="registered_by",
            category=FactCategory.METADATA,
            raw_data={"email": "admin@fake.test"},
        )


def _wait_until_done(db, inv_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        inv = db.get(Investigation, inv_id)
        jobs = db.query(Job).filter_by(investigation_id=inv_id).all()
        if inv.status == "done" and all(j.status in ("done", "partial", "failed", "skipped") for j in jobs):
            return inv, jobs
        time.sleep(0.2)
    raise AssertionError("scan did not finish in time")


def test_run_scan_collects_facts_and_tracks_jobs(monkeypatch):
    def fake_collectors_for(entity_type):
        return [_FakeCollector()]

    monkeypatch.setattr(registry, "all_collectors_for", fake_collectors_for)

    db = SessionLocal()
    inv = Investigation(title="t", status="running")
    ent = Entity(type="domain", value="example.com")
    inv.entities.append(ent)
    db.add(inv)
    db.commit()
    inv_id = inv.id
    db.close()

    asyncio.run(run_scan(inv_id))

    db = SessionLocal()
    inv, jobs = _wait_until_done(db, inv_id)
    assert inv.status == "done"
    assert len(jobs) == 1
    assert jobs[0].status == "done"
    assert jobs[0].result_count == 1
    facts = db.query(FactRow).filter_by(investigation_id=inv_id).all()
    assert len(facts) == 1
    assert facts[0].relation == "registered_by"
    db.close()


def test_run_scan_does_not_duplicate_done_jobs(monkeypatch):
    def fake_collectors_for(entity_type):
        return [_FakeCollector()]

    monkeypatch.setattr(registry, "all_collectors_for", fake_collectors_for)

    db = SessionLocal()
    inv = Investigation(title="t", status="running")
    ent = Entity(type="domain", value="example.com")
    inv.entities.append(ent)
    db.add(inv)
    db.commit()
    inv_id = inv.id
    db.close()

    asyncio.run(run_scan(inv_id))
    db = SessionLocal()
    _wait_until_done(db, inv_id)
    db.close()

    asyncio.run(run_scan(inv_id))
    time.sleep(1)

    db = SessionLocal()
    assert db.query(Job).filter_by(investigation_id=inv_id).count() == 1
    db.close()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python -m pytest tests/test_pipeline.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.pipeline'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/app/pipeline/__init__.py` as an empty file.

Create `backend/app/pipeline/events.py`:

```python
from queue import Queue

_streams: dict[int, Queue] = {}


def publish(investigation_id: int, event: dict) -> None:
    _streams.setdefault(investigation_id, Queue()).put(event)


def stream(investigation_id: int) -> Queue:
    return _streams.setdefault(investigation_id, Queue())
```

Create `backend/app/pipeline/runner.py`:

```python
import asyncio
import threading

import httpx

from ..collectors import registry
from ..collectors.base import CollectorContext, EntityType
from ..config import settings
from ..core.db import SessionLocal
from ..core.models import Entity, Investigation, Job, utcnow
from ..correlation.rules import apply_fact
from .events import publish

SKIP_STATUSES = ("queued", "running", "done", "partial")


def trigger_scan(investigation_id: int) -> None:
    threading.Thread(
        target=lambda: asyncio.run(run_scan(investigation_id)), daemon=True
    ).start()


def _job_event(job: Job, entity: Entity) -> dict:
    return {
        "type": "job_status",
        "job": {
            "id": job.id,
            "collector_name": job.collector_name,
            "status": job.status,
            "result_count": job.result_count,
            "error_message": job.error_message,
            "entity": {"type": entity.type, "value": entity.value},
        },
    }


def _fact_event(fact) -> dict:
    return {
        "type": "graph_delta",
        "fact": {
            "source_collector": fact.source_collector,
            "relation": fact.relation,
            "entity_a": {"type": fact.entity_a_type.value, "value": fact.entity_a_value},
            "entity_b": (
                {"type": fact.entity_b_type.value, "value": fact.entity_b_value}
                if fact.entity_b_type and fact.entity_b_value
                else None
            ),
        },
    }


async def run_job(investigation_id: int, entity: Entity, collector) -> None:
    session = SessionLocal()
    job = None
    try:
        job = Job(
            investigation_id=investigation_id,
            entity_id=entity.id,
            collector_name=collector.name,
            status="running",
            started_at=utcnow(),
        )
        session.add(job)
        session.commit()
        publish(investigation_id, _job_event(job, entity))

        if getattr(collector, "requires_external", False) and not collector.is_available():
            job.status = "skipped"
            job.error_message = getattr(collector, "install_hint", "external tool not found")
            job.finished_at = utcnow()
            session.commit()
            publish(investigation_id, _job_event(job, entity))
            return

        async with httpx.AsyncClient(
            timeout=settings.http_timeout,
            follow_redirects=True,
            headers={"User-Agent": "osint-framework/0.1"},
        ) as client:
            ctx = CollectorContext(
                entity_type=EntityType(entity.type),
                entity_value=entity.value,
                client=client,
                max_results=settings.max_results_per_collector,
                politeness_delay=settings.politeness_delay,
            )
            count = 0
            attempts = 0
            while attempts < 2:
                try:
                    async for fact in collector.run(ctx):
                        apply_fact(investigation_id, fact)
                        count += 1
                        if count % 5 == 0:
                            job.result_count = count
                            session.commit()
                            publish(investigation_id, _fact_event(fact))
                        if ctx.politeness_delay:
                            await asyncio.sleep(ctx.politeness_delay)
                    break
                except Exception:
                    attempts += 1
                    if attempts >= 2:
                        raise
                    await asyncio.sleep(1)
            job.result_count = count
            job.status = "done" if count else "partial"
            job.finished_at = utcnow()
            session.commit()
            publish(investigation_id, _job_event(job, entity))
    except Exception as exc:
        if job is not None:
            job.status = "failed"
            job.error_message = f"{type(exc).__name__}: {exc}"
            job.finished_at = utcnow()
            session.commit()
            publish(investigation_id, _job_event(job, entity))
    finally:
        session.close()


async def run_scan(investigation_id: int) -> None:
    session = SessionLocal()
    try:
        inv = session.get(Investigation, investigation_id)
        if inv is None:
            return
        inv.status = "running"
        session.commit()
        tasks = []
        for entity in list(inv.entities):
            for collector in registry.all_collectors_for(entity.type):
                existing = (
                    session.query(Job)
                    .filter_by(
                        investigation_id=investigation_id,
                        entity_id=entity.id,
                        collector_name=collector.name,
                    )
                    .all()
                )
                if any(j.status in SKIP_STATUSES for j in existing):
                    continue
                tasks.append(asyncio.create_task(run_job(investigation_id, entity, collector)))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        inv = session.get(Investigation, investigation_id)
        inv.status = "done"
        session.commit()
        publish(investigation_id, {"type": "scan_done", "investigation_id": investigation_id})
    finally:
        session.close()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python -m pytest tests/test_pipeline.py -v`
Expected: 2 tests PASS. (Graph-delta events publish every 5 facts; single-fact runs publish only `job_status` and `scan_done`.)

- [ ] **Step 5: Commit**

```bash
git add backend/app/pipeline/ backend/tests/test_pipeline.py
git commit -m "feat: scan pipeline with job tracking and sse events"
```

---

### Task 8: API routers — investigations, graph, profile, scan, resume, SSE

**Files:**
- Create: `backend/app/api/__init__.py`
- Create: `backend/app/api/serializers.py`
- Create: `backend/app/api/investigations.py`
- Create: `backend/app/api/entities.py`
- Create: `backend/app/api/jobs.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_api.py`

**Interfaces:**
- Consumes: `app.pipeline.runner.trigger_scan`, `app.pipeline.events.stream`, models, `app.core.db.SessionLocal`.
- Produces (all under prefix `/api`):
  - `POST /api/investigations` body `{"title": str, "seeds": [{"type": str, "value": str}]}` → creates investigation (status `running`), upserts seed entities, triggers scan, returns `{"id", "title", "status"}`.
  - `GET /api/investigations` → list of `{"id", "title", "status", "created_at"}` ordered by created_at desc.
  - `GET /api/investigations/{id}` → `{"id", "title", "status", "entities": [{"id","type","value"}], "jobs": [{"id", "collector_name", "status", "result_count", "error_message", "entity": {"type","value"}}]}`.
  - `POST /api/investigations/{id}/scan` and `POST /api/investigations/{id}/resume` → both call `trigger_scan(id)` (skip logic in the runner makes resume a safe re-run); 404 if missing; return `{"status": "started"}`.
  - `GET /api/investigations/{id}/graph` → `{"nodes": [{"data": {"id", "label", "type"}}], "edges": [{"data": {"id", "source", "target", "label", "fact_id"}}]}` — node ids are `e{entity_id}`, edge ids `f{fact_id}`; nodes come from both sides of every fact.
  - `GET /api/investigations/{id}/entities/{entity_id}` → `{"entity": {"id","type","value"}, "facts": {category: [fact_dict]}}` grouped by category, facts where entity is either side.
  - `GET /api/investigations/{id}/facts/{fact_id}` → full fact dict (edge evidence panel).
  - `GET /api/investigations/{id}/stream` → SSE: yields `data: {json}` lines; events from `events.stream(id)`; 25s keepalive comments (`: keepalive`); closes after a `scan_done` event. Media type `text/event-stream`.
  - `app.api.serializers.fact_to_dict(fact) -> dict` — `{"id", "source_collector", "relation", "category", "confidence", "raw_data", "first_seen", "last_seen", "entity_a": {"id","type","value"}, "entity_b": {…}|null}`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api.py`:

```python
import json
import time

from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.core.models import Investigation, Job
from app.main import app

client = TestClient(app)


def _create_investigation(title="t"):
    resp = client.post("/api/investigations", json={
        "title": title,
        "seeds": [{"type": "domain", "value": "example.com"}],
    })
    assert resp.status_code == 200
    return resp.json()


def _wait_until_done(inv_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = client.get(f"/api/investigations/{inv_id}").json()
        if data["status"] == "done":
            return data
        time.sleep(0.2)
    raise AssertionError("scan did not finish")


def test_create_and_list_investigation():
    inv = _create_investigation("my first")
    assert inv["status"] == "running"
    lst = client.get("/api/investigations").json()
    assert any(i["id"] == inv["id"] and i["title"] == "my first" for i in lst)


def test_investigation_detail_has_seeds_and_jobs():
    inv = _create_investigation()
    data = _wait_until_done(inv["id"])
    assert [e["value"] for e in data["entities"]] == ["example.com"]
    assert all(j["status"] in ("done", "partial", "failed", "skipped") for j in data["jobs"])


def test_graph_endpoint_returns_nodes_and_edges():
    inv = _create_investigation()
    _wait_until_done(inv["id"])
    graph = client.get(f"/api/investigations/{inv['id']}/graph").json()
    assert len(graph["nodes"]) >= 1
    assert any(n["data"]["type"] == "domain" for n in graph["nodes"])


def test_scan_and_resume_endpoints():
    inv = _create_investigation()
    _wait_until_done(inv["id"])
    r1 = client.post(f"/api/investigations/{inv['id']}/scan")
    assert r1.status_code == 200
    r2 = client.post(f"/api/investigations/{inv['id']}/resume")
    assert r2.status_code == 200
    assert client.post("/api/investigations/99999/scan").status_code == 404


def test_profile_and_fact_endpoints():
    inv = _create_investigation()
    _wait_until_done(inv["id"])
    data = client.get(f"/api/investigations/{inv['id']}").json()
    entity_id = data["entities"][0]["id"]
    profile = client.get(f"/api/investigations/{inv['id']}/entities/{entity_id}").json()
    assert profile["entity"]["id"] == entity_id
    all_facts = []
    for facts in profile["facts"].values():
        all_facts.extend(facts)
    assert len(all_facts) >= 1
    fact = client.get(f"/api/investigations/{inv['id']}/facts/{all_facts[0]['id']}").json()
    assert fact["id"] == all_facts[0]["id"]


def test_sse_stream_emits_scan_done():
    inv = _create_investigation()
    with client.stream("GET", f"/api/investigations/{inv['id']}/stream") as resp:
        assert resp.status_code == 200
        seen = set()
        for line in resp.iter_lines():
            if line.startswith("data: "):
                ev = json.loads(line[6:])
                seen.add(ev["type"])
                if ev["type"] == "scan_done":
                    break
    assert "scan_done" in seen
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python -m pytest tests/test_api.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.api'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/app/api/__init__.py` as an empty file.

Create `backend/app/api/serializers.py`:

```python
from ..core.models import Entity, Fact


def entity_dict(e: Entity) -> dict:
    return {"id": e.id, "type": e.type, "value": e.value}


def fact_to_dict(f: Fact) -> dict:
    return {
        "id": f.id,
        "source_collector": f.source_collector,
        "relation": f.relation,
        "category": f.category,
        "confidence": f.confidence,
        "raw_data": f.raw_data,
        "first_seen": f.first_seen.isoformat() if f.first_seen else None,
        "last_seen": f.last_seen.isoformat() if f.last_seen else None,
        "entity_a": entity_dict(f.entity_a),
        "entity_b": entity_dict(f.entity_b) if f.entity_b else None,
    }


def job_dict(job) -> dict:
    return {
        "id": job.id,
        "collector_name": job.collector_name,
        "status": job.status,
        "result_count": job.result_count,
        "error_message": job.error_message,
        "entity": {"type": job.entity.type, "value": job.entity.value},
    }
```

Create `backend/app/api/investigations.py`:

```python
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core.db import SessionLocal
from ..core.models import Entity, Investigation
from ..pipeline import runner
from .serializers import job_dict

router = APIRouter(tags=["investigations"])


class SeedInput(BaseModel):
    type: str
    value: str


class InvestigationCreate(BaseModel):
    title: str
    seeds: list[SeedInput]


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/investigations")
def create_investigation(payload: InvestigationCreate, db: Session = Depends(get_db)):
    inv = Investigation(title=payload.title, status="running")
    db.add(inv)
    db.flush()
    for seed in payload.seeds:
        ent = db.query(Entity).filter_by(type=seed.type, value=seed.value).first()
        if ent is None:
            ent = Entity(type=seed.type, value=seed.value)
            db.add(ent)
            db.flush()
        if ent not in inv.entities:
            inv.entities.append(ent)
    db.commit()
    runner.trigger_scan(inv.id)
    return {"id": inv.id, "title": inv.title, "status": inv.status}


@router.get("/investigations")
def list_investigations(db: Session = Depends(get_db)):
    rows = db.query(Investigation).order_by(Investigation.created_at.desc()).all()
    return [
        {"id": i.id, "title": i.title, "status": i.status,
         "created_at": i.created_at.isoformat() if i.created_at else None}
        for i in rows
    ]


@router.get("/investigations/{inv_id}")
def get_investigation(inv_id: int, db: Session = Depends(get_db)):
    inv = db.get(Investigation, inv_id)
    if inv is None:
        raise HTTPException(404, "investigation not found")
    return {
        "id": inv.id,
        "title": inv.title,
        "status": inv.status,
        "entities": [{"id": e.id, "type": e.type, "value": e.value} for e in inv.entities],
        "jobs": [job_dict(j) for j in inv.jobs],
    }


def _start_scan(inv_id: int, db: Session) -> dict:
    inv = db.get(Investigation, inv_id)
    if inv is None:
        raise HTTPException(404, "investigation not found")
    runner.trigger_scan(inv_id)
    return {"status": "started"}


@router.post("/investigations/{inv_id}/scan")
def scan(inv_id: int, db: Session = Depends(get_db)):
    return _start_scan(inv_id, db)


@router.post("/investigations/{inv_id}/resume")
def resume(inv_id: int, db: Session = Depends(get_db)):
    return _start_scan(inv_id, db)
```

Create `backend/app/api/entities.py`:

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..core.db import SessionLocal
from ..core.models import Entity, Fact, Investigation
from .serializers import entity_dict, fact_to_dict

router = APIRouter(tags=["entities"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/investigations/{inv_id}/graph")
def graph(inv_id: int, db: Session = Depends(get_db)):
    inv = db.get(Investigation, inv_id)
    if inv is None:
        raise HTTPException(404, "investigation not found")
    facts = db.query(Fact).filter_by(investigation_id=inv_id).all()
    nodes = {}
    edges = []
    for f in facts:
        for e in (f.entity_a, f.entity_b):
            if e is not None and e.id not in nodes:
                nodes[e.id] = {"data": {"id": f"e{e.id}", "label": e.value, "type": e.type}}
        if f.entity_b is not None:
            edges.append({
                "data": {
                    "id": f"f{f.id}",
                    "source": f"e{f.entity_a_id}",
                    "target": f"e{f.entity_b_id}",
                    "label": f.relation,
                    "fact_id": f.id,
                }
            })
    return {"nodes": list(nodes.values()), "edges": edges}


@router.get("/investigations/{inv_id}/entities/{entity_id}")
def profile(inv_id: int, entity_id: int, db: Session = Depends(get_db)):
    entity = db.get(Entity, entity_id)
    if entity is None:
        raise HTTPException(404, "entity not found")
    facts = (
        db.query(Fact)
        .filter_by(investigation_id=inv_id)
        .filter(or_(Fact.entity_a_id == entity_id, Fact.entity_b_id == entity_id))
        .all()
    )
    grouped: dict[str, list] = {}
    for f in facts:
        grouped.setdefault(f.category, []).append(fact_to_dict(f))
    return {"entity": entity_dict(entity), "facts": grouped}


@router.get("/investigations/{inv_id}/facts/{fact_id}")
def fact_detail(inv_id: int, fact_id: int, db: Session = Depends(get_db)):
    f = db.query(Fact).filter_by(investigation_id=inv_id, id=fact_id).first()
    if f is None:
        raise HTTPException(404, "fact not found")
    return fact_to_dict(f)
```

Create `backend/app/api/jobs.py`:

```python
import asyncio
import json

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from ..pipeline.events import stream

router = APIRouter(tags=["jobs"])


@router.get("/investigations/{inv_id}/stream")
async def sse(inv_id: int):
    q = stream(inv_id)

    async def gen():
        yield "event: hello\ndata: {}\n\n"
        while True:
            try:
                event = await asyncio.to_thread(q.get, True, 25)
            except Exception:
                yield ": keepalive\n\n"
                continue
            yield f"data: {json.dumps(event)}\n\n"
            if event.get("type") == "scan_done":
                break

    return StreamingResponse(gen(), media_type="text/event-stream")
```

Modify `backend/app/main.py` — replace the whole file:

```python
from fastapi import FastAPI

from .api import entities, investigations, jobs
from .core.db import init_db


def create_app() -> FastAPI:
    init_db()
    app = FastAPI(title="OSINT Framework")
    app.include_router(investigations.router, prefix="/api")
    app.include_router(entities.router, prefix="/api")
    app.include_router(jobs.router, prefix="/api")
    return app


app = create_app()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python -m pytest tests/test_api.py -v`
Expected: 6 tests PASS. (Scans run on real network sources like rdap.org here — they may return few or no facts; the tests assert structural invariants only, which is why they pass with any source outcome.)

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/ backend/app/main.py backend/tests/test_api.py
git commit -m "feat: api routers for investigations, graph, profile, scan, resume, sse"
```

---

### Task 9: External tool wrappers — Sherlock, Subfinder, Holehe

**Files:**
- Create: `backend/app/tools/__init__.py`
- Create: `backend/app/tools/base.py`
- Create: `backend/app/tools/sherlock.py`
- Create: `backend/app/tools/subfinder.py`
- Create: `backend/app/tools/holehe.py`
- Modify: `backend/app/collectors/registry.py`
- Test: `backend/tests/test_tools.py`

**Interfaces:**
- Consumes: `CollectorContext`, `Fact`, `EntityType`, `FactCategory`; registry `_EXTERNAL`.
- Produces:
  - `app.tools.base.ExternalTool(binary: str, install_hint: str, name: str)` with `is_available() -> bool` (via `shutil.which`) and `async run(args: list[str], timeout: float = 60) -> str` — subprocess via `asyncio.create_subprocess_exec`, hard timeout kill → `RuntimeError`, non-zero exit → `RuntimeError` with stderr snippet.
  - `app.tools.sherlock.collector` — `name="sherlock"`, inputs `[USERNAME]`, `requires_external=True`, `install_hint="pipx install sherlock-project"`. Runs `sherlock --print-found {username}` (timeout 120), parses `[+] <url>` lines into `profile_of` PROFILE facts with `raw_data={"url": ...}`.
  - `app.tools.subfinder.collector` — `name="subfinder"`, inputs `[DOMAIN]`, `requires_external=True`, `install_hint="go install -v github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest"`. Runs `subfinder -d {domain} -silent` (timeout 120), parses line-per-subdomain into `resolves_to` INFRA facts (`raw_data={"subdomain": ...}`), entity_b `DOMAIN`.
  - `app.tools.holehe.collector` — `name="holehe"`, inputs `[EMAIL]`, `requires_external=True`, `install_hint="pipx install holehe"`. Runs `holehe --no-color {email}` (timeout 120), parses `[+] <service>` lines into `found_on` PROFILE facts with `raw_data={"service": ...}`.
  - Registry `_EXTERNAL` gains all three; `all_collectors_for` already merges `_NATIVE + _EXTERNAL`.
  - Each wrapper collector exposes `is_available()` and `install_hint`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_tools.py`:

```python
import sys
from pathlib import Path

import httpx
import pytest

from app.tools.sherlock import collector as sherlock
from app.tools.subfinder import collector as subfinder
from app.tools.holehe import collector as holehe
from app.collectors.base import CollectorContext, EntityType


@pytest.fixture
def fake_binaries(tmp_path, monkeypatch):
    scripts = {
        "sherlock": "#!/bin/sh\necho '[+] https://github.com/jdoe'\necho '[-] not-found.example'\n",
        "subfinder": "#!/bin/sh\necho 'www.example.com'\necho 'api.example.com'\n",
        "holehe": "#!/bin/sh\necho '[+] instagram.com'\necho '[-] facebook.com'\n",
    }
    for name, body in scripts.items():
        p = tmp_path / name
        p.write_text(body)
        p.chmod(0o755)
    import app.tools.base as tb

    def fake_which(cmd):
        return str(tmp_path / cmd) if cmd in scripts else None

    monkeypatch.setattr(tb.shutil, "which", fake_which)
    return scripts


@pytest.mark.asyncio
async def test_tools_are_available_with_fake_binaries(fake_binaries):
    assert sherlock.is_available()
    assert subfinder.is_available()
    assert holehe.is_available()


@pytest.mark.asyncio
async def test_sherlock_parses_found_profiles(fake_binaries):
    async with httpx.AsyncClient() as client:
        ctx = CollectorContext(entity_type=EntityType.USERNAME, entity_value="jdoe",
                               client=client, max_results=50, politeness_delay=0.0)
        facts = [f async for f in sherlock.run(ctx)]
    assert len(facts) == 1
    assert facts[0].relation == "profile_of"
    assert facts[0].raw_data["url"] == "https://github.com/jdoe"
    assert facts[0].entity_a_value == "jdoe"


@pytest.mark.asyncio
async def test_subfinder_parses_subdomains(fake_binaries):
    async with httpx.AsyncClient() as client:
        ctx = CollectorContext(entity_type=EntityType.DOMAIN, entity_value="example.com",
                               client=client, max_results=50, politeness_delay=0.0)
        facts = [f async for f in subfinder.run(ctx)]
    assert {f.entity_b_value for f in facts} == {"www.example.com", "api.example.com"}
    assert all(f.relation == "resolves_to" for f in facts)


@pytest.mark.asyncio
async def test_holehe_parses_found_services(fake_binaries):
    async with httpx.AsyncClient() as client:
        ctx = CollectorContext(entity_type=EntityType.EMAIL, entity_value="jdoe@example.com",
                               client=client, max_results=50, politeness_delay=0.0)
        facts = [f async for f in holehe.run(ctx)]
    assert len(facts) == 1
    assert facts[0].relation == "found_on"
    assert facts[0].raw_data["service"] == "instagram.com"
```

Note: on Windows the `#!/bin/sh` scripts need an sh-compatible shell — if `sh` is unavailable the fake-binary tests will fail with a subprocess error. In that case replace the fixture scripts with `.bat`/`.cmd` files per platform and adjust `fake_which` to return the `cmd` file. The parsing logic is what matters, not the shell.

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python -m pytest tests/test_tools.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.tools'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/app/tools/__init__.py` as an empty file.

Create `backend/app/tools/base.py`:

```python
import asyncio
import shutil


class ExternalTool:
    def __init__(self, name: str, binary: str, install_hint: str):
        self.name = name
        self.binary = binary
        self.install_hint = install_hint

    def is_available(self) -> bool:
        return shutil.which(self.binary) is not None

    async def run(self, args: list[str], timeout: float = 60) -> str:
        proc = await asyncio.create_subprocess_exec(
            self.binary, *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError(f"{self.name} timed out after {timeout}s")
        if proc.returncode != 0:
            raise RuntimeError(
                f"{self.name} exited {proc.returncode}: {err.decode(errors='replace')[:200]}"
            )
        return out.decode(errors="replace")
```

Create `backend/app/tools/sherlock.py`:

```python
from ..collectors.base import CollectorContext, EntityType, Fact, FactCategory
from .base import ExternalTool


class SherlockCollector:
    name = "sherlock"
    input_types = [EntityType.USERNAME]
    produces = [FactCategory.PROFILE]
    requires_external = True
    install_hint = "pipx install sherlock-project"
    tool = ExternalTool(name="sherlock", binary="sherlock", install_hint=install_hint)

    def is_available(self) -> bool:
        return self.tool.is_available()

    async def run(self, ctx: CollectorContext):
        out = await self.tool.run(["--print-found", ctx.entity_value], timeout=120)
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("[+]"):
                url = line[3:].strip()
                yield Fact(
                    source_collector=self.name,
                    entity_a_type=ctx.entity_type,
                    entity_a_value=ctx.entity_value,
                    relation="profile_of",
                    category=FactCategory.PROFILE,
                    raw_data={"url": url},
                )


collector = SherlockCollector()
```

Create `backend/app/tools/subfinder.py`:

```python
from ..collectors.base import CollectorContext, EntityType, Fact, FactCategory
from .base import ExternalTool


class SubfinderCollector:
    name = "subfinder"
    input_types = [EntityType.DOMAIN]
    produces = [FactCategory.INFRA]
    requires_external = True
    install_hint = "go install -v github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest"
    tool = ExternalTool(name="subfinder", binary="subfinder", install_hint=install_hint)

    def is_available(self) -> bool:
        return self.tool.is_available()

    async def run(self, ctx: CollectorContext):
        out = await self.tool.run(["-d", ctx.entity_value, "-silent"], timeout=120)
        for line in out.splitlines():
            name = line.strip()
            if name:
                yield Fact(
                    source_collector=self.name,
                    entity_a_type=ctx.entity_type,
                    entity_a_value=ctx.entity_value,
                    entity_b_type=EntityType.DOMAIN,
                    entity_b_value=name,
                    relation="resolves_to",
                    category=FactCategory.INFRA,
                    raw_data={"subdomain": name},
                )


collector = SubfinderCollector()
```

Create `backend/app/tools/holehe.py`:

```python
from ..collectors.base import CollectorContext, EntityType, Fact, FactCategory
from .base import ExternalTool


class HoleheCollector:
    name = "holehe"
    input_types = [EntityType.EMAIL]
    produces = [FactCategory.PROFILE]
    requires_external = True
    install_hint = "pipx install holehe"
    tool = ExternalTool(name="holehe", binary="holehe", install_hint=install_hint)

    def is_available(self) -> bool:
        return self.tool.is_available()

    async def run(self, ctx: CollectorContext):
        out = await self.tool.run(["--no-color", ctx.entity_value], timeout=120)
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("[+]"):
                service = line[3:].strip()
                yield Fact(
                    source_collector=self.name,
                    entity_a_type=ctx.entity_type,
                    entity_a_value=ctx.entity_value,
                    relation="found_on",
                    category=FactCategory.PROFILE,
                    raw_data={"service": service},
                )


collector = HoleheCollector()
```

Modify `backend/app/collectors/registry.py` — replace the whole file:

```python
from typing import TYPE_CHECKING

from . import crt_sh, dns_records, http_fingerprint, whois
from .base import EntityType
from ..tools import holehe, sherlock, subfinder

if TYPE_CHECKING:
    from .base import Collector

_NATIVE: list = [
    whois.collector,
    dns_records.collector,
    crt_sh.collector,
    http_fingerprint.collector,
]
_EXTERNAL: list = [sherlock.collector, subfinder.collector, holehe.collector]


def all_collectors_for(entity_type: str) -> list["Collector"]:
    t = EntityType(entity_type)
    return [c for c in _NATIVE + _EXTERNAL if t in c.input_types]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python -m pytest tests/test_tools.py -v`
Expected: 4 tests PASS (assuming an `sh`-compatible shell is available; see the note above for the Windows fallback).

- [ ] **Step 5: Commit**

```bash
git add backend/app/tools/ backend/app/collectors/registry.py backend/tests/test_tools.py
git commit -m "feat: external tool wrappers for sherlock, subfinder, holehe"
```

---

### Task 10: GitHub collectors — username profile, email commit search

**Files:**
- Create: `backend/app/collectors/github_user.py`
- Create: `backend/app/collectors/github_commits.py`
- Modify: `backend/app/collectors/registry.py`
- Test: `backend/tests/test_collectors_github.py`

**Interfaces:**
- Consumes: `CollectorContext`, `Fact`, `EntityType`, `FactCategory`.
- Produces:
  - `app.collectors.github_user.collector` — `name="github_user"`, inputs `[USERNAME]`. GETs `https://api.github.com/users/{username}`; on non-200 yields nothing; else yields one `profile_of` PROFILE fact with `raw_data` = `{"url", "name", "bio", "location", "followers", "public_repos"}` (nulls allowed).
  - `app.collectors.github_commits.collector` — `name="github_commits"`, inputs `[EMAIL]`. GETs `https://api.github.com/search/commits?q={email}` with header `Accept: application/vnd.github+json`; on non-200 yields nothing; for items (capped at `ctx.max_results`) yields `profile_of` facts with entity_b `USERNAME` = repo owner (`repository.full_name` before `/`) when present, else `found_on` with no entity_b. `raw_data` = `{"repo", "url", "message"}` (message truncated to 200 chars).
- Registry gains both.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_collectors_github.py`:

```python
import httpx
import pytest
import respx

from app.collectors.base import CollectorContext, EntityType
from app.collectors.github_commits import collector as commits
from app.collectors.github_user import collector as user

USER_JSON = {
    "html_url": "https://github.com/jdoe",
    "name": "Jane Doe",
    "bio": "engineer",
    "location": "KL",
    "followers": 12,
    "public_repos": 3,
}

SEARCH_JSON = {
    "items": [
        {
            "repository": {"full_name": "jdoe/dotfiles"},
            "html_url": "https://github.com/jdoe/dotfiles/commit/abc",
            "commit": {"author": {"name": "Jane"}, "message": "init"},
        }
    ]
}


@pytest.mark.asyncio
async def test_github_user_profile():
    async with respx.mock:
        respx.get("https://api.github.com/users/jdoe").mock(return_value=httpx.Response(200, json=USER_JSON))
        async with httpx.AsyncClient() as client:
            ctx = CollectorContext(entity_type=EntityType.USERNAME, entity_value="jdoe",
                                   client=client, max_results=50, politeness_delay=0.0)
            facts = [f async for f in user.run(ctx)]
    assert len(facts) == 1
    assert facts[0].relation == "profile_of"
    assert facts[0].raw_data["url"] == "https://github.com/jdoe"


@pytest.mark.asyncio
async def test_github_commits_link_email_to_repo_owner():
    async with respx.mock:
        respx.get("https://api.github.com/search/commits", params={"q": "jane@example.com"}).mock(
            return_value=httpx.Response(200, json=SEARCH_JSON)
        )
        async with httpx.AsyncClient() as client:
            ctx = CollectorContext(entity_type=EntityType.EMAIL, entity_value="jane@example.com",
                                   client=client, max_results=50, politeness_delay=0.0)
            facts = [f async for f in commits.run(ctx)]
    assert len(facts) == 1
    f = facts[0]
    assert f.relation == "profile_of"
    assert f.entity_b_type == EntityType.USERNAME
    assert f.entity_b_value == "jdoe"
    assert f.raw_data["repo"] == "jdoe/dotfiles"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python -m pytest tests/test_collectors_github.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.collectors.github_user'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/app/collectors/github_user.py`:

```python
from .base import Collector, CollectorContext, EntityType, Fact, FactCategory


class GithubUserCollector:
    name = "github_user"
    input_types = [EntityType.USERNAME]
    produces = [FactCategory.PROFILE]
    requires_external = False

    async def run(self, ctx: CollectorContext):
        resp = await ctx.client.get(f"https://api.github.com/users/{ctx.entity_value}")
        if resp.status_code != 200:
            return
        data = resp.json()
        yield Fact(
            source_collector=self.name,
            entity_a_type=ctx.entity_type,
            entity_a_value=ctx.entity_value,
            relation="profile_of",
            category=FactCategory.PROFILE,
            raw_data={
                "url": data.get("html_url"),
                "name": data.get("name"),
                "bio": data.get("bio"),
                "location": data.get("location"),
                "followers": data.get("followers"),
                "public_repos": data.get("public_repos"),
            },
        )


collector = GithubUserCollector()
```

Create `backend/app/collectors/github_commits.py`:

```python
from .base import Collector, CollectorContext, EntityType, Fact, FactCategory


class GithubCommitsCollector:
    name = "github_commits"
    input_types = [EntityType.EMAIL]
    produces = [FactCategory.PROFILE]
    requires_external = False

    async def run(self, ctx: CollectorContext):
        resp = await ctx.client.get(
            "https://api.github.com/search/commits",
            params={"q": ctx.entity_value},
            headers={"Accept": "application/vnd.github+json"},
        )
        if resp.status_code != 200:
            return
        for item in resp.json().get("items", [])[: ctx.max_results]:
            repo = item.get("repository", {}).get("full_name", "")
            owner = repo.split("/")[0] if "/" in repo else None
            message = item.get("commit", {}).get("message", "")[:200]
            if owner:
                yield Fact(
                    source_collector=self.name,
                    entity_a_type=ctx.entity_type,
                    entity_a_value=ctx.entity_value,
                    entity_b_type=EntityType.USERNAME,
                    entity_b_value=owner,
                    relation="profile_of",
                    category=FactCategory.PROFILE,
                    raw_data={"repo": repo, "url": item.get("html_url"), "message": message},
                )
            else:
                yield Fact(
                    source_collector=self.name,
                    entity_a_type=ctx.entity_type,
                    entity_a_value=ctx.entity_value,
                    relation="found_on",
                    category=FactCategory.PROFILE,
                    raw_data={"repo": repo, "url": item.get("html_url"), "message": message},
                )


collector = GithubCommitsCollector()
```

Modify `backend/app/collectors/registry.py` — imports and `_NATIVE`:

```python
from . import crt_sh, dns_records, github_commits, github_user, http_fingerprint, whois

_NATIVE: list = [
    whois.collector,
    dns_records.collector,
    crt_sh.collector,
    http_fingerprint.collector,
    github_user.collector,
    github_commits.collector,
]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python -m pytest tests/test_collectors_github.py -v`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/collectors/ backend/tests/test_collectors_github.py
git commit -m "feat: github user and commit-search collectors"
```

---

### Task 11: Search snippets + phone prefix collectors

**Files:**
- Create: `backend/app/collectors/search_snippets.py`
- Create: `backend/app/collectors/phone_prefix.py`
- Modify: `backend/app/collectors/registry.py`
- Test: `backend/tests/test_collectors_misc.py`

**Interfaces:**
- Consumes: `CollectorContext`, `Fact`, `EntityType`, `FactCategory`.
- Produces:
  - `app.collectors.search_snippets.collector` — `name="search_snippets"`, inputs `[NAME, EMAIL, USERNAME]`. POSTs `https://html.duckduckgo.com/html/` with `data={"q": value}`; on non-200 yields nothing; regex-parses `result__a` links + titles and `result__snippet` texts, strips HTML tags, caps at `ctx.max_results`; yields `found_on` PROFILE facts with `raw_data` = `{"url", "title", "snippet"}`.
  - `app.collectors.phone_prefix.collector` — `name="phone_prefix"`, inputs `[PHONE]`. No network. Strips non-digits; matches longest country code first against `COUNTRY_CODES` (include at least: 1 US, 44 GB, 60 MY, 65 SG, 62 ID, 63 PH, 81 JP, 86 CN, 91 IN, 49 DE, 33 FR, 61 AU, 55 BR, 7 RU, 82 KR, 39 IT, 34 ES, 31 NL, 46 SE, 41 CH, 351 PT, 90 TR, 52 MX, 234 NG, 27 ZA, 61 AU); yields one `has_metadata` METADATA fact with `raw_data` = `{"country": name|None, "digits": digits, "length": len(digits)}`.
- Registry gains both.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_collectors_misc.py`:

```python
import httpx
import pytest
import respx

from app.collectors.base import CollectorContext, EntityType
from app.collectors.phone_prefix import collector as phone
from app.collectors.search_snippets import collector as search

DDG_HTML = """
<html><body>
<div class="result">
<a rel="nofollow" class="result__a" href="//example.com/page">Jane Doe Profile</a>
<a class="result__snippet" href="//example.com/page">Jane Doe lives in <b>KL</b>.</a>
</div>
</body></html>
"""


@pytest.mark.asyncio
async def test_search_snippets_parses_results():
    async with respx.mock:
        respx.post("https://html.duckduckgo.com/html/", data={"q": "Jane Doe"}).mock(
            return_value=httpx.Response(200, text=DDG_HTML)
        )
        async with httpx.AsyncClient() as client:
            ctx = CollectorContext(entity_type=EntityType.NAME, entity_value="Jane Doe",
                                   client=client, max_results=50, politeness_delay=0.0)
            facts = [f async for f in search.run(ctx)]
    assert len(facts) == 1
    f = facts[0]
    assert f.relation == "found_on"
    assert f.raw_data["url"] == "//example.com/page"
    assert f.raw_data["title"] == "Jane Doe Profile"
    assert "KL" in f.raw_data["snippet"]


@pytest.mark.asyncio
async def test_phone_prefix_maps_country():
    async with httpx.AsyncClient() as client:
        ctx = CollectorContext(entity_type=EntityType.PHONE, entity_value="+60 12-345 6789",
                               client=client, max_results=50, politeness_delay=0.0)
        facts = [f async for f in phone.run(ctx)]
    assert len(facts) == 1
    assert facts[0].raw_data["country"] == "MY"
    assert facts[0].raw_data["digits"] == "60123456789"


@pytest.mark.asyncio
async def test_phone_prefix_unknown_country():
    async with httpx.AsyncClient() as client:
        ctx = CollectorContext(entity_type=EntityType.PHONE, entity_value="+999123",
                               client=client, max_results=50, politeness_delay=0.0)
        facts = [f async for f in phone.run(ctx)]
    assert facts[0].raw_data["country"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python -m pytest tests/test_collectors_misc.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.collectors.search_snippets'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/app/collectors/search_snippets.py`:

```python
import re

from .base import Collector, CollectorContext, EntityType, Fact, FactCategory


class SearchSnippetsCollector:
    name = "search_snippets"
    input_types = [EntityType.NAME, EntityType.EMAIL, EntityType.USERNAME]
    produces = [FactCategory.PROFILE]
    requires_external = False

    async def run(self, ctx: CollectorContext):
        resp = await ctx.client.post(
            "https://html.duckduckgo.com/html/", data={"q": ctx.entity_value}
        )
        if resp.status_code != 200:
            return
        pattern = re.compile(
            r'result__a[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?result__snippet[^>]*>(.*?)</a>',
            re.S,
        )
        results = []
        for m in pattern.finditer(resp.text):
            title = re.sub(r"<[^>]+>", "", m.group(2)).strip()
            snippet = re.sub(r"<[^>]+>", "", m.group(3)).strip()[:200]
            results.append({"url": m.group(1), "title": title, "snippet": snippet})
        for r in results[: ctx.max_results]:
            yield Fact(
                source_collector=self.name,
                entity_a_type=ctx.entity_type,
                entity_a_value=ctx.entity_value,
                relation="found_on",
                category=FactCategory.PROFILE,
                raw_data=r,
            )


collector = SearchSnippetsCollector()
```

Create `backend/app/collectors/phone_prefix.py`:

```python
import re

from .base import Collector, CollectorContext, EntityType, Fact, FactCategory

COUNTRY_CODES = {
    "1": "US", "44": "GB", "60": "MY", "65": "SG", "62": "ID", "63": "PH",
    "81": "JP", "86": "CN", "91": "IN", "49": "DE", "33": "FR", "61": "AU",
    "55": "BR", "7": "RU", "82": "KR", "39": "IT", "34": "ES", "31": "NL",
    "46": "SE", "41": "CH", "351": "PT", "90": "TR", "52": "MX", "234": "NG",
    "27": "ZA",
}


class PhonePrefixCollector:
    name = "phone_prefix"
    input_types = [EntityType.PHONE]
    produces = [FactCategory.METADATA]
    requires_external = False

    async def run(self, ctx: CollectorContext):
        digits = re.sub(r"\D", "", ctx.entity_value)
        country = None
        for code in sorted(COUNTRY_CODES, key=len, reverse=True):
            if digits.startswith(code):
                country = COUNTRY_CODES[code]
                break
        yield Fact(
            source_collector=self.name,
            entity_a_type=ctx.entity_type,
            entity_a_value=ctx.entity_value,
            relation="has_metadata",
            category=FactCategory.METADATA,
            raw_data={"country": country, "digits": digits, "length": len(digits)},
        )


collector = PhonePrefixCollector()
```

Modify `backend/app/collectors/registry.py` — imports and `_NATIVE`:

```python
from . import (
    crt_sh, dns_records, github_commits, github_user, http_fingerprint,
    phone_prefix, search_snippets, whois,
)

_NATIVE: list = [
    whois.collector,
    dns_records.collector,
    crt_sh.collector,
    http_fingerprint.collector,
    github_user.collector,
    github_commits.collector,
    search_snippets.collector,
    phone_prefix.collector,
]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python -m pytest tests/test_collectors_misc.py -v`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/collectors/ backend/tests/test_collectors_misc.py
git commit -m "feat: search snippet and phone prefix collectors"
```

---

### Task 12: Frontend scaffold — Vite + React + state reducer

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.js`
- Create: `frontend/index.html`
- Create: `frontend/src/main.jsx`
- Create: `frontend/src/App.jsx`
- Create: `frontend/src/api.js`
- Create: `frontend/src/state.js`
- Create: `frontend/src/detect.js`
- Test: `frontend/src/state.test.js`
- Test: `frontend/src/detect.test.js`

**Interfaces:**
- Consumes: backend API at `/api`.
- Produces:
  - `frontend/src/api.js`: `listInvestigations()`, `createInvestigation(title, seeds)`, `getInvestigation(id)`, `getGraph(id)`, `getProfile(id, entityId)`, `getFact(id, factId)`, `startScan(id)`, `resumeScan(id)`, `streamEvents(id, onEvent, onDone)` (uses `fetch` + ReadableStream, parses `data: ` lines, calls `onEvent(event)`, resolves on `scan_done` or stream end).
  - `frontend/src/detect.js`: `detectType(input: string) -> "email" | "phone" | "ip" | "domain" | "username"` — email regex → email; `+?\d{7,15}` → phone; dotted quad → ip; dotted hostname → domain; else username.
  - `frontend/src/state.js`: `initialState()` → `{nodes: Map, edges: Map}`; `graphReducer(state, event)` — for `graph_delta` events, upserts nodes keyed `type:value` and edges keyed `collector|a|relation|b`; `mergeGraph(state, graph)` — merges `{nodes:[{data:{id,label,type}}], edges:[{data:{id,source,target,label}}]}` payloads from `getGraph`.
- App shell: title bar + investigation list + create form (textarea, seeds split by newline, auto-detected types) in `App.jsx`; `main.jsx` renders `<App/>`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/detect.test.js`:

```js
import { describe, it, expect } from "vitest";
import { detectType } from "./detect";

describe("detectType", () => {
  it("detects email", () => expect(detectType("Jane@Example.com")).toBe("email"));
  it("detects phone", () => expect(detectType("+60 12-345 6789")).toBe("phone"));
  it("detects ip", () => expect(detectType("93.184.216.34")).toBe("ip"));
  it("detects domain", () => expect(detectType("sub.example.com")).toBe("domain"));
  it("falls back to username", () => expect(detectType("jdoe_42")).toBe("username"));
});
```

Create `frontend/src/state.test.js`:

```js
import { describe, it, expect } from "vitest";
import { graphReducer, initialState, mergeGraph } from "./state";

const delta = {
  type: "graph_delta",
  fact: {
    source_collector: "whois",
    relation: "registered_by",
    entity_a: { type: "domain", value: "example.com" },
    entity_b: { type: "email", value: "admin@example.com" },
  },
};

describe("graphReducer", () => {
  it("adds nodes and edge from a graph_delta", () => {
    const state = graphReducer(initialState(), delta);
    expect(state.nodes.size).toBe(2);
    expect(state.edges.size).toBe(1);
    const edge = [...state.edges.values()][0];
    expect(edge.relation).toBe("registered_by");
  });

  it("dedupes identical deltas", () => {
    let state = initialState();
    state = graphReducer(state, delta);
    state = graphReducer(state, delta);
    expect(state.nodes.size).toBe(2);
    expect(state.edges.size).toBe(1);
  });

  it("ignores non-graph events", () => {
    const state = graphReducer(initialState(), { type: "job_status", job: {} });
    expect(state.nodes.size).toBe(0);
  });
});

describe("mergeGraph", () => {
  it("merges a fetched graph payload", () => {
    const payload = {
      nodes: [{ data: { id: "e1", label: "example.com", type: "domain" } }],
      edges: [{ data: { id: "f1", source: "e1", target: "e2", label: "registered_by" } }],
    };
    const state = mergeGraph(initialState(), payload);
    expect(state.nodes.size).toBe(1);
    expect(state.edges.size).toBe(1);
    expect(state.edges.get("f1").target).toBe("e2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm install && npm test`
Expected: FAIL — `npm test` errors because `src/detect.js` and `src/state.js` don't exist.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/package.json`:

```json
{
  "name": "osint-frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "lint": "vitest run"
  },
  "dependencies": {
    "cytoscape": "^3.30.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

Create `frontend/vite.config.js`:

```js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:8000" },
  },
  test: {
    environment: "jsdom",
  },
});
```

Create `frontend/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OSINT Framework</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

Create `frontend/src/main.jsx`:

```jsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")).render(<App />);
```

Create `frontend/src/detect.js`:

```js
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?\d{7,15}$/;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function detectType(input) {
  const v = input.trim();
  if (EMAIL_RE.test(v)) return "email";
  if (PHONE_RE.test(v)) return "phone";
  if (IP_RE.test(v)) return "ip";
  if (DOMAIN_RE.test(v)) return "domain";
  return "username";
}
```

Create `frontend/src/state.js`:

```js
export function initialState() {
  return { nodes: new Map(), edges: new Map() };
}

export function graphReducer(state, event) {
  if (event.type !== "graph_delta") return state;
  const nodes = new Map(state.nodes);
  const edges = new Map(state.edges);
  const f = event.fact;
  const aKey = `${f.entity_a.type}:${f.entity_a.value}`;
  if (!nodes.has(aKey)) nodes.set(aKey, { id: aKey, type: f.entity_a.type, value: f.entity_a.value });
  if (f.entity_b) {
    const bKey = `${f.entity_b.type}:${f.entity_b.value}`;
    if (!nodes.has(bKey)) nodes.set(bKey, { id: bKey, type: f.entity_b.type, value: f.entity_b.value });
    const edgeKey = `${f.source_collector}|${f.entity_a.value}|${f.relation}|${f.entity_b.value}`;
    if (!edges.has(edgeKey)) {
      edges.set(edgeKey, {
        id: edgeKey,
        source: aKey,
        target: bKey,
        relation: f.relation,
        factId: null,
      });
    }
  }
  return { nodes, edges };
}

export function mergeGraph(state, graph) {
  const nodes = new Map(state.nodes);
  const edges = new Map(state.edges);
  for (const n of graph.nodes || []) {
    nodes.set(n.data.id, { id: n.data.id, type: n.data.type, value: n.data.label });
  }
  for (const e of graph.edges || []) {
    edges.set(e.data.id, {
      id: e.data.id,
      source: e.data.source,
      target: e.data.target,
      relation: e.data.label,
      factId: e.data.fact_id ?? null,
    });
  }
  return { nodes, edges };
}
```

Create `frontend/src/api.js`:

```js
async function jsonFetch(path, options) {
  const resp = await fetch(path, options);
  if (!resp.ok) throw new Error(`${path} -> ${resp.status}`);
  return resp.json();
}

export const listInvestigations = () => jsonFetch("/api/investigations");
export const getInvestigation = (id) => jsonFetch(`/api/investigations/${id}`);
export const getGraph = (id) => jsonFetch(`/api/investigations/${id}/graph`);
export const getProfile = (id, entityId) => jsonFetch(`/api/investigations/${id}/entities/${entityId}`);
export const getFact = (id, factId) => jsonFetch(`/api/investigations/${id}/facts/${factId}`);
export const startScan = (id) => jsonFetch(`/api/investigations/${id}/scan`, { method: "POST" });
export const resumeScan = (id) => jsonFetch(`/api/investigations/${id}/resume`, { method: "POST" });

export function createInvestigation(title, seeds) {
  return jsonFetch("/api/investigations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, seeds }),
  });
}

export async function streamEvents(id, onEvent, onDone) {
  const resp = await fetch(`/api/investigations/${id}/stream`);
  if (!resp.ok || !resp.body) throw new Error("stream failed");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const event = JSON.parse(line.slice(6));
        onEvent(event);
        if (event.type === "scan_done") {
          reader.cancel();
          onDone?.(event);
          return;
        }
      }
    }
  }
  onDone?.();
}
```

Create `frontend/src/App.jsx`:

```jsx
import { useEffect, useState } from "react";
import { createInvestigation, listInvestigations } from "./api";
import { detectType } from "./detect";

export function App() {
  const [investigations, setInvestigations] = useState([]);
  const [title, setTitle] = useState("");
  const [seedsText, setSeedsText] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    listInvestigations().then(setInvestigations).catch((e) => setError(String(e)));
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    const seeds = seedsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((value) => ({ type: detectType(value), value }));
    if (!title.trim() || seeds.length === 0) return;
    try {
      const inv = await createInvestigation(title.trim(), seeds);
      setInvestigations((prev) => [inv, ...prev]);
      setTitle("");
      setSeedsText("");
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <h1>OSINT Framework</h1>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <form onSubmit={handleCreate}>
        <input
          placeholder="Investigation title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{ display: "block", marginBottom: 8, width: "100%" }}
        />
        <textarea
          placeholder={"One seed per line, e.g.\nadmin@example.com\njdoe\n+60 12-345 6789"}
          value={seedsText}
          onChange={(e) => setSeedsText(e.target.value)}
          rows={4}
          style={{ display: "block", marginBottom: 8, width: "100%" }}
        />
        <button type="submit">Start investigation</button>
      </form>
      <h2>Investigations</h2>
      <ul>
        {investigations.map((i) => (
          <li key={i.id}>
            {i.title} — {i.status}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 8 tests PASS (3 detect + 5 state).

- [ ] **Step 5: Commit**

```bash
git add frontend/
git commit -m "feat: frontend scaffold with graph state reducer and seed detection"
```

---

### Task 13: Graph view with Cytoscape

**Files:**
- Modify: `frontend/src/state.js` (add `pendingElements`)
- Modify: `frontend/src/state.test.js`
- Create: `frontend/src/GraphView.jsx`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Consumes: `state.js` (initialState, mergeGraph, pendingElements), `api.js` (getGraph, getFact).
- Produces:
  - `frontend/src/state.js` adds `pendingElements(state, existingIds: Set<string>) -> {nodes: [{data:{id,label,type}}], edges: [{data:{id,source,target,label}}]}` — returns only elements whose id is not in `existingIds`, nodes from `state.nodes`, edges from `state.edges`.
  - `frontend/src/GraphView.jsx` — default export `GraphView({ nodes, edges, onSelectEntity, onSelectEdge })`. Creates a Cytoscape instance once (ref); on each render, computes `pendingElements` against the instance's current element ids and adds them. Node color by type: email `#4f8ef7`, username `#f7a14f`, domain `#57c785`, phone `#c757c7`, name `#c7c757`, ip `#57c7c7`. Click handlers: node tap → `onSelectEntity(node.id())`; edge tap → `onSelectEdge(edge.data("factId"))`. Styles: nodes show label under colored circle, edges labeled with relation, `curve-style: bezier`.
  - `App.jsx` gains a detail view: when an investigation is clicked, `getGraph(id)` is fetched and merged via `mergeGraph`; `GraphView` is rendered; clicking a node sets `selected = {kind: "entity", id, entityId}`; clicking an edge sets `selected = {kind: "fact", id, factId}`. A side panel shows a placeholder with the selection (profile drawer and evidence panel arrive in Task 14).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/state.test.js`:

```js
import { graphReducer, initialState, mergeGraph, pendingElements } from "./state";

describe("pendingElements", () => {
  it("returns only new elements for cytoscape", () => {
    const payload = {
      nodes: [{ data: { id: "e1", label: "example.com", type: "domain" } }],
      edges: [{ data: { id: "f1", source: "e1", target: "e2", label: "registered_by" } }],
    };
    const state = mergeGraph(initialState(), payload);
    const fresh = pendingElements(state, new Set());
    expect(fresh.nodes.map((n) => n.data.id)).toEqual(["e1"]);
    expect(fresh.edges.map((e) => e.data.id)).toEqual(["f1"]);

    const again = pendingElements(state, new Set(["e1", "f1"]));
    expect(again.nodes).toEqual([]);
    expect(again.edges).toEqual([]);
  });

  it("works with reducer-produced deltas", () => {
    const state = graphReducer(initialState(), {
      type: "graph_delta",
      fact: {
        source_collector: "whois",
        relation: "registered_by",
        entity_a: { type: "domain", value: "example.com" },
        entity_b: { type: "email", value: "admin@example.com" },
      },
    });
    const fresh = pendingElements(state, new Set());
    expect(fresh.nodes.length).toBe(2);
    expect(fresh.edges.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `pendingElements is not a function`.

- [ ] **Step 3: Write minimal implementation**

Modify `frontend/src/state.js` — add `pendingElements` at the end:

```js
export function pendingElements(state, existingIds) {
  const nodes = [];
  const edges = [];
  for (const node of state.nodes.values()) {
    if (!existingIds.has(node.id)) {
      nodes.push({ data: { id: node.id, label: node.value, type: node.type } });
    }
  }
  for (const edge of state.edges.values()) {
    if (!existingIds.has(edge.id)) {
      edges.push({
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.relation,
          factId: edge.factId,
        },
      });
    }
  }
  return { nodes, edges };
}
```

Create `frontend/src/GraphView.jsx`:

```jsx
import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
import { pendingElements } from "./state";

const TYPE_COLORS = {
  email: "#4f8ef7",
  username: "#f7a14f",
  domain: "#57c785",
  phone: "#c757c7",
  name: "#c7c757",
  ip: "#57c7c7",
};

export function GraphView({ nodes, edges, onSelectEntity, onSelectEdge }) {
  const containerRef = useRef(null);
  const cyRef = useRef(null);
  const handlersRef = useRef({ onSelectEntity, onSelectEdge });
  handlersRef.current = { onSelectEntity, onSelectEdge };

  useEffect(() => {
    if (cyRef.current || !containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      style: [
        {
          selector: "node",
          style: {
            "background-color": (ele) => TYPE_COLORS[ele.data("type")] || "#999",
            label: "data(label)",
            width: 22,
            height: 22,
            "text-valign": "bottom",
            "text-margin-y": 4,
            "font-size": 11,
            color: "#333",
          },
        },
        {
          selector: "edge",
          style: {
            label: "data(label)",
            "curve-style": "bezier",
            "font-size": 10,
            color: "#666",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.7,
          },
        },
      ],
      layout: { name: "cose", animate: false },
    });
    cy.on("tap", "node", (evt) => {
      handlersRef.current.onSelectEntity(evt.target.id());
    });
    cy.on("tap", "edge", (evt) => {
      handlersRef.current.onSelectEdge(evt.target.data("factId"));
    });
    cyRef.current = cy;
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const existingIds = new Set(cy.elements().map((el) => el.id()));
    const { nodes: newNodes, edges: newEdges } = pendingElements({ nodes, edges }, existingIds);
    cy.add([...newNodes, ...newEdges]);
  }, [nodes, edges]);

  return <div ref={containerRef} style={{ width: "100%", height: 560 }} />;
}
```

Modify `frontend/src/App.jsx` — replace the whole file:

```jsx
import { useEffect, useState } from "react";
import { createInvestigation, getGraph, listInvestigations } from "./api";
import { detectType } from "./detect";
import { GraphView } from "./GraphView";
import { initialState, mergeGraph } from "./state";

export function App() {
  const [investigations, setInvestigations] = useState([]);
  const [title, setTitle] = useState("");
  const [seedsText, setSeedsText] = useState("");
  const [error, setError] = useState(null);
  const [current, setCurrent] = useState(null); // {id, title}
  const [graph, setGraph] = useState(initialState());
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    listInvestigations().then(setInvestigations).catch((e) => setError(String(e)));
  }, []);

  async function openInvestigation(id, title) {
    setCurrent({ id, title });
    setSelected(null);
    const g = await getGraph(id);
    setGraph(mergeGraph(initialState(), g));
  }

  async function handleCreate(e) {
    e.preventDefault();
    const seeds = seedsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((value) => ({ type: detectType(value), value }));
    if (!title.trim() || seeds.length === 0) return;
    try {
      const inv = await createInvestigation(title.trim(), seeds);
      setInvestigations((prev) => [inv, ...prev]);
      setTitle("");
      setSeedsText("");
    } catch (err) {
      setError(String(err));
    }
  }

  if (current) {
    return (
      <div style={{ fontFamily: "sans-serif", maxWidth: 1100, margin: "0 auto", padding: 16 }}>
        <button onClick={() => setCurrent(null)}>← Back</button>
        <h1>{current.title}</h1>
        <GraphView
          nodes={graph.nodes}
          edges={graph.edges}
          onSelectEntity={(nodeId) => {
            const node = graph.nodes.get(nodeId);
            setSelected({ kind: "entity", node });
          }}
          onSelectEdge={(factId) => setSelected({ kind: "fact", factId })}
        />
        <div>
          {selected?.kind === "entity" && (
            <p>
              <strong>{selected.node.value}</strong> ({selected.node.type}) — profile view coming
              in the next task.
            </p>
          )}
          {selected?.kind === "fact" && (
            <p>
              Edge evidence for fact #{selected.factId} — evidence panel coming in the next task.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <h1>OSINT Framework</h1>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <form onSubmit={handleCreate}>
        <input
          placeholder="Investigation title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{ display: "block", marginBottom: 8, width: "100%" }}
        />
        <textarea
          placeholder={"One seed per line, e.g.\nadmin@example.com\njdoe\n+60 12-345 6789"}
          value={seedsText}
          onChange={(e) => setSeedsText(e.target.value)}
          rows={4}
          style={{ display: "block", marginBottom: 8, width: "100%" }}
        />
        <button type="submit">Start investigation</button>
      </form>
      <h2>Investigations</h2>
      <ul>
        {investigations.map((i) => (
          <li key={i.id}>
            <a href="#" onClick={(e) => { e.preventDefault(); openInvestigation(i.id, i.title); }}>
              {i.title}
            </a>{" "}
            — {i.status}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 11 tests PASS (3 detect + 8 state).

- [ ] **Step 5: Manual smoke check + commit**

Run: `npm run dev` and open `http://localhost:5173`; start an investigation with a domain seed; confirm the graph renders nodes with colored circles and labeled edges.

```bash
git add frontend/src/
git commit -m "feat: cytoscape graph view with incremental element updates"
```

---

### Task 14: Profile drawer, evidence panel, scan panel, SSE wiring

**Files:**
- Create: `frontend/src/selectors.js`
- Create: `frontend/src/selectors.test.js`
- Create: `frontend/src/ProfileDrawer.jsx`
- Create: `frontend/src/EvidencePanel.jsx`
- Create: `frontend/src/ScanPanel.jsx`
- Create: `frontend/src/InvestigationView.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/api.js`
- Modify: `backend/app/api/entities.py`

**Interfaces:**
- Consumes: `api.js` (getProfile, getFact, streamEvents, resumeScan, startScan), `state.js` (graphReducer), `selectors.js`.
- Produces:
  - `frontend/src/selectors.js`:
    - `upsertJobs(jobs: Map, job: object) -> Map` — keyed by job.id, stores `{id, collector_name, status, result_count, error_message, entity}`.
    - `groupFacts(facts: list) -> {category: [fact]}` — preserves order, groups by `fact.category`.
    - `CATEGORY_ORDER = ["breach", "profile", "infra", "metadata"]` and `categoryLabel(cat)` (breach → Breaches, profile → Profiles, infra → Infrastructure, metadata → Metadata).
    - `entityLookupParams(nodeId: string) -> {pathId: number, value: string | null}` — `e12` (fetched-graph id) → `{pathId: 12, value: null}`; `domain:example.com` (SSE delta key) → `{pathId: 0, value: "domain:example.com"}`; anything else → `{pathId: 0, value: nodeId}`.
  - `frontend/src/ProfileDrawer.jsx` — props `{investigationId, nodeId, onClose}`; resolves `entityLookupParams(nodeId)` and fetches `getProfile(id, pathId, value)`; renders entity value + type header and facts grouped by category via `groupFacts` + `CATEGORY_ORDER`; each fact row shows `relation` (badge), `source_collector`, `confidence`, `last_seen`, and a `<details>` block with the raw JSON.
  - `frontend/src/EvidencePanel.jsx` — props `{investigationId, factId, onClose}`; fetches `getFact`; renders relation, source, category, timestamps, and `<pre>` raw JSON.
  - `frontend/src/ScanPanel.jsx` — props `{jobs: Map, onResume}`; renders a chip per job: `collector_name` + status; color by status (running amber, done green, failed red, skipped gray, partial orange); failed/skipped jobs show `error_message` in a tooltip title; resume button calls `onResume`.
  - `frontend/src/InvestigationView.jsx` — props `{investigationId, title, onBack}`; loads `getInvestigation` (seeds + jobs) and `getGraph`; owns `graph` state (via `graphReducer` for SSE deltas); connects `streamEvents(id, onEvent)` — `job_status` → `upsertJobs`, `graph_delta` → `graphReducer`, `scan_done` → refresh jobs from `getInvestigation`; renders `GraphView`, `ScanPanel`, and the selected entity's `ProfileDrawer` / edge `EvidencePanel`; resume button calls `resumeScan` then reconnects the stream.
  - `frontend/src/api.js`: `getProfile(id, pathId, value)` — `pathId` in the URL path, `?value=` query when `value` is non-null.
  - `backend/app/api/entities.py`: profile endpoint gains `value: str | None = None` query param; when `entity_id` resolves to nothing, looks up `Entity` by `type:value` from the `value` param.
  - `App.jsx` routes to `InvestigationView` instead of inline detail logic.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/selectors.test.js`:

```js
import { describe, it, expect } from "vitest";
import { categoryLabel, CATEGORY_ORDER, entityLookupParams, groupFacts, upsertJobs } from "./selectors";

const job = {
  id: 3,
  collector_name: "whois",
  status: "running",
  result_count: 0,
  error_message: null,
  entity: { type: "domain", value: "example.com" },
};

describe("upsertJobs", () => {
  it("adds and updates jobs by id", () => {
    let jobs = new Map();
    jobs = upsertJobs(jobs, job);
    expect(jobs.size).toBe(1);
    jobs = upsertJobs(jobs, { ...job, status: "done", result_count: 4 });
    expect(jobs.get(3).status).toBe("done");
    expect(jobs.get(3).result_count).toBe(4);
  });
});

describe("groupFacts", () => {
  it("groups facts by category", () => {
    const facts = [
      { id: 1, category: "profile", relation: "found_on" },
      { id: 2, category: "infra", relation: "resolves_to" },
      { id: 3, category: "profile", relation: "profile_of" },
    ];
    const grouped = groupFacts(facts);
    expect(grouped.profile.length).toBe(2);
    expect(grouped.infra.length).toBe(1);
  });
});

describe("categories", () => {
  it("orders and labels categories", () => {
    expect(CATEGORY_ORDER).toEqual(["breach", "profile", "infra", "metadata"]);
    expect(categoryLabel("infra")).toBe("Infrastructure");
  });
});

describe("entityLookupParams", () => {
  it("extracts numeric id from fetched-graph node ids", () => {
    expect(entityLookupParams("e12")).toEqual({ pathId: 12, value: null });
  });

  it("passes sse delta keys through as value lookup", () => {
    expect(entityLookupParams("domain:example.com")).toEqual({
      pathId: 0,
      value: "domain:example.com",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module './selectors'`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/selectors.js`:

```js
export function upsertJobs(jobs, job) {
  const next = new Map(jobs);
  next.set(job.id, job);
  return next;
}

export function groupFacts(facts) {
  const grouped = {};
  for (const f of facts) {
    (grouped[f.category] ||= []).push(f);
  }
  return grouped;
}

export const CATEGORY_ORDER = ["breach", "profile", "infra", "metadata"];

export function categoryLabel(cat) {
  return {
    breach: "Breaches",
    profile: "Profiles",
    infra: "Infrastructure",
    metadata: "Metadata",
  }[cat] || cat;
}

export function entityLookupParams(nodeId) {
  const m = /^e(\d+)$/.exec(nodeId);
  if (m) return { pathId: Number(m[1]), value: null };
  return { pathId: 0, value: nodeId };
}
```

Create `frontend/src/ProfileDrawer.jsx`:

```jsx
import { useEffect, useState } from "react";
import { getProfile } from "./api";
import { CATEGORY_ORDER, categoryLabel, entityLookupParams, groupFacts } from "./selectors";

export function ProfileDrawer({ investigationId, nodeId, onClose }) {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const { pathId, value } = entityLookupParams(nodeId);
    getProfile(investigationId, pathId, value)
      .then(setProfile)
      .catch((e) => setError(String(e)));
  }, [investigationId, nodeId]);

  return (
    <div style={{ border: "1px solid #ccc", padding: 12, marginTop: 12 }}>
      <button onClick={onClose}>Close</button>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {profile && (
        <>
          <h3>
            {profile.entity.value} <small>({profile.entity.type})</small>
          </h3>
          {CATEGORY_ORDER.map((cat) => {
            const facts = profile.facts[cat];
            if (!facts || facts.length === 0) return null;
            return (
              <section key={cat}>
                <h4>{categoryLabel(cat)}</h4>
                <ul>
                  {facts.map((f) => (
                    <li key={f.id} style={{ marginBottom: 6 }}>
                      <strong>{f.relation}</strong> via {f.source_collector} · confidence {f.confidence} · {f.last_seen}
                      <details>
                        <summary>raw data</summary>
                        <pre style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
                          {JSON.stringify(f.raw_data, null, 2)}
                        </pre>
                      </details>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
```

Create `frontend/src/EvidencePanel.jsx`:

```jsx
import { useEffect, useState } from "react";
import { getFact } from "./api";

export function EvidencePanel({ investigationId, factId, onClose }) {
  const [fact, setFact] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getFact(investigationId, factId)
      .then(setFact)
      .catch((e) => setError(String(e)));
  }, [investigationId, factId]);

  return (
    <div style={{ border: "1px solid #ccc", padding: 12, marginTop: 12 }}>
      <button onClick={onClose}>Close</button>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {fact && (
        <>
          <h3>
            {fact.entity_a.value} —{fact.relation}→ {fact.entity_b ? fact.entity_b.value : "(self)"}
          </h3>
          <p>
            Source: {fact.source_collector} · Category: {fact.category} · Confidence: {fact.confidence}
          </p>
          <p>
            First seen: {fact.first_seen} · Last seen: {fact.last_seen}
          </p>
          <pre style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>{JSON.stringify(fact.raw_data, null, 2)}</pre>
        </>
      )}
    </div>
  );
}
```

Create `frontend/src/ScanPanel.jsx`:

```jsx
const STATUS_COLORS = {
  queued: "#999",
  running: "#d9a800",
  done: "#2f9e44",
  partial: "#e8590c",
  failed: "#c92a2a",
  skipped: "#868e96",
};

export function ScanPanel({ jobs, onResume }) {
  const list = [...jobs.values()];
  if (list.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <h4>Scan jobs</h4>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {list.map((j) => (
          <span
            key={j.id}
            title={j.error_message || `${j.result_count} results`}
            style={{
              border: "1px solid #ccc",
              borderRadius: 12,
              padding: "2px 10px",
              fontSize: 12,
              background: STATUS_COLORS[j.status] || "#eee",
              color: "#fff",
            }}
          >
            {j.collector_name} · {j.status}
            {j.status === "done" ? ` (${j.result_count})` : ""}
          </span>
        ))}
      </div>
      <button onClick={onResume} style={{ marginTop: 8 }}>
        Resume failed jobs
      </button>
    </div>
  );
}
```

Create `frontend/src/InvestigationView.jsx`:

```jsx
import { useEffect, useState } from "react";
import { getGraph, getInvestigation, resumeScan, streamEvents } from "./api";
import { EvidencePanel } from "./EvidencePanel";
import { GraphView } from "./GraphView";
import { ProfileDrawer } from "./ProfileDrawer";
import { ScanPanel } from "./ScanPanel";
import { graphReducer, initialState, mergeGraph } from "./state";
import { upsertJobs } from "./selectors";

export function InvestigationView({ investigationId, title, onBack }) {
  const [graph, setGraph] = useState(initialState());
  const [jobs, setJobs] = useState(new Map());
  const [selected, setSelected] = useState(null); // {kind: "entity", node} | {kind: "fact", factId}
  const [streamVersion, setStreamVersion] = useState(0);

  useEffect(() => {
    getInvestigation(investigationId).then((data) => {
      setJobs(new Map(data.jobs.map((j) => [j.id, j])));
    });
    getGraph(investigationId).then((g) => setGraph(mergeGraph(initialState(), g)));
  }, [investigationId]);

  useEffect(() => {
    let cancelled = false;
    streamEvents(investigationId, (event) => {
      if (cancelled) return;
      if (event.type === "job_status") {
        setJobs((prev) => upsertJobs(prev, event.job));
      } else if (event.type === "graph_delta") {
        setGraph((prev) => graphReducer(prev, event));
      } else if (event.type === "scan_done") {
        getInvestigation(investigationId).then((data) => {
          setJobs(new Map(data.jobs.map((j) => [j.id, j])));
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [investigationId, streamVersion]);

  async function handleResume() {
    await resumeScan(investigationId);
    setStreamVersion((v) => v + 1);
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 1100, margin: "0 auto", padding: 16 }}>
      <button onClick={onBack}>← Back</button>
      <h1>{title}</h1>
      <GraphView
        nodes={graph.nodes}
        edges={graph.edges}
        onSelectEntity={(nodeId) => {
          const node = graph.nodes.get(nodeId);
          if (node) setSelected({ kind: "entity", node });
        }}
        onSelectEdge={(factId) => setSelected({ kind: "fact", factId })}
      />
      <ScanPanel jobs={jobs} onResume={handleResume} />
      {selected?.kind === "entity" && (
        <ProfileDrawer
          investigationId={investigationId}
          nodeId={selected.node.id}
          onClose={() => setSelected(null)}
        />
      )}
      {selected?.kind === "fact" && (
        <EvidencePanel
          investigationId={investigationId}
          factId={selected.factId}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
```

Note: node ids from SSE deltas are `type:value` keys while fetched graph node ids are `e{id}`. The profile drawer needs the backend entity id. Handle this by resolving the entity id when the node came from a fetched graph: for SSE-added nodes, pass the node key to a profile lookup that the backend accepts by value. To keep v1 simple, modify `backend/app/api/entities.py` — the profile endpoint accepts an optional `?value=` fallback. Add to `get_profile` signature `value: str | None = None` and resolve: if `entity_id` is 0 or missing, look up `Entity(type, value)` by splitting the SSE key on the first `:`. Update `entities.py`:

```python
@router.get("/investigations/{inv_id}/entities/{entity_id}")
def profile(inv_id: int, entity_id: int, value: str | None = None, db: Session = Depends(get_db)):
    entity = db.get(Entity, entity_id)
    if entity is None and value:
        parts = value.split(":", 1)
        if len(parts) == 2:
            entity = db.query(Entity).filter_by(type=parts[0], value=parts[1]).first()
    if entity is None:
        raise HTTPException(404, "entity not found")
    ...
```

Modify `frontend/src/api.js` — replace `getProfile` with the three-argument version:

```js
export const getProfile = (id, pathId, value) =>
  jsonFetch(
    `/api/investigations/${id}/entities/${pathId}${value ? `?value=${encodeURIComponent(value)}` : ""}`
  );
```

Node id resolution: fetched-graph node ids are `e{id}` (numeric path id, no query); SSE delta node keys are `type:value` (path id `0` + `?value=` fallback). `entityLookupParams` in `selectors.js` produces the right arguments for both.

Replace `frontend/src/App.jsx` — the `current` branch now renders `InvestigationView`:

```jsx
import { useEffect, useState } from "react";
import { createInvestigation, listInvestigations } from "./api";
import { detectType } from "./detect";
import { InvestigationView } from "./InvestigationView";

export function App() {
  const [investigations, setInvestigations] = useState([]);
  const [title, setTitle] = useState("");
  const [seedsText, setSeedsText] = useState("");
  const [error, setError] = useState(null);
  const [current, setCurrent] = useState(null);

  useEffect(() => {
    listInvestigations().then(setInvestigations).catch((e) => setError(String(e)));
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    const seeds = seedsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((value) => ({ type: detectType(value), value }));
    if (!title.trim() || seeds.length === 0) return;
    try {
      const inv = await createInvestigation(title.trim(), seeds);
      setInvestigations((prev) => [inv, ...prev]);
      setTitle("");
      setSeedsText("");
    } catch (err) {
      setError(String(err));
    }
  }

  if (current) {
    return (
      <InvestigationView
        investigationId={current.id}
        title={current.title}
        onBack={() => setCurrent(null)}
      />
    );
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <h1>OSINT Framework</h1>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <form onSubmit={handleCreate}>
        <input
          placeholder="Investigation title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{ display: "block", marginBottom: 8, width: "100%" }}
        />
        <textarea
          placeholder={"One seed per line, e.g.\nadmin@example.com\njdoe\n+60 12-345 6789"}
          value={seedsText}
          onChange={(e) => setSeedsText(e.target.value)}
          rows={4}
          style={{ display: "block", marginBottom: 8, width: "100%" }}
        />
        <button type="submit">Start investigation</button>
      </form>
      <h2>Investigations</h2>
      <ul>
        {investigations.map((i) => (
          <li key={i.id}>
            <a href="#" onClick={(e) => { e.preventDefault(); setCurrent({ id: i.id, title: i.title }); }}>
              {i.title}
            </a>{" "}
            — {i.status}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 16 tests PASS (3 detect + 8 state + 5 selectors).

- [ ] **Step 5: Verify backend change + commit**

Run backend API tests to confirm the `?value=` fallback works:
`.venv\Scripts\python -m pytest tests/test_api.py -v`
Expected: 6 tests PASS.

```bash
git add frontend/src/ backend/app/api/entities.py
git commit -m "feat: profile drawer, evidence panel, scan panel, sse-driven investigation view"
```

---

### Task 15: Static serving, README, full verification

**Files:**
- Modify: `backend/app/main.py`
- Create: `README.md`
- Modify: `backend/.gitignore` (new)

**Interfaces:**
- Consumes: everything built so far.
- Produces:
  - `backend/app/main.py` mounts `frontend/dist` at `/` (html=True) when the directory exists, after the API routers.
  - `README.md` at repo root: project intro, architecture summary, setup steps (backend venv + `pip install -r requirements.txt`, frontend `npm install`), run instructions (`uvicorn app.main:app` from `backend/` + `npm run dev` for development, or `npm run build` for single-process), external tool install guide (`pipx install sherlock-project`, `pipx install holehe`, `go install ... subfinder`), and the test commands (`pytest`, `npm test`).
  - `backend/.gitignore` ignores `.venv/`, `__pycache__/`, `*.db`, `*.db-wal`, `*.db-shm`, `tests/test.db`.

- [ ] **Step 1: Write the failing test (static mount)**

Add to `backend/tests/test_api.py`:

```python
def test_static_index_served_when_built():
    from pathlib import Path
    import shutil

    dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if not dist.exists():
        dist.mkdir(parents=True)
        (dist / "index.html").write_text("<html>built</html>")
        try:
            resp = client.get("/")
            assert resp.status_code == 200
            assert "<html>built</html>" in resp.text
        finally:
            shutil.rmtree(dist)
    else:
        resp = client.get("/")
        assert resp.status_code == 200
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv\Scripts\python -m pytest tests/test_api.py::test_static_index_served_when_built -v`
Expected: FAIL with a 404 (no static mount yet).

- [ ] **Step 3: Write minimal implementation**

Modify `backend/app/main.py` — replace the whole file:

```python
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .api import entities, investigations, jobs
from .core.db import init_db


def create_app() -> FastAPI:
    init_db()
    app = FastAPI(title="OSINT Framework")
    app.include_router(investigations.router, prefix="/api")
    app.include_router(entities.router, prefix="/api")
    app.include_router(jobs.router, prefix="/api")
    static_dir = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if static_dir.exists():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
    return app


app = create_app()
```

Create `backend/.gitignore`:

```
.venv/
__pycache__/
*.db
*.db-wal
*.db-shm
tests/test.db
```

Create `README.md` at repo root:

```markdown
# OSINT Framework

Single-user local OSINT investigation tool: feed it emails, usernames, domains, or phones; it collects public-source facts via pluggable collectors, correlates them into an evidence-backed entity graph, and shows the graph in a browser.

## Architecture

- `backend/` — FastAPI + SQLite (WAL). Async scan pipeline runs collectors in a background thread; per-collector jobs are tracked in the DB; progress streams to the UI over SSE.
- `frontend/` — React + Vite + Cytoscape.js. Graph-first UI with per-entity profile drawers and edge evidence panels.
- Collectors: native (RDAP whois, DNS, crt.sh, HTTP fingerprint, GitHub, DuckDuckGo snippets, phone prefix) + external tool wrappers (Sherlock, Subfinder, Holehe) that are detected at runtime and skipped gracefully if not installed.

## Setup

Backend:

```
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
```

Frontend:

```
cd frontend
npm install
```

## Run (development)

Terminal 1 — backend:

```
cd backend
.venv\Scripts\uvicorn app.main:app --reload     # macOS/Linux: .venv/bin/uvicorn
```

Terminal 2 — frontend (proxies /api to :8000):

```
cd frontend
npm run dev
```

Open http://localhost:5173.

## Run (single process)

```
cd frontend && npm run build
cd ../backend && .venv\Scripts\uvicorn app.main:app
```

Open http://localhost:8000 — FastAPI serves the built SPA.

## External tools (optional)

The tool wrappers are skipped with an install hint when the binary is missing. Install for full coverage:

- Sherlock (username profiles): `pipx install sherlock-project`
- Holehe (email account existence): `pipx install holehe`
- Subfinder (subdomain enumeration): `go install -v github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest`

## Tests

```
cd backend && .venv\Scripts\python -m pytest tests/ -v
cd frontend && npm test
```
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `.venv\Scripts\python -m pytest tests/ -v`
Expected: all backend tests PASS (2 models + 2 whois + 2 dns + 2 crt + 2 fingerprint + 4 correlation + 2 pipeline + 6 api + 4 tools + 2 github + 3 misc + 1 static = 32).

Run (from `frontend/`): `npm test`
Expected: 16 tests PASS.

Run (from `frontend/`): `npm run build`
Expected: build completes, `frontend/dist/` created.

- [ ] **Step 5: Commit**

```bash
git add backend/app/main.py backend/.gitignore README.md
git commit -m "docs: add readme with setup and external tool guide; serve built spa"
```

---

## Self-Review Notes (verified against the spec)

- Spec §11 retry-once-with-backoff: implemented in the runner (Task 7) — a failed collector run retries once after 1s, then the job is marked `failed` with the exception (incl. HTTP status) recorded in `error_message`.
- Spec §11 robots.txt for scrapers: the only scraper (DuckDuckGo HTML endpoint) is a search service, not a site scrape; the politeness delay + max-results cap serve the same purpose (Task 11).
- Spec §5 Job model gained `entity_id` (spec's §4 fan-out is per seed entity × collector) — deliberate, documented in Task 1.
- Spec §9 `POST /api/investigations/{id}/resume` and `/scan` share one code path; the runner's skip logic makes re-runs safe and idempotent (Task 8).
- Spec §8 "partial" status implemented as `done`/`partial` by result count (Task 7).
- Spec §12 testing: every collector has unit tests with mocked HTTP (respx) or fake binaries; correlation rules tested incl. no-speculative-edges; API integration tests against temp SQLite; Vitest covers reducer/merge/pending-elements/selectors/detect; graph rendering is a manual smoke check (Task 13 step 5).
- Spec §10 SSE-driven incremental graph updates: `graph_delta` events every 5 facts + full `getGraph` merge on load (Tasks 7, 14).
- Spec §11 crash recovery: job state persisted; resume re-runs failed/skipped jobs via the runner (Tasks 7, 8).
- Deferred from spec §14: paid providers, multi-user, report export — nothing built for them.