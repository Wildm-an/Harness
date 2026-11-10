"""SQLite storage for projects, sessions, and message history."""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from . import routine_files, trash

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
    routine_id TEXT,  -- The routine that started the session (routines.py). NULL: the user started it.
    parent_id TEXT  -- The session that started this session (a fork, or the start_session tool). NULL: none.
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
-- The scheduler state of each routine. The routines are files in the routines folder (routine_files.py).
CREATE TABLE IF NOT EXISTS routine_state (
    id TEXT PRIMARY KEY,  -- The file name of the routine, with no ".md".
    created_at REAL NOT NULL,
    last_fire_at REAL,  -- The last due time that the scheduler handled.
    api_token_hash TEXT,  -- The SHA-256 of the API trigger token (hex). NULL: no API trigger.
    api_token_hint TEXT  -- The last 4 characters of the token, to tell the user which token is active.
);
-- One run of a routine. The session stays when the routine is deleted.
CREATE TABLE IF NOT EXISTS routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL,
    session_id TEXT,
    fire_at REAL NOT NULL,  -- The due time. A "Run now" uses the time of the click.
    started_at REAL NOT NULL,
    ended_at REAL,
    status TEXT NOT NULL,  -- running, waiting, done, failed, skipped.
    error TEXT
);
"""

ROUTINE_FIELDS = ("name", "prompt", "cwd", "model", "permission_mode", "schedule", "enabled")


def path_key(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


def folder_name(path: str) -> str:
    return os.path.basename(os.path.normpath(path)) or path


class Storage:
    def __init__(self, path: Path, routines_dir: Path | None = None):
        # The routine files. The default is the "routines" folder next to the database (~/.harness/routines).
        self.routines_dir = routines_dir or path.parent / "routines"
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
        if "parent_id" not in columns:
            self.db.execute("ALTER TABLE sessions ADD COLUMN parent_id TEXT")
        self._migrate_routines()
        state_columns = {row[1] for row in self.db.execute("PRAGMA table_info(routine_state)")}
        if "api_token_hash" not in state_columns:
            self.db.execute("ALTER TABLE routine_state ADD COLUMN api_token_hash TEXT")
            self.db.execute("ALTER TABLE routine_state ADD COLUMN api_token_hint TEXT")
        # The first start with the projects table: add the folders of the stored sessions.
        if self.db.execute("SELECT COUNT(*) FROM projects").fetchone()[0] == 0:
            rows = self.db.execute("SELECT cwd, MIN(created_at), MAX(updated_at) FROM sessions GROUP BY cwd").fetchall()
            for cwd, created, used in rows:
                self._insert_project(folder_name(cwd), cwd, created, used)

    def _migrate_routines(self) -> None:
        """Version 0.1.45 kept the routines in a table. Write each one to a file, and keep its runs."""
        tables = {row[0]: row[1] or "" for row in self.db.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table'")}
        if "routines" not in tables:
            return
        self.db.commit()  # PRAGMA foreign_keys does nothing in a transaction.
        self.db.execute("PRAGMA foreign_keys = OFF")  # The old routine_runs table refers to the routines table.
        try:
            if "REFERENCES routines" in tables.get("routine_runs", ""):
                self.db.execute("ALTER TABLE routine_runs RENAME TO routine_runs_old")
                self.db.executescript(SCHEMA)  # The new routine_runs table.
                self.db.execute("INSERT INTO routine_runs SELECT id, routine_id, session_id, fire_at, started_at, "
                                "ended_at, status, error FROM routine_runs_old")
                self.db.execute("DROP TABLE routine_runs_old")
            taken = {p.stem for p in self.routines_dir.glob(f"*{routine_files.SUFFIX}")}
            for row in self.db.execute("SELECT * FROM routines ORDER BY created_at").fetchall():
                old = dict(row)
                new_id = _unique(routine_files.slug(old["name"]), taken)
                taken.add(new_id)
                old["enabled"] = bool(old["enabled"])
                routine_files.write(self._routine_path(new_id), old)
                self.db.execute("INSERT OR REPLACE INTO routine_state (id, created_at, last_fire_at) VALUES (?, ?, ?)",
                                (new_id, old["created_at"], old["last_fire_at"]))
                self.db.execute("UPDATE routine_runs SET routine_id = ? WHERE routine_id = ?", (new_id, old["id"]))
                self.db.execute("UPDATE sessions SET routine_id = ? WHERE routine_id = ?", (new_id, old["id"]))
            self.db.execute("DROP TABLE routines")
        finally:
            self.db.execute("PRAGMA foreign_keys = ON")

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

    def _project_time(self) -> float:
        """The time for the "last used" order of the projects. Two changes in the same clock tick
        (Windows time.time() can repeat a value) still get the order of the changes."""
        now = max(time.time(), getattr(self, "_last_project_time", 0.0) + 1e-6)
        self._last_project_time = now
        return now

    def save_project(self, name: str, path: str, project_id: str | None = None) -> str:
        """Add a project, or change the project ``project_id``. Raise ValueError for a folder in another project."""
        other = self.find_project(path)
        if other and other["id"] != project_id:
            raise ValueError(f"The project {other['name']} already uses this folder.")
        now = self._project_time()
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
        now = self._project_time()
        if found is None:
            project_id = self._insert_project(folder_name(path), path, now, now)
        else:
            project_id = found["id"]
            self.db.execute("UPDATE projects SET last_used = ? WHERE id = ?", (now, project_id))
        self.db.commit()
        return project_id

    def close(self) -> None:
        self.db.close()

    def create_session(self, cwd: str, provider: str, model: str, worktree: str | None = None,
                       parent_id: str | None = None) -> str:
        """``cwd``: the project folder. ``worktree``: the JSON of the git worktree of the session, or None.
        ``parent_id``: the session that started this session (the sidebar shows it nested), or None."""
        session_id = uuid.uuid4().hex
        now = time.time()
        self.db.execute(
            "INSERT INTO sessions (id, cwd, provider, model, created_at, updated_at, worktree, parent_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, cwd, provider, model, now, now, worktree, parent_id),
        )
        self.db.commit()
        return session_id

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return dict(row) if row else None

    def list_sessions(self, cwd: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        sql = ("SELECT id, cwd, provider, model, title, created_at, updated_at, pinned, archived, worktree, routine_id, "
               "parent_id FROM sessions")
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

    def session_depth(self, session_id: str) -> int:
        """The number of parent sessions above a session: 0 for a session with no parent."""
        depth, seen, current = 0, {session_id}, session_id
        while True:
            row = self.db.execute("SELECT parent_id FROM sessions WHERE id = ?", (current,)).fetchone()
            if row is None or not row[0] or row[0] in seen:
                return depth
            depth += 1
            current = row[0]
            seen.add(current)

    def delete_session(self, session_id: str) -> None:
        """Delete a session, its messages, and its routine runs. It cannot be undone. Its nested sessions stay,
        with no parent."""
        self.db.execute("UPDATE sessions SET parent_id = NULL WHERE parent_id = ?", (session_id,))
        self.db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        self.db.execute("DELETE FROM checkpoints WHERE session_id = ?", (session_id,))
        self.db.execute("DELETE FROM routine_runs WHERE session_id = ?", (session_id,))
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

    def search_chats(self, project: str, query: str, exclude: str | None = None, limit: int = 5,
                     snippets: int = 3) -> list[dict[str, Any]]:
        """The past sessions of a project with user or agent text that has the words of ``query``.

        The best match comes first: more words, then a newer session. A worktree session belongs to its
        project. ``exclude`` is the current session. Each hit has the session title, its date, and
        ``snippets`` short parts of the matching messages.
        """
        from .memory import project_root

        words = [w.lower() for w in query.split() if w.strip()][:8]
        if not words:
            return []
        key = path_key(str(project_root(Path(project))))
        rows = self.db.execute("SELECT id, cwd, title, updated_at FROM sessions WHERE id != ? ORDER BY updated_at DESC",
                               (exclude or "",)).fetchall()
        hits: list[dict[str, Any]] = []
        # SQLite LIKE ignores the case of ASCII letters. JSON escapes other letters, so they skip this filter.
        ascii_words = [w for w in words if w.isascii()]
        like = " OR ".join("data LIKE ? ESCAPE '\\'" for _ in ascii_words)
        params = ["%" + w.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%" for w in ascii_words]
        for row in rows:
            if path_key(str(project_root(Path(row["cwd"])))) != key:
                continue
            sql = "SELECT data FROM messages WHERE session_id = ?" + (f" AND ({like})" if like else "") + " ORDER BY seq"
            matches: list[tuple[int, str, str]] = []
            found: set[str] = set()
            for (data,) in self.db.execute(sql, (row["id"], *params)):
                try:
                    message = json.loads(data)
                except ValueError:
                    continue
                role = message.get("role")
                if role not in ("user", "assistant"):
                    continue
                content = message.get("display") or message.get("content")
                if isinstance(content, list):
                    content = " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
                text = " ".join(str(content or "").split())
                lower = text.lower()
                present = [w for w in words if w in lower]
                if present:
                    found.update(present)
                    matches.append((len(present), role, _snippet(text, lower.find(present[0]))))
            if matches:
                matches.sort(key=lambda m: -m[0])
                hits.append({"id": row["id"], "title": row["title"], "updated_at": row["updated_at"], "score": len(found),
                             "snippets": [{"role": r, "text": t} for _, r, t in matches[:snippets]]})
        hits.sort(key=lambda h: (-h["score"], -h["updated_at"]))
        return hits[:limit]

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

    def checkpoint_rows(self, session_id: str, message_ids: list[str]) -> list[tuple[str, str, bytes | None]]:
        """All checkpoints of these messages, in order: (message_id, path, content). For "Undo rewind"."""
        if not message_ids:
            return []
        marks = ",".join("?" * len(message_ids))
        rows = self.db.execute(
            f"SELECT message_id, path, content FROM checkpoints WHERE session_id = ? AND message_id IN ({marks}) ORDER BY rowid",
            (session_id, *message_ids),
        )
        return [(m, p, c) for m, p, c in rows]

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

    # -- routines (files in routines_dir, routine_files.py) -----------------------------

    def _routine_path(self, routine_id: str) -> Path:
        if not routine_files.valid_id(routine_id):
            raise ValueError("Unknown routine.")
        return self.routines_dir / f"{routine_id}{routine_files.SUFFIX}"

    def _state(self, routine_id: str) -> dict[str, Any]:
        """The scheduler state of a routine. A new file (also one that the user made by hand) starts now:
        no run for older due times."""
        row = self.db.execute("SELECT * FROM routine_state WHERE id = ?", (routine_id,)).fetchone()
        if row is not None:
            return dict(row)
        now = time.time()
        self.db.execute("INSERT INTO routine_state (id, created_at, last_fire_at) VALUES (?, ?, ?)",
                        (routine_id, now, now))
        self.db.commit()
        return {"id": routine_id, "created_at": now, "last_fire_at": now}

    def _load_routine(self, path: Path) -> dict[str, Any]:
        item = routine_files.read(path)
        state = self._state(item["id"])
        item["created_at"] = state["created_at"]
        item["last_fire_at"] = state["last_fire_at"]
        # The API trigger: active when a token exists. The client never gets the token or its hash.
        item["api"] = {"active": bool(state.get("api_token_hash")), "hint": state.get("api_token_hint")}
        try:
            item["updated_at"] = path.stat().st_mtime
        except OSError:
            item["updated_at"] = state["created_at"]
        return item

    def list_routines(self) -> list[dict[str, Any]]:
        """The routines of the files in the folder, the oldest first. A file with a problem has an "error"."""
        if not self.routines_dir.is_dir():
            return []
        paths = [p for p in self.routines_dir.glob(f"*{routine_files.SUFFIX}")
                 if p.is_file() and routine_files.valid_id(p.stem)]
        items = [self._load_routine(p) for p in paths]
        return sorted(items, key=lambda r: (r["created_at"], r["id"]))

    def get_routine(self, routine_id: str) -> dict[str, Any] | None:
        try:
            path = self._routine_path(routine_id)
        except ValueError:
            return None
        return self._load_routine(path) if path.is_file() else None

    def save_routine(self, fields: dict[str, Any], routine_id: str | None = None) -> str:
        """Add a routine file, or change the file of ``routine_id``. Raise ValueError for an unknown id
        or for fields with a problem. The id (the file name) does not change with the name."""
        values = {k: fields[k] for k in ROUTINE_FIELDS if k in fields}
        now = time.time()
        if routine_id is None:
            taken = {p.stem for p in self.routines_dir.glob(f"*{routine_files.SUFFIX}")} if self.routines_dir.is_dir() else set()
            routine_id = _unique(routine_files.slug(str(values.get("name") or "")), taken)
            item = {"name": "", "prompt": "", "cwd": "", "model": None, "permission_mode": "default",
                    "schedule": "", "enabled": True, **values}
            fire_now = True
        else:
            old = self.get_routine(routine_id)
            if old is None:
                raise ValueError("Unknown routine.")
            item = {**old, **values}
            # A new schedule, or a routine that is on again, starts now: no run for older times.
            fire_now = (values.get("schedule", old["schedule"]) != old["schedule"]
                        or (bool(values.get("enabled")) and not old["enabled"]))
        error = routine_files.problem(item)
        if error:
            raise ValueError(error)
        routine_files.write(self._routine_path(routine_id), item)
        self.db.execute("INSERT OR IGNORE INTO routine_state (id, created_at, last_fire_at) VALUES (?, ?, ?)",
                        (routine_id, now, now))
        if fire_now:
            self.db.execute("UPDATE routine_state SET last_fire_at = ? WHERE id = ?", (now, routine_id))
        self.db.commit()
        return routine_id

    def set_routine_fired(self, routine_id: str, fire_at: float) -> None:
        self._state(routine_id)
        self.db.execute("UPDATE routine_state SET last_fire_at = ? WHERE id = ?", (fire_at, routine_id))
        self.db.commit()

    def set_routine_token(self, routine_id: str, token_hash: str | None, hint: str | None) -> None:
        """Set the API trigger token of a routine (its hash and a hint), or remove it (None)."""
        self._state(routine_id)
        self.db.execute("UPDATE routine_state SET api_token_hash = ?, api_token_hint = ? WHERE id = ?",
                        (token_hash, hint, routine_id))
        self.db.commit()

    def routine_token_hash(self, routine_id: str) -> str | None:
        row = self.db.execute("SELECT api_token_hash FROM routine_state WHERE id = ?", (routine_id,)).fetchone()
        return row[0] if row else None

    def delete_routine(self, routine_id: str) -> None:
        """Delete the file of a routine (on Windows: to the Recycle Bin) and its run history.
        The sessions of the runs stay."""
        path = self._routine_path(routine_id)
        if path.exists():
            trash.delete(path)
        self.db.execute("DELETE FROM routine_runs WHERE routine_id = ?", (routine_id,))
        self.db.execute("DELETE FROM routine_state WHERE id = ?", (routine_id,))
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
        """The runs of a routine, the newest first. A run whose session is gone (an old daemon did not delete
        the run with the session) is not in the list. A skipped run has no session and stays."""
        rows = self.db.execute("SELECT * FROM routine_runs WHERE routine_id = ? AND (session_id IS NULL OR "
                               "session_id IN (SELECT id FROM sessions)) ORDER BY started_at DESC, rowid DESC "
                               "LIMIT ?", (routine_id, limit))
        return [dict(r) for r in rows]

    def end_open_runs(self) -> None:
        """At the start of the daemon: a run that did not end stopped with the old daemon."""
        self.db.execute("UPDATE routine_runs SET status = 'failed', error = ?, ended_at = ? "
                        "WHERE status IN ('running', 'waiting')", ("Harness stopped during the run.", time.time()))
        self.db.commit()


def _unique(base: str, taken: set[str]) -> str:
    """``base``, or ``base-2``, ``base-3``, and so on: a name that is not in ``taken``."""
    folded = {t.lower() for t in taken}  # Windows file names do not show case.
    name, n = base, 1
    while name.lower() in folded:
        n += 1
        name = f"{base}-{n}"
    return name


SNIPPET_CHARS = 300


def _snippet(text: str, at: int) -> str:
    """About SNIPPET_CHARS characters of a text around the position ``at``."""
    if len(text) <= SNIPPET_CHARS:
        return text
    start = max(0, at - SNIPPET_CHARS // 3)
    end = min(len(text), start + SNIPPET_CHARS)
    start = max(0, end - SNIPPET_CHARS)
    return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")
