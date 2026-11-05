"""'Archive inactive sessions' (server.py archive_inactive): the user setting auto_archive_days."""

from __future__ import annotations

import asyncio
import json
import time

from harness_daemon import server
from harness_daemon.storage import Storage

from tests.test_server import Client, daemon  # noqa: F401 - the daemon fixture.

DAY = 86400


def test_old_sessions_are_archived_and_others_stay(harness_home, tmp_path, project):
    storage = Storage(tmp_path / "harness.db")
    old = storage.create_session(str(project), "fake", "m")
    pinned = storage.create_session(str(project), "fake", "m")
    storage.update_session(pinned, touch=False, pinned=1)
    new = storage.create_session(str(project), "fake", "m")
    later = time.time() + 3 * DAY
    storage.db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (later - DAY, new))
    storage.db.commit()

    # Never (no setting): nothing changes.
    assert asyncio.run(server.archive_inactive(storage, now=later)) == []

    (harness_home / "settings.json").write_text(json.dumps({"auto_archive_days": 2}))
    assert asyncio.run(server.archive_inactive(storage, now=later)) == [old]
    rows = {r["id"]: r for r in storage.list_sessions()}
    assert rows[old]["archived"] and not rows[pinned]["archived"] and not rows[new]["archived"]
    storage.close()


def test_the_setting_accepts_only_the_claude_choices(daemon, project):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "user_settings.set", "values": {"auto_archive_days": 14}})
    assert c.until("user_settings")[0]["values"]["auto_archive_days"] == 14
    c.send({"type": "user_settings.set", "values": {"auto_archive_days": 5}})
    assert "must be one of: 0, 1, 2, 7, 14, 30" in c.until("error")[0]["message"]
    c.close()
