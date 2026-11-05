"""SQLite storage for projects, sessions, and message history."""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    title TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    context_start INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    worktree TEXT,  -- JSON: the git worktree of the session (worktrees.py). NULL: the session works in cwd.
    routine_id TEXT  -- The routine that started the session (routines.py). NULL: the user started it.
);
CREATE TABLE IF NOT EXISTS messages (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
);
-- The content of a file before the agent changed it in the turn of a user message. Rewind uses it.
-- content is NULL if the file did not exist. The rowid gives the order.
CREATE TABLE IF NOT EXISTS checkpoints (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content BLOB,
    UNIQUE (session_id, message_id, path)
);
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    path_key TEXT NOT NULL UNIQUE,  -- The path for comparison: case-insensitive on Windows.
    created_at REAL NOT NULL,
    last_used REAL NOT NULL
);
-- A prompt that the daemon runs in a new session at the times of a cron schedule (routines.py).
CREATE TABLE IF NOT EXISTS routines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cwd TEXT NOT NULL,
    provider TEXT,  -- NULL: the default provider and model.
    model TEXT,
    permission_mode TEXT NOT NULL DEFAULT 'default',
    schedule TEXT NOT NULL,  -- A cron expression in local time (cron.py).
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    last_fire_at REAL  -- The last due time that the scheduler handled. NULL: none yet.
);
-- One run of a routine. The session stays when the routine is deleted.
CREATE TABLE IF NOT EXISTS routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    session_id TEXT,
    fire_at REAL NOT NULL,  -- The due time. A "Run now" uses the time of the click.
    started_at REAL NOT NULL,
    ended_at REAL,
    status TEXT NOT NULL,  -- running, waiting, done, failed, skipped.
    error TEXT
);
"""

ROUTINE_FIELDS = ("name", "prompt", "cwd", "provider", "model", "permission_mode", "schedule", "enabled")


def path_key(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


def folder_name(path: str) -> str:
    return os.path.basename(os.path.normpath(path)) or path


class Storage:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA)
        self._migrate()
        self.db.commit()

    def _migrate(self) -> None:
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(sessions)")}
        if "summary" not in columns:
            self.db.execute("ALTER TABLE sessions ADD COLUMN summary TEXT")
        if "pinned" not in columns:
            self.db.execute("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
        if "archived" not in columns:
            self.db.execute("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
        if "worktree" not in columns:
            self.db.execute("ALTER TABLE sessions ADD COLUMN worktree TEXT")
        if "routine_id" not in columns:
            self.db.execute("ALTER TABLE sessions ADD COLUMN routine_id TEXT")
        # The first start with the projects table: add the folders of the stored sessions.
        if self.db.execute("SELECT COUNT(*) FROM projects").fetchone()[0] == 0:
            rows = self.db.execute("SELECT cwd, MIN(created_at), MAX(updated_at) FROM sessions GROUP BY cwd").fetchall()
            for cwd, created, used in rows:
                self._insert_project(folder_name(cwd), cwd, created, used)

    # -- projects ---------------------------------------------------------------------

    def _insert_project(self, name: str, path: str, created: float, used: float) -> str:
        project_id = uuid.uuid4().hex[:12]
        self.db.execute(
            "INSERT OR IGNORE INTO projects (id, name, path, path_key, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?)",
            (project_id, name, path, path_key(path), created, used),
        )
        return project_id

    def list_projects(self) -> list[dict[str, Any]]:
        """The projects, the last used first, with the number of sessions in each folder."""
        rows = [dict(r) for r in self.db.execute(
            # rowid: the newer row is first when two times are equal (the Windows clock has steps of about 15 ms).
            "SELECT id, name, path, path_key, created_at, last_used FROM projects ORDER BY last_used DESC, rowid DESC")]
        counts: dict[str, int] = {}
        for cwd, count in self.db.execute("SELECT cwd, COUNT(*) FROM sessions GROUP BY cwd"):
            key = path_key(cwd)
            counts[key] = counts.get(key, 0) + count
        for row in rows:
            row["sessions"] = counts.get(row.pop("path_key"), 0)
        return rows

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return dict(row) if row else None

    def find_project(self, path: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM projects WHERE path_key = ?", (path_key(path),)).fetchone()
        return dict(row) if row else None

    def save_project(self, name: str, path: str, project_id: str | None = None) -> str:
        """Add a project, or change the project ``project_id``. Raise ValueError for a folder in another project."""
        other = self.find_project(path)
        if other and other["id"] != project_id:
            raise ValueError(f"The project {other['name']} already uses this folder.")
        now = time.time()
        if project_id is None:
            project_id = self._insert_project(name, path, now, now)
        else:
            cur = self.db.execute("UPDATE projects SET name = ?, path = ?, path_key = ?, last_used = ? WHERE id = ?",
                                  (name, path, path_key(path), now, project_id))
            if cur.rowcount == 0:
                raise ValueError("Unknown project.")
        self.db.commit()
        return project_id

    def delete_project(self, project_id: str) -> None:
        """Remove a project from the list. The folder and its sessions stay."""
        self.db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        self.db.commit()

    def touch_project(self, path: str) -> str:
        """Mark the project of a folder as used now. Add the folder as a project if it is not one."""
        found = self.find_project(path)
        now = time.time()
        if found is None:
            project_id = self._insert_project(folder_name(path), path, now, now)
        else:
            project_id = found["id"]
            self.db.execute("UPDATE projects SET last_used = ? WHERE id = ?", (now, project_id))
        self.db.commit()
        return project_id

    def close(self) -> None:
        self.db.close()

    def create_session(self, cwd: str, provider: str, model: str, worktree: str | None = None) -> str:
        """``cwd``: the project folder. ``worktree``: the JSON of the git worktree of the session, or None."""
        session_id = uuid.uuid4().hex
        now = time.time()
        self.db.execute(
            "INSERT INTO sessions (id, cwd, provider, model, created_at, updated_at, worktree) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (session_id, cwd, provider, model, now, now, worktree),
        )
        self.db.commit()
        return session_id

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return dict(row) if row else None

    def list_sessions(self, cwd: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        sql = ("SELECT id, cwd, provider, model, title, created_at, updated_at, pinned, archived, worktree, routine_id "
               "FROM sessions")
        params: tuple = ()
        sql += " ORDER BY updated_at DESC, rowid DESC"
        rows = [dict(r) for r in self.db.execute(sql, params)]
        for r in rows:
            r["pinned"] = bool(r["pinned"])
            r["archived"] = bool(r["archived"])
            try:  # The branch of a worktree session, for the sidebar. None: the session works in cwd.
                r["branch"] = json.loads(r.pop("worktree") or "null")["branch"]
            except (ValueError, TypeError, KeyError):
                r["branch"] = None
        if cwd:  # Compare as paths: case-insensitive on Windows.
            key = path_key(cwd)
            rows = [r for r in rows if path_key(r["cwd"]) == key]
        return rows[:limit]

    def update_session(self, session_id: str, touch: bool = True, **fields: Any) -> None:
        """Change fields of a session. ``touch``: the session is newer (for example after a prompt).
        A rename or a pin does not change the age of the session."""
        allowed = {"provider", "model", "title", "context_start", "summary", "pinned", "archived", "cwd", "routine_id"}
        fields = {k: v for k, v in fields.items() if k in allowed}
        if touch:
            fields["updated_at"] = time.time()
        if not fields:
            return
        assignments = ", ".join(f"{k} = ?" for k in fields)
        self.db.execute(f"UPDATE sessions SET {assignments} WHERE id = ?", (*fields.values(), session_id))
        self.db.commit()

    def delete_session(self, session_id: str) -> None:
        """Delete a session and its messages. It cannot be undone."""
        self.db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        self.db.execute("DELETE FROM checkpoints WHERE session_id = ?", (session_id,))
        self.db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        self.db.commit()

    def next_seq(self, session_id: str) -> int:
        row = self.db.execute("SELECT MAX(seq) FROM messages WHERE session_id = ?", (session_id,)).fetchone()
        return 0 if row[0] is None else row[0] + 1

    def append_messages(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        if not messages:
            return
        seq = self.next_seq(session_id)
        self.db.executemany(
            "INSERT INTO messages (session_id, seq, data) VALUES (?, ?, ?)",
            [(session_id, seq + i, json.dumps(m)) for i, m in enumerate(messages)],
        )
        self.db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (time.time(), session_id))
        self.db.commit()

    def load_messages(self, session_id: str) -> list[dict[str, Any]]:
        """Load the messages of the current context (after the last /clear)."""
        session = self.get_session(session_id)
        if session is None:
            return []
        rows = self.db.execute(
            "SELECT data FROM messages WHERE session_id = ? AND seq >= ? ORDER BY seq",
            (session_id, session["context_start"]),
        )
        return [json.loads(r[0]) for r in rows]

    def truncate_context(self, session_id: str, keep: int) -> None:
        """Delete the messages of the current context after the first ``keep`` messages (a rewind)."""
        session = self.get_session(session_id)
        if session is None:
            return
        self.db.execute(
            "DELETE FROM messages WHERE session_id = ? AND seq >= ?", (session_id, session["context_start"] + keep)
        )
        self.db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (time.time(), session_id))
        self.db.commit()

    # -- checkpoints ------------------------------------------------------------------

    def add_checkpoint(self, session_id: str, message_id: str, path: str, content: bytes | None) -> None:
        """Keep the content of a file before its first change in the turn of a message."""
        self.db.execute(
            "INSERT OR IGNORE INTO checkpoints (session_id, message_id, path, content) VALUES (?, ?, ?, ?)",
            (session_id, message_id, path, content),
        )
        self.db.commit()

    def first_checkpoints(self, session_id: str, message_ids: list[str]) -> dict[str, bytes | None]:
        """For each file that changed in the turns of these messages: the content before the first change."""
        if not message_ids:
            return {}
        marks = ",".join("?" * len(message_ids))
        rows = self.db.execute(
            f"SELECT path, content FROM checkpoints WHERE session_id = ? AND message_id IN ({marks}) ORDER BY rowid",
            (session_id, *message_ids),
        )
        first: dict[str, bytes | None] = {}
        for path, content in rows:
            first.setdefault(path, content)
        return first

    def delete_checkpoints(self, session_id: str, message_ids: list[str]) -> None:
        if not message_ids:
            return
        marks = ",".join("?" * len(message_ids))
        self.db.execute(f"DELETE FROM checkpoints WHERE session_id = ? AND message_id IN ({marks})", (session_id, *message_ids))
        self.db.commit()

    def copy_checkpoints(self, source: str, target: str, message_ids: list[str]) -> None:
        """A fork keeps the checkpoints of the messages that it copies."""
        if not message_ids:
            return
        marks = ",".join("?" * len(message_ids))
        self.db.execute(
            f"INSERT OR IGNORE INTO checkpoints (session_id, message_id, path, content) "
            f"SELECT ?, message_id, path, content FROM checkpoints WHERE session_id = ? AND message_id IN ({marks}) ORDER BY rowid",
            (target, source, *message_ids),
        )
        self.db.commit()

    def clear_context(self, session_id: str) -> None:
        self.update_session(session_id, context_start=self.next_seq(session_id), summary=None)

    def compact_context(self, session_id: str, removed: int, summary: str | None) -> None:
        """Move the context start past ``removed`` messages, and store the summary that replaces them."""
        session = self.get_session(session_id)
        if session is not None:
            self.update_session(session_id, context_start=session["context_start"] + removed, summary=summary)

    # -- routines ---------------------------------------------------------------------

    @staticmethod
    def _routine(row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["enabled"] = bool(item["enabled"])
        return item

    def list_routines(self) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM routines ORDER BY created_at, rowid")
        return [self._routine(r) for r in rows]

    def get_routine(self, routine_id: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM routines WHERE id = ?", (routine_id,)).fetchone()
        return self._routine(row) if row else None

    def save_routine(self, fields: dict[str, Any], routine_id: str | None = None) -> str:
        """Add a routine, or change the routine ``routine_id``. Raise ValueError for an unknown id."""
        values = {k: fields[k] for k in ROUTINE_FIELDS if k in fields}
        if "enabled" in values:
            values["enabled"] = 1 if values["enabled"] else 0
        now = time.time()
        if routine_id is None:
            routine_id = uuid.uuid4().hex[:12]
            values.update(id=routine_id, created_at=now, updated_at=now, last_fire_at=now)
            names = ", ".join(values)
            self.db.execute(f"INSERT INTO routines ({names}) VALUES ({', '.join('?' * len(values))})",
                            tuple(values.values()))
        else:
            values["updated_at"] = now
            if "schedule" in values or values.get("enabled"):
                # A new schedule, or a routine that is on again, starts now: no catch-up run for older times.
                values["last_fire_at"] = now
            assignments = ", ".join(f"{k} = ?" for k in values)
            cur = self.db.execute(f"UPDATE routines SET {assignments} WHERE id = ?", (*values.values(), routine_id))
            if cur.rowcount == 0:
                raise ValueError("Unknown routine.")
        self.db.commit()
        return routine_id

    def set_routine_fired(self, routine_id: str, fire_at: float) -> None:
        self.db.execute("UPDATE routines SET last_fire_at = ? WHERE id = ?", (fire_at, routine_id))
        self.db.commit()

    def delete_routine(self, routine_id: str) -> None:
        """Delete a routine and its run history. The sessions of the runs stay."""
        self.db.execute("DELETE FROM routine_runs WHERE routine_id = ?", (routine_id,))
        self.db.execute("DELETE FROM routines WHERE id = ?", (routine_id,))
        self.db.commit()

    def add_run(self, routine_id: str, fire_at: float, status: str, session_id: str | None = None,
                error: str | None = None) -> str:
        run_id = uuid.uuid4().hex[:12]
        now = time.time()
        ended = None if status in ("running", "waiting") else now
        self.db.execute(
            "INSERT INTO routine_runs (id, routine_id, session_id, fire_at, started_at, ended_at, status, error) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (run_id, routine_id, session_id, fire_at, now, ended, status, error))
        self.db.commit()
        return run_id

    def update_run(self, run_id: str, **fields: Any) -> None:
        fields = {k: v for k, v in fields.items() if k in {"session_id", "status", "error"}}
        if fields.get("status") in ("done", "failed", "skipped"):
            fields["ended_at"] = time.time()
        if not fields:
            return
        assignments = ", ".join(f"{k} = ?" for k in fields)
        self.db.execute(f"UPDATE routine_runs SET {assignments} WHERE id = ?", (*fields.values(), run_id))
        self.db.commit()

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM routine_runs WHERE id = ?", (run_id,)).fetchone()
        return dict(row) if row else None

    def list_runs(self, routine_id: str, limit: int = 20) -> list[dict[str, Any]]:
        """The runs of a routine, the newest first."""
        rows = self.db.execute("SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC, rowid DESC "
                               "LIMIT ?", (routine_id, limit))
        return [dict(r) for r in rows]

    def end_open_runs(self) -> None:
        """At the start of the daemon: a run that did not end stopped with the old daemon."""
        self.db.execute("UPDATE routine_runs SET status = 'failed', error = ?, ended_at = ? "
                        "WHERE status IN ('running', 'waiting')", ("Harness stopped during the run.", time.time()))
        self.db.commit()
