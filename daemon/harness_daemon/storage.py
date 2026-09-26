"""SQLite storage for sessions and message history."""

from __future__ import annotations

import json
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
    summary TEXT
);
CREATE TABLE IF NOT EXISTS messages (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
);
"""


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

    def close(self) -> None:
        self.db.close()

    def create_session(self, cwd: str, provider: str, model: str) -> str:
        session_id = uuid.uuid4().hex
        now = time.time()
        self.db.execute(
            "INSERT INTO sessions (id, cwd, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, cwd, provider, model, now, now),
        )
        self.db.commit()
        return session_id

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return dict(row) if row else None

    def list_sessions(self, cwd: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        sql = "SELECT id, cwd, provider, model, title, created_at, updated_at FROM sessions"
        params: tuple = ()
        if cwd:
            sql += " WHERE cwd = ?"
            params = (cwd,)
        sql += " ORDER BY updated_at DESC LIMIT ?"
        return [dict(r) for r in self.db.execute(sql, (*params, limit))]

    def update_session(self, session_id: str, **fields: Any) -> None:
        allowed = {"provider", "model", "title", "context_start", "summary"}
        fields = {k: v for k, v in fields.items() if k in allowed}
        fields["updated_at"] = time.time()
        assignments = ", ".join(f"{k} = ?" for k in fields)
        self.db.execute(f"UPDATE sessions SET {assignments} WHERE id = ?", (*fields.values(), session_id))
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

    def clear_context(self, session_id: str) -> None:
        self.update_session(session_id, context_start=self.next_seq(session_id), summary=None)

    def compact_context(self, session_id: str, removed: int, summary: str | None) -> None:
        """Move the context start past ``removed`` messages, and store the summary that replaces them."""
        session = self.get_session(session_id)
        if session is not None:
            self.update_session(session_id, context_start=session["context_start"] + removed, summary=summary)
