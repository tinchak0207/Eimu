"""Local, bounded, metadata-only activity shared by the CLI and desktop clients."""
from __future__ import annotations
from .i18n import source_message

from contextlib import contextmanager
from contextvars import ContextVar
import os
from pathlib import Path
import sqlite3
import sys
import threading
import time
import uuid

from .config import config

SCHEMA_VERSION = 2
MAX_COMPLETED_RUNS = 1000
RETENTION_SECONDS = 7 * 86400
_current: ContextVar[Invocation | None] = ContextVar("smart_search_activity", default=None)
_SAFE_ERROR_TYPES = {"", "parameter_error", "config_error", "auth_error", "timeout", "rate_limited",
                     "network_error", "parse_error", "provider_error", "runtime_error", "cancelled",
                     "evidence_error", "interrupted"}


class ActivityStore:
    def __init__(self, directory: str | Path | None = None):
        self.directory = Path(directory) if directory is not None else config.config_file.parent
        self.path = self.directory / "activity.sqlite3"

    @contextmanager
    def connection(self, timeout: float = 0.2):
        self.directory.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=timeout)
        try:
            if os.name != "nt":
                self.path.chmod(0o600)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise ValueError(source_message('Activity database was created by a newer version.'))
            if not version:
                db.executescript("""
                    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS runs (
                        run_id TEXT PRIMARY KEY, command TEXT NOT NULL, origin TEXT NOT NULL,
                        config_dir TEXT NOT NULL, version TEXT NOT NULL, pid INTEGER NOT NULL,
                        status TEXT NOT NULL DEFAULT 'running', phase TEXT NOT NULL DEFAULT 'starting',
                        provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
                        started_at REAL NOT NULL, updated_at REAL NOT NULL, finished_at REAL,
                        elapsed_ms REAL NOT NULL DEFAULT 0, error_type TEXT NOT NULL DEFAULT '',
                        exit_code INTEGER, sources_count INTEGER NOT NULL DEFAULT 0,
                        sequence INTEGER NOT NULL DEFAULT 0, config_revision TEXT NOT NULL DEFAULT '');
                    CREATE TABLE IF NOT EXISTS events (
                        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
                        sequence INTEGER NOT NULL, timestamp REAL NOT NULL, phase TEXT NOT NULL,
                        provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
                        status TEXT NOT NULL, error_type TEXT NOT NULL DEFAULT '',
                        UNIQUE(run_id, sequence));
                    CREATE INDEX IF NOT EXISTS events_run ON events(run_id, sequence);
                    PRAGMA user_version=2;
                """)
            elif version == 1:
                db.execute("BEGIN IMMEDIATE")
                if db.execute("PRAGMA user_version").fetchone()[0] == 1:
                    db.execute("ALTER TABLE runs ADD COLUMN config_revision TEXT NOT NULL DEFAULT ''")
                    db.execute("PRAGMA user_version=2")
            with db:
                yield db
        finally:
            db.close()

    def enabled(self) -> bool:
        if os.getenv("SMART_SEARCH_ACTIVITY_ENABLED", "true").lower() in {"false", "0", "no"}:
            return False
        with self.connection() as db:
            row = db.execute("SELECT value FROM settings WHERE key='enabled'").fetchone()
            return row is None or row[0] == "true"

    def set_enabled(self, enabled: bool):
        with self.connection() as db:
            db.execute("INSERT OR REPLACE INTO settings VALUES ('enabled', ?)", ("true" if enabled else "false",))

    def start(self, run_id: str, command: str, origin: str, version: str, config_revision: str = ""):
        now = time.time()
        with self.connection() as db:
            db.execute("""INSERT INTO runs(run_id,command,origin,config_dir,version,pid,started_at,updated_at,config_revision)
                          VALUES (?,?,?,?,?,?,?,?,?)""",
                       (run_id, command, origin, str(self.directory), version, os.getpid(), now, now, config_revision))
            db.execute("INSERT INTO events(run_id,sequence,timestamp,phase,status) VALUES (?,0,?,'starting','running')",
                       (run_id, now))
            self._prune(db, now)

    @staticmethod
    def _prune(db, now):
        db.execute("""DELETE FROM runs WHERE finished_at IS NOT NULL AND
            (finished_at < ? OR run_id NOT IN (SELECT run_id FROM runs WHERE finished_at IS NOT NULL
            ORDER BY finished_at DESC LIMIT ?))""", (now - RETENTION_SECONDS, MAX_COMPLETED_RUNS))

    def heartbeat(self, run_id: str):
        with self.connection() as db:
            db.execute("UPDATE runs SET updated_at=? WHERE run_id=? AND finished_at IS NULL", (time.time(), run_id))

    def progress(self, run_id: str, *, phase: str, provider: str = "", model: str = "", error_type: str = ""):
        now = time.time()
        with self.connection() as db:
            changed = db.execute("""UPDATE runs SET phase=?,provider=COALESCE(NULLIF(?,''),provider),
                model=CASE WHEN ?='' AND (?='' OR ?=provider COLLATE NOCASE) THEN model ELSE ? END,
                error_type=?,updated_at=?,
                sequence=sequence+1 WHERE run_id=? AND finished_at IS NULL""",
                (phase, provider, model, provider, provider, model, error_type, now, run_id)).rowcount
            if changed:
                db.execute("""INSERT INTO events(run_id,sequence,timestamp,phase,provider,model,status,error_type)
                    SELECT run_id,sequence,?,phase,provider,model,'running',error_type FROM runs WHERE run_id=?""", (now, run_id))
                # ponytail: retain 500 phase events per run; paginate a larger journal if a real workflow needs more.
                db.execute("DELETE FROM events WHERE run_id=? AND id NOT IN (SELECT id FROM events WHERE run_id=? ORDER BY id DESC LIMIT 500)",
                           (run_id, run_id))

    def finish(self, run_id: str, exit_code: int, status: str, *, error_type: str = "", sources_count: int = 0):
        now = time.time()
        # SQLite's busy timeout retries the final write, still bounded to one second.
        with self.connection(timeout=1.0) as db:
            changed = db.execute("""UPDATE runs SET status=?,finished_at=?,updated_at=?,exit_code=?,error_type=?,
                sources_count=?,elapsed_ms=(?-started_at)*1000,sequence=sequence+1
                WHERE run_id=? AND finished_at IS NULL""",
                (status, now, now, exit_code, error_type, sources_count, now, run_id)).rowcount
            if changed:
                db.execute("""INSERT INTO events(run_id,sequence,timestamp,phase,provider,model,status,error_type)
                    SELECT run_id,sequence,?,phase,provider,model,status,error_type FROM runs WHERE run_id=?""", (now, run_id))
                self._prune(db, now)

    @staticmethod
    def _public_run(row):
        value = dict(row)
        if value["finished_at"] is None:
            value["elapsed_ms"] = round((time.time() - value["started_at"]) * 1000, 1)
            if time.time() - value["updated_at"] > 10:
                value["status"] = "stale"
        return value

    def list_runs(self, limit: int = 100) -> list[dict]:
        with self.connection() as db:
            self._prune(db, time.time())
            return [self._public_run(row) for row in db.execute("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?",
                                                              (max(1, min(limit, 1000)),))]

    def details(self, run_id: str) -> dict:
        with self.connection() as db:
            row = db.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
            if row is None:
                return {"ok": False, "error": source_message('活动记录不存在。')}
            events = [dict(item) for item in db.execute("SELECT sequence,timestamp,phase,provider,model,status,error_type FROM events WHERE run_id=? ORDER BY sequence", (run_id,))]
            return {"ok": True, "run": self._public_run(row), "events": events,
                    "events_truncated": bool(events and events[0]["sequence"] > 0)}

    def clear(self):
        with self.connection() as db:
            db.execute("DELETE FROM runs WHERE finished_at IS NOT NULL")


