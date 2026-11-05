"""Settings > General > Storage: the disk space report of the daemon (disk_usage.py)."""

from __future__ import annotations

from harness_daemon import disk_usage
from harness_daemon.storage import Storage

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

DAY = 86400


def _write(path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)


def test_the_report_has_each_category(harness_home, project, tmp_path, monkeypatch):
    models, browsers = tmp_path / "hf", tmp_path / "pw"
    monkeypatch.setattr(disk_usage, "hf_cache_dir", lambda: models)
    monkeypatch.setattr(disk_usage, "browsers_dir", lambda: browsers)
    _write(models / "models--org--tiny" / "snapshots" / "abc" / "tiny.gguf", 3000)
    _write(models / "models--org--tiny" / "snapshots" / "abc" / "README.md", 50)  # Not a model file.
    _write(browsers / "chromium-1" / "chrome.exe", 2000)
    _write(harness_home / "logs" / "daemon.log", 100)
    _write(harness_home / "chrome-automation" / "Default" / "Cookies", 200)
    _write(harness_home / "projects" / "p" / "memory" / "MEMORY.md", 10)
    _write(project / ".harness" / "worktrees" / "fix" / "a.txt", 700)

    storage = Storage(harness_home / "harness.db")
    storage.save_project("Project", str(project))
    now = 1_000 * DAY
    old = storage.create_session(str(project), "fake", "m")
    storage.append_messages(old, [{"role": "user", "content": "y" * 500}])
    storage.db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now - 40 * DAY, old))
    new = storage.create_session(str(project), "fake", "m")
    storage.db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now - DAY, new))
    storage.db.commit()

    report = disk_usage.usage(storage, now=now)
    sessions = report["sessions"]
    assert (sessions["count"], sessions["stale_count"]) == (2, 1) and sessions["stale_size"] > 500
    assert [w["name"] for w in sessions["worktrees"]] == ["fix"] and sessions["worktrees"][0]["size"] == 700
    assert sessions["size"] == sessions["database"] + 700 and sessions["database"] > 0
    assert report["models"]["items"] == [{"name": "org/tiny", "size": 3000}]
    assert report["runtime"]["size"] == 2000 and report["runtime"]["items"][0]["name"] == "chromium-1"
    assert {i["name"] for i in report["caches"]["items"]} == {"logs", "chrome-automation"}
    assert report["caches"]["size"] == 300
    assert "projects" in {i["name"] for i in report["memory"]["items"]}
    assert "harness.db" not in {i["name"] for i in report["memory"]["items"]}


def test_the_client_gets_the_report(daemon, harness_home):  # noqa: F811
    c = Client(daemon)
    c.send({"type": "disk.usage"})
    got = c.until("disk.usage")[0]
    assert {"sessions", "models", "runtime", "memory", "caches", "checked_at", "home"} <= set(got)
    c.close()
