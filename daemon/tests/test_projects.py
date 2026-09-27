"""Tests for the saved projects of the start screen."""

from __future__ import annotations

import os

import pytest

from harness_daemon.storage import Storage

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def test_storage_projects(tmp_path):
    db = tmp_path / "a.db"
    storage = Storage(db)
    storage.create_session(str(tmp_path / "old"), "p", "m")
    storage.create_session(str(tmp_path / "old"), "p", "m")
    storage.close()

    # The first start with projects adds the folders of the stored sessions.
    storage = Storage(db)
    [old] = storage.list_projects()
    assert (old["name"], old["sessions"]) == ("old", 2)

    new_id = storage.save_project("Robot arm", str(tmp_path / "robot"))
    assert storage.list_projects()[0]["id"] == new_id  # The last used first.
    with pytest.raises(ValueError, match="already uses this folder"):
        storage.save_project("Copy", str(tmp_path / "robot"))
    if os.name == "nt":  # Windows paths ignore case.
        assert storage.find_project(str(tmp_path / "ROBOT"))["id"] == new_id

    assert storage.touch_project(str(tmp_path / "robot")) == new_id
    third = storage.touch_project(str(tmp_path / "third"))
    assert storage.get_project(third)["name"] == "third"
    storage.delete_project(third)
    assert [p["name"] for p in storage.list_projects()] == ["Robot arm", "old"]
    storage.close()


def test_projects_through_the_protocol(daemon, project, fake_model, tmp_path):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "projects.list"})
    assert c.until("projects")[0]["items"] == []

    # A missing folder needs "create".
    target = tmp_path / "work" / "new-app"
    c.send({"type": "projects.save", "name": "New app", "path": str(target)})
    assert "does not exist" in c.until("error")[0]["message"]
    c.send({"type": "projects.save", "name": "New app", "path": str(target), "create": True})
    reply = c.until("projects")[0]
    assert target.is_dir() and reply["items"][0]["name"] == "New app" and reply["saved"] == reply["items"][0]["id"]
    assert reply["items"][0]["exists"] and reply["items"][0]["sessions"] == 0

    c.send({"type": "projects.save", "path": "relative/path"})
    assert "absolute" in c.until("error")[0]["message"]

    # A session in a new folder adds the folder as a project. session.ready names the project.
    c.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model"})
    ready = c.until("session.ready")[0]
    assert ready["project"]["name"] == "project"
    c.send({"type": "projects.list"})
    items = c.until("projects")[0]["items"]
    assert [i["name"] for i in items] == ["project", "New app"] and items[0]["sessions"] == 1

    # Rename, then remove. The folder stays.
    c.send({"type": "projects.save", "id": items[1]["id"], "name": "Renamed", "path": str(target)})
    assert c.until("projects")[0]["items"][0]["name"] == "Renamed"
    c.send({"type": "projects.delete", "id": items[1]["id"]})
    assert [i["name"] for i in c.until("projects")[0]["items"]] == ["project"]
    assert target.is_dir()

    c.send({"type": "session.list", "cwd": str(project)})
    sessions = c.until("sessions")[0]
    assert len(sessions["items"]) == 1 and sessions["cwd"] == str(project)
    c.close()