class Invocation:
    def __init__(self, command: str, *, origin: str = "cli", version: str = "", run_id: str = ""):
        self.run_id = uuid.UUID(run_id).hex if run_id else uuid.uuid4().hex
        self.command, self.origin, self.version = command[:100], origin, version
        self._stop = threading.Event()
        self._warned = False
        self._enabled = False
        self._finished = False
        self._error_type = ""
        self._sources_count = 0
        self._heartbeat = None
        self.store = self._try(ActivityStore)
        self._secrets = self._try(config.secret_values) or ()
        # An opaque snapshot handle identifies this invocation without retaining a
        # credential-derived hash that could be used as an offline guessing oracle.
        self._revision = uuid.uuid4().hex

    def _try(self, fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except (OSError, sqlite3.Error, ValueError):
            if not self._warned:
                self._warned = True
                try:
                    print("smart-search: activity recording unavailable; the command will continue.", file=sys.stderr)
                except OSError:
                    pass
            return None

    def start(self):
        if self.store is None:
            return
        self._enabled = bool(self._try(self.store.enabled))
        if not self._enabled:
            return
        self._try(self.store.start, self.run_id, self.command, self.origin, self.version, self._revision)
        self._heartbeat = threading.Thread(target=self._keep_alive, daemon=True)
        self._heartbeat.start()

    def _keep_alive(self):
        while not self._stop.wait(2):
            self._try(self.store.heartbeat, self.run_id)

    def _label(self, value: object) -> str:
        text = str(value or "")
        for secret in self._secrets:
            if secret:
                text = text.replace(secret, "[REDACTED]")
        return text[:100]

    def progress(self, phase: str, provider: str = "", model: str = "", error_type: str = ""):
        if self._enabled and not self._finished:
            self._try(self.store.progress, self.run_id, phase=self._label(phase), provider=self._label(provider),
                      model=self._label(model), error_type=error_type if error_type in _SAFE_ERROR_TYPES else "runtime_error")

    def result(self, data: dict):
        if data.get("provider"):
            # The final result names the primary provider; keep supplemental
            # providers in phase events without attaching its model to them.
            self.progress(self.command, str(data["provider"]), str(data.get("model") or ""))
        self._error_type = str(data.get("error_type") or "")
        if self._error_type not in _SAFE_ERROR_TYPES:
            self._error_type = "runtime_error"
        sources = data.get("sources")
        self._sources_count = len(sources) if isinstance(sources, list) else 0

    def finish(self, exit_code: int = 0, status: str = ""):
        if self._finished:
            return
        self._finished = True
        self._stop.set()
        status = status or ("finished" if exit_code == 0 else "failed")
        if self._enabled:
            self._try(self.store.finish, self.run_id, exit_code, status, error_type=self._error_type,
                      sources_count=self._sources_count)


@contextmanager
def observe(command: str, *, origin: str = "cli", version: str = "", run_id: str = ""):
    previous = _current.get()
    if previous is not None:
        yield previous
        return
    run = Invocation(command, origin=origin, version=version, run_id=run_id)
    token = _current.set(run)
    run.start()
    try:
        yield run
    except KeyboardInterrupt:
        run.finish(5, "cancelled")
        raise
    except SystemExit as error:
        run.finish(error.code if isinstance(error.code, int) else 5)
        raise
    except BaseException:
        run.finish(5)
        raise
    finally:
        run.finish()
        _current.reset(token)


def progress(phase: str, provider: str = "", model: str = "", error_type: str = ""):
    run = _current.get()
    if run is not None:
        run.progress(phase, provider, model, error_type)


def result(data: dict):
    run = _current.get()
    if run is not None:
        run.result(data)


def cancelled():
    run = _current.get()
    if run is not None:
        run.finish(5, "cancelled")
