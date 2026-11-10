"""A session: one agent, its project folder, and its stored history."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable

from .agent import Agent
from .storage import Storage

TITLE_CHARS = 80

# Starts a nested session of a session: (parent, title, prompt, worktree, mode) -> {"id", "folder"}.
# server.py sets it. None (for example in a test with no server): the agent has no start_session tool.
CHILD_STARTER: Callable[..., Awaitable[dict[str, Any]]] | None = None
# Sends a prompt to another stored session and starts its turn: (source, target_id, prompt) -> {"id", "title"}.
# server.py sets it. None: the agent can only start a new session.
SESSION_SENDER: Callable[..., Awaitable[dict[str, Any]]] | None = None

OTHER_SESSIONS = 12  # The other sessions of the project that the agent sees in the session list note.
READ_MESSAGES = 8  # The last user and agent messages that session_read gives.
READ_CHARS = 1200  # The longest message text that session_read gives.


def _text_of(message: dict[str, Any]) -> str:
    content = message.get("display") or message.get("content")
    if isinstance(content, list):
        content = " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return " ".join(str(content or "").split())


class Session:
    def __init__(self, storage: Storage, session_id: str, agent: Agent, title: str | None = None,
                 project_dir: Path | None = None, worktree: dict | None = None):
        self.storage = storage
        self.id = session_id
        self.agent = agent
        self.title = title
        # The project folder of the user. It is the agent folder, except for a worktree session:
        # then the agent works in the worktree (worktrees.py).
        self.project_dir = Path(project_dir) if project_dir is not None else Path(agent.cwd)
        self.worktree = worktree
        self.offers = True  # False for a routine session: the agent has no offer_session (disable_offer).
        self._saved = len(agent.history)  # The number of history messages in storage.
        # The state before the last rewind, for "Undo rewind". A new turn, /clear, or a summary removes it.
        self.rewind_undo: dict[str, Any] | None = None
        agent.on_compact = self.on_compact
        agent.on_checkpoint = lambda message_id, path, content: storage.add_checkpoint(self.id, message_id, path, content)
        # "Search and reference chats": the agent can search the other sessions of the project.
        agent.enable_chat_search(lambda query, limit: storage.search_chats(
            str(self.project_dir), query, exclude=self.id, limit=limit))
        # start_session: the agent starts a nested session, with this session as its parent.
        if CHILD_STARTER is not None:
            starter = CHILD_STARTER
            agent.enable_session_start(lambda title, prompt, worktree, mode: starter(self, title, prompt, worktree, mode))
        # The context of the other sessions: a list note, session_read, and offer_session.
        sender = SESSION_SENDER
        agent.enable_session_context(
            self.session_list_note, self.read_session, self.find_other,
            (lambda target, prompt: sender(self, target, prompt)) if sender is not None else None)

    # -- the other sessions of the project ------------------------------------------------

    def other_sessions(self) -> list[dict[str, Any]]:
        """The other sessions of the project that are not archived, the newest first (by the creation time:
        the list stays the same while the sessions work, so the agent does not get it again each turn)."""
        from .memory import project_root
        from .storage import path_key

        key = path_key(str(project_root(self.project_dir)))
        rows = [r for r in self.storage.list_sessions(limit=500)
                if r["id"] != self.id and not r["archived"] and path_key(str(project_root(Path(r["cwd"])))) == key]
        rows.sort(key=lambda r: -r["created_at"])
        return rows[:OTHER_SESSIONS]

    def session_list_note(self) -> str | None:
        """The harness note with the other sessions of the project. None: no other session."""
        rows = self.other_sessions()
        if not rows:
            return None
        parent = (self.storage.get_session(self.id) or {}).get("parent_id")
        lines = []
        for r in rows:
            relation = (" (a nested session of this session)" if r.get("parent_id") == self.id
                        else " (the parent of this session)" if r["id"] == parent else "")
            lines.append(f"- {r['id'][:8]}: {r['title'] or 'Untitled session'}{relation}")
        offer = (" When the user asks for a task that is not part of the work of this session, or that fits one "
                 "of these sessions better, call offer_session before you start the task.") if self.offers else ""
        return ("[Harness: The other sessions of this project, the newest first. The user can work in them "
                f"too. Use session_read to see the conversation of one.{offer}]\n" + "\n".join(lines))

    def disable_offer(self) -> None:
        """A routine session: no offer_session. A routine runs with no user to choose, so the task stays here."""
        self.offers = False
        self.agent.disable_offer()

    def find_other(self, ref: str) -> dict[str, Any] | None:
        """A session of the project by its id or the first characters of the id (8 or more)."""
        ref = ref.strip().lower()
        if len(ref) < 8:
            return None
        from .memory import project_root
        from .storage import path_key

        key = path_key(str(project_root(self.project_dir)))
        for r in self.storage.list_sessions(limit=500):
            if r["id"] != self.id and r["id"].startswith(ref) and path_key(str(project_root(Path(r["cwd"])))) == key:
                return r
        return None

    def read_session(self, ref: str) -> str:
        """The title, the first prompt, and the last messages of another session of the project."""
        row = self.find_other(ref)
        if row is None:
            raise ValueError(f"No other session of this project has the id {ref}. Use an id of the session list.")
        messages = [m for m in self.storage.load_messages(row["id"])
                    if m.get("role") in ("user", "assistant") and m.get("origin") != "harness" and _text_of(m)]
        lines = [f"# {row['title'] or 'Untitled session'} (id {row['id'][:8]}, model {row['model']})"]
        summary = (self.storage.get_session(row["id"]) or {}).get("summary")
        if summary:
            lines.append(f"Summary of the earlier conversation: {summary[:READ_CHARS]}")
        if not messages:
            lines.append("The session has no messages.")
            return "\n".join(lines)
        first = messages[0]
        shown = messages[-READ_MESSAGES:]
        if first not in shown:
            lines.append(f"First prompt: {_text_of(first)[:READ_CHARS]}")
            lines.append(f"({len(messages) - len(shown) - 1} messages are not shown.)")
        for m in shown:
            who = "User" if m["role"] == "user" else "Agent"
            lines.append(f"{who}: {_text_of(m)[:READ_CHARS]}")
        return "\n".join(lines)

    @property
    def cwd(self):
        return self.agent.cwd

    def persist(self) -> None:
        history = self.agent.history
        self.storage.append_messages(self.id, history[self._saved:])
        self._saved = len(history)

    def set_title_from(self, text: str) -> bool:
        """Use the first line of the first prompt as the title. Return True if the title is new."""
        if self.title:
            return False
        line = text.strip().splitlines()[0] if text.strip() else ""
        self.title = line[:TITLE_CHARS] or None
        if self.title:
            self.storage.update_session(self.id, title=self.title)
        return self.title is not None

    def on_compact(self, removed: int, summary: str | None) -> None:
        """The agent removed the first ``removed`` history messages. They are all in storage."""
        self.storage.compact_context(self.id, removed, summary)
        self._saved -= removed
        self.rewind_undo = None  # The history indexes changed.

    def clear(self) -> None:
        self.rewind_undo = None
        self.persist()
        self.agent.clear()
        self.storage.clear_context(self.id)
        self._saved = 0

    def user_index(self, message_id: str) -> int:
        """The history index of a user message. ValueError if a summary replaced it, or it does not exist."""
        for i, m in enumerate(self.agent.history):
            if m.get("role") == "user" and m.get("id") == message_id:
                return i
        raise ValueError("This message is not in the context. A summary replaced it, or /clear removed it.")

    def message_ids_from(self, index: int) -> list[str]:
        return [m["id"] for m in self.agent.history[index:] if m.get("role") == "user" and m.get("id")]

    def rewind(self, message_id: str, conversation: bool, code: bool) -> tuple[str, list[Path]]:
        """Go back to the time before a user message. Return the text of the message, and the restored files.

        ``code``: the files that the edit and write tools changed after the message get their old content.
        Changes of bash commands are not restored. ``conversation``: the message and the messages after it go away.
        """
        index = self.user_index(message_id)
        message = self.agent.history[index]
        later = self.message_ids_from(index)
        restored: list[Path] = []
        checkpoints = self.storage.first_checkpoints(self.id, later) if code else {}
        # Keep what the rewind changes, for "Undo rewind": the files as they are now, and the removed messages.
        undo: dict[str, Any] = {"files": {}, "index": None}
        for rel in checkpoints:
            path = Path(self.cwd) / rel
            undo["files"][rel] = path.read_bytes() if path.is_file() else None
        if conversation:
            undo["index"] = index
            undo["messages"] = self.agent.history[index:]
            undo["checkpoints"] = self.storage.checkpoint_rows(self.id, later)
        if code:
            for rel, content in checkpoints.items():
                path = Path(self.cwd) / rel
                if content is None:
                    path.unlink(missing_ok=True)  # The agent made the file.
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content)
                restored.append(path)
        if conversation:
            self.persist()
            self.storage.truncate_context(self.id, index)
            self.storage.delete_checkpoints(self.id, later)
            self.agent.rewind(index)
            self._saved = index
        self.rewind_undo = undo
        return message.get("display") or message.get("content") or "", restored

    def undo_rewind(self) -> tuple[bool, list[Path]]:
        """Go back to the state before the last rewind. Return True if the conversation came back, and the files.

        ValueError: no rewind to undo, or the conversation changed after the rewind.
        """
        undo = self.rewind_undo
        if undo is None:
            raise ValueError("There is no rewind to undo. A new turn, /clear, or a summary removes the undo.")
        index = undo["index"]
        if index is not None and len(self.agent.history) != index:
            raise ValueError("The conversation changed after the rewind, so the rewind cannot be undone.")
        self.rewind_undo = None
        restored: list[Path] = []
        for rel, content in undo["files"].items():
            path = Path(self.cwd) / rel
            if content is None:
                path.unlink(missing_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            restored.append(path)
        if index is not None:
            self.agent.rewind(index)  # Resets the token count (and the ACP session) as a rewind does.
            self.agent.history.extend(undo["messages"])
            for message_id, rel, content in undo["checkpoints"]:
                self.storage.add_checkpoint(self.id, message_id, rel, content)
            self.persist()
        return index is not None, restored
