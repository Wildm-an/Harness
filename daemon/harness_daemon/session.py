"""A session: one agent, its project folder, and its stored history."""

from __future__ import annotations

from pathlib import Path

from .agent import Agent
from .storage import Storage

TITLE_CHARS = 80


class Session:
    def __init__(self, storage: Storage, session_id: str, agent: Agent, title: str | None = None):
        self.storage = storage
        self.id = session_id
        self.agent = agent
        self.title = title
        self._saved = len(agent.history)  # The number of history messages in storage.
        agent.on_compact = self.on_compact
        agent.on_checkpoint = lambda message_id, path, content: storage.add_checkpoint(self.id, message_id, path, content)

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

    def clear(self) -> None:
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
        if code:
            for rel, content in self.storage.first_checkpoints(self.id, later).items():
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
        return message.get("display") or message.get("content") or "", restored
