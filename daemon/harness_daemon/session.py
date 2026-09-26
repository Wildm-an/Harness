"""A session: one agent, its project folder, and its stored history."""

from __future__ import annotations

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

    @property
    def cwd(self):
        return self.agent.cwd

    def persist(self) -> None:
        history = self.agent.history
        self.storage.append_messages(self.id, history[self._saved:])
        self._saved = len(history)

    def set_title_from(self, text: str) -> None:
        if self.title:
            return
        line = text.strip().splitlines()[0] if text.strip() else ""
        self.title = line[:TITLE_CHARS] or None
        if self.title:
            self.storage.update_session(self.id, title=self.title)

    def on_compact(self, removed: int, summary: str | None) -> None:
        """The agent removed the first ``removed`` history messages. They are all in storage."""
        self.storage.compact_context(self.id, removed, summary)
        self._saved -= removed

    def clear(self) -> None:
        self.persist()
        self.agent.clear()
        self.storage.clear_context(self.id)
        self._saved = 0
