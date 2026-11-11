"""Tests for the Outlook (classic) connector: the built-in COM server (outlook_server.py) with a fake Outlook
(fake_outlook_com.py), the connector (connectors.py, the kind "desktop"), and the MCP connection."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

from harness_daemon import connectors, mcp_auth, outlook_server
from harness_daemon.config import harness_home
from harness_daemon.mcp_client import McpManager, load_mcp_config
from harness_daemon.outlook_server import DISCONNECTED, Outlook, OutlookError

import fake_outlook_com
from fake_outlook_com import App, ComError

FAKE = str(Path(fake_outlook_com.__file__).resolve())


@pytest.fixture
def app():
    return App()


@pytest.fixture
def outlook(app):
    return Outlook(lambda: app, lambda: None)


def call(outlook: Outlook, fn, *args):
    return outlook.call(lambda: fn(outlook, *args))


def test_folders_messages_and_search(outlook):
    folders = call(outlook, outlook_server.list_folders, 2)
    paths = [f["path"] for f in folders]
    assert "Inbox" in paths and "Inbox/Projects" in paths and "Drafts" in paths
    shared = next(f for f in folders if f["mailbox"] == "Shared")
    assert shared["path"] is None and "another mailbox" in shared["note"]
    assert "Inbox/Projects" not in [f["path"] for f in call(outlook, outlook_server.list_folders, 1)]

    messages = call(outlook, outlook_server.list_messages, "Inbox", 20, False)
    assert [m["subject"] for m in messages] == ["Invoice 42", "Bob's plan", "Old news"]  # Newest first.
    assert messages[0]["from_email"] == "bob@shop.example" and messages[0]["has_attachments"]
    assert [m["subject"] for m in call(outlook, outlook_server.list_messages, "Inbox", 20, True)] == ["Invoice 42"]
    assert len(call(outlook, outlook_server.list_messages, "inbox", 1, False)) == 1
    assert call(outlook, outlook_server.list_messages, "Inbox/Projects", 5, False)[0]["subject"] == "Kickoff"
    with pytest.raises(OutlookError, match="Folder 'Nope' is not in 'Inbox'"):
        call(outlook, outlook_server.list_messages, "Inbox/Nope", 5, False)

    found = call(outlook, outlook_server.search_messages, "Bob's", "", "Inbox", 30, 20)
    assert [m["subject"] for m in found] == ["Bob's plan"]
    assert "'%Bob''s%'" in fake_outlook_com.RESTRICTS[-1]  # The quote is escaped in the DASL filter.
    found = call(outlook, outlook_server.search_messages, "", "shop.example", "Inbox", 9999, 500)
    assert [m["subject"] for m in found] == ["Invoice 42"]


def test_read_a_message_and_errors(outlook, app):
    entry_id = app.inbox._items[1].EntryID
    message = call(outlook, outlook_server.get_message, entry_id, 20_000)
    assert message["subject"] == "Invoice 42" and message["body"] == "Pay by Friday."
    assert message["to"] == ["Pat <pat@example.com>"] and message["attachments"] == ["invoice.pdf"]
    assert message["folder"] == "Inbox" and "preview" not in message

    with pytest.raises(OutlookError, match="An object could not be found"):
        call(outlook, outlook_server.get_message, "nope", 100)
    with pytest.raises(OutlookError, match="YYYY-MM-DD"):
        call(outlook, outlook_server.list_events, 7, "11/10/2026")
    events = call(outlook, outlook_server.list_events, 7, "2026-11-09")
    assert [e["subject"] for e in events] == ["Standup"] and events[0]["start"] == "2026-11-10 09:00"


def test_connect_again_after_outlook_restarts(app):
    connects = []

    def connect():
        connects.append(1)
        return app

    outlook = Outlook(connect, lambda: None)
    entry_id = app.inbox._items[0].EntryID
    assert call(outlook, outlook_server.get_message, entry_id, 500)["subject"] == "Old news"
    app.fail_next = ComError(next(iter(DISCONNECTED)), "The RPC server is unavailable.")
    assert call(outlook, outlook_server.get_message, entry_id, 500)["subject"] == "Old news"
    assert len(connects) == 2

    app.fail_next = ComError(-2147024891, "Access is denied.")  # Not a lost connection: no second try.
    with pytest.raises(OutlookError, match="Outlook: Access is denied."):
        call(outlook, outlook_server.get_message, entry_id, 500)
    assert len(connects) == 2


def test_drafts_and_send(outlook, app):
    draft = call(outlook, outlook_server.create_draft, "bob@shop.example", "Hello", "Line 1\nLine 2", "")
    assert draft["saved_to"] == "Drafts" and draft["sent"] is False
    saved = app.items[draft["entry_id"]]
    assert saved.Parent is app.drafts and saved.Body == "Line 1\nLine 2" and not saved.sent

    original = app.inbox._items[1]
    reply = call(outlook, outlook_server.create_reply_draft, original.EntryID, "Thanks <b>Bob</b>\n\nPat", True)
    assert reply["to"] == "bob@shop.example" and reply["cc"] == "pat@example.com" and reply["subject"] == "RE: Invoice 42"
    html = app.items[reply["entry_id"]].HTMLBody
    # The new text comes first, escaped, above the signature and the original message.
    assert html.startswith("<html><body><p>Thanks &lt;b&gt;Bob&lt;/b&gt;</p><p>&nbsp;</p><p>Pat</p><p>Signature</p>")

    with pytest.raises(OutlookError, match="not in the Drafts folder"):
        call(outlook, outlook_server.send_draft, original.EntryID)
    assert call(outlook, outlook_server.send_draft, draft["entry_id"]) == {"sent": True, "subject": "Hello"}
    assert saved.sent


def test_check_and_the_tools_of_each_mode(outlook):
    assert outlook_server.check(outlook) == {"ok": True, "accounts": ["pat@example.com"]}

    def broken():
        raise ComError(-2147221005, "Invalid class string")

    assert outlook_server.check(Outlook(broken, lambda: None)) == {"ok": False, "error": "Outlook: Invalid class string"}

    async def names(mode: str) -> set[str]:
        server = outlook_server.build_server(outlook, mode)
        return {t.name for t in await server.list_tools()}

    read = {"list_folders", "list_messages", "search_messages", "get_message", "list_events"}
    organize = {"create_folder", "rename_folder", "move_folder", "move_messages", "mark_messages"}
    assert asyncio.run(names("read")) == read
    assert asyncio.run(names("draft")) == read | organize | {"create_draft", "create_reply_draft"}
    assert asyncio.run(names("send")) == read | organize | {"create_draft", "create_reply_draft", "send_draft"}


def test_organize_folders_and_messages(outlook, app):
    assert call(outlook, outlook_server.create_folder, "Inbox", " Finance ") == {"created": "Inbox/Finance"}
    assert call(outlook, outlook_server.create_folder, "Inbox", "Receipts") == {"created": "Inbox/Receipts"}
    with pytest.raises(OutlookError, match="has a folder 'Finance' already"):
        call(outlook, outlook_server.create_folder, "Inbox", "finance")
    with pytest.raises(OutlookError, match="no / or"):
        call(outlook, outlook_server.create_folder, "Inbox", "a/b")

    # A folder moves into a subfolder, with its messages.
    receipts = outlook.call(lambda: outlook.folder("Inbox/Receipts"))
    receipts.add(fake_outlook_com.Mail(app, "Receipt 1", "Shop", "shop@example.com", "Paid."))
    assert call(outlook, outlook_server.move_folder, "Inbox/Receipts", "Inbox/Finance") == {
        "moved": "Inbox/Receipts", "path": "Inbox/Finance/Receipts"}
    assert [m["subject"] for m in call(outlook, outlook_server.list_messages, "Inbox/Finance/Receipts", 10, False)] == ["Receipt 1"]
    with pytest.raises(OutlookError, match="into itself or into one of its subfolders"):
        call(outlook, outlook_server.move_folder, "Inbox/Finance", "Inbox/Finance/Receipts")
    for fn, args in ((outlook_server.move_folder, ("Inbox", "Inbox/Finance")),
                     (outlook_server.rename_folder, ("Drafts", "Old drafts"))):
        with pytest.raises(OutlookError, match="default folder"):
            call(outlook, fn, *args)
    assert call(outlook, outlook_server.rename_folder, "Inbox/Finance", "Money") == {
        "renamed": "Inbox/Finance", "path": "Inbox/Money"}
    names = [f["path"] for f in call(outlook, outlook_server.list_folders, 3)]
    assert "Inbox/Money/Receipts" in names and "Inbox/Finance" not in names

    # Messages move to a folder and get a new entry_id. A bad id does not stop the others.
    invoice = app.inbox._items[1]
    old_id = invoice.EntryID
    got = call(outlook, outlook_server.move_messages, [old_id, "mail-404", old_id], "Inbox/Money")
    assert got["to_folder"] == "Inbox/Money" and len(got["moved"]) == 1 and len(got["failed"]) == 1
    assert got["moved"][0]["old_entry_id"] == old_id and got["moved"][0]["entry_id"] != old_id
    assert invoice.Parent.Name == "Money" and invoice.UnRead
    assert call(outlook, outlook_server.mark_messages, [invoice.EntryID], True) == {"marked": 1, "read": True, "failed": []}
    assert not invoice.UnRead
    with pytest.raises(OutlookError, match="one or more entry_ids"):
        call(outlook, outlook_server.move_messages, [" "], "Inbox")


def user_servers() -> dict:
    return json.loads((harness_home() / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]


def status() -> dict:
    return next(i for i in asyncio.run(connectors.items())["items"] if i["id"] == "outlook-classic")


@pytest.fixture
def fake_server(harness_home, monkeypatch):
    monkeypatch.setattr(connectors, "OUTLOOK_COMMAND", [sys.executable, FAKE])


def test_connect_and_disconnect(fake_server):
    item = status()
    assert item["kind"] == "desktop" and item["source"] is None and item["mode"] == "draft"
    assert item["name"] == "Outlook (classic)"

    assert asyncio.run(connectors.connect("outlook-classic", "desktop", options={"mode": "read"})) == "pat@example.com"
    assert user_servers()["outlook-classic"] == {"command": "harness-daemon", "args": ["--mcp-server", "outlook"],
                                                "connector": "outlook-classic"}
    item = status()
    assert item["source"] == "desktop" and item["login"] == "pat@example.com" and item["mode"] == "read"
    assert item["accounts"] == [{"login": "pat@example.com", "type": "outlook", "read_only": True}]
    assert connectors.server_env("outlook-classic") == {"HARNESS_OUTLOOK_MODE": "read"}

    with pytest.raises(Exception, match="mode must be one of"):
        asyncio.run(connectors.connect("outlook-classic", "desktop", options={"mode": "all"}))
    with pytest.raises(Exception, match="source of Outlook"):
        asyncio.run(connectors.connect("outlook-classic", "token", "x"))
    with pytest.raises(Exception, match="no accounts to remove"):
        asyncio.run(connectors.remove_account("outlook-classic", "pat@example.com"))

    asyncio.run(connectors.disconnect("outlook-classic"))
    assert "outlook-classic" not in user_servers() and status()["source"] is None
    assert mcp_auth.read_record(connectors.record_key("outlook-classic")) == {}


def test_a_failed_check(harness_home, monkeypatch, tmp_path):
    script = tmp_path / "fail.py"
    script.write_text('import json; print(json.dumps({"ok": False, "error": "Outlook: no profile"}))', encoding="utf-8")
    monkeypatch.setattr(connectors, "OUTLOOK_COMMAND", [sys.executable, str(script)])
    with pytest.raises(connectors.ConnectorError, match="Outlook: no profile"):
        asyncio.run(connectors.connect("outlook-classic", "desktop", options={}))
    assert status()["source"] is None and not connectors.installed("outlook-classic")


def test_windows_only(harness_home, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    with pytest.raises(connectors.ConnectorError, match="only on Windows"):
        asyncio.run(connectors.connect("outlook-classic", "desktop", options={}))
    assert status()["available"] is False


def test_the_real_command(harness_home, monkeypatch):
    monkeypatch.setattr(connectors, "OUTLOOK_COMMAND", None)
    command, args = connectors.builtin_command("outlook-classic")
    assert command == sys.executable and args[-2:] == ["--mcp-server", "outlook"]
    assert connectors.builtin_command("email")[1][-1] == "mail" and connectors.builtin_command("github") is None


def test_the_server_over_mcp(fake_server, project):
    asyncio.run(connectors.connect("outlook-classic", "desktop", options={"mode": "draft"}))
    servers, problems = load_mcp_config(project)
    assert problems == [] and servers["outlook-classic"].transport == "stdio"

    async def main() -> None:
        box: dict = {"tools": []}

        async def emit(event: dict) -> None:
            return None

        manager = McpManager(project, emit, lambda tools: box.__setitem__("tools", tools))
        try:
            await manager.start()
            assert manager.servers["outlook-classic"].state == "connected", manager.servers["outlook-classic"].error
            names = {t.name for t in box["tools"]}
            assert {"mcp__outlook-classic__search_messages", "mcp__outlook-classic__create_draft"} <= names
            assert "mcp__outlook-classic__send_draft" not in names
            search = next(t for t in box["tools"] if t.name == "mcp__outlook-classic__search_messages")
            result = await search.run({"sender": "bob@shop"}, None)
            assert [m["subject"] for m in json.loads(result.output)] == ["Invoice 42"]
            read = next(t for t in box["tools"] if t.name == "mcp__outlook-classic__get_message")
            failed = await read.run({"entry_id": "nope"}, None)
            assert failed.is_error and "could not be found" in failed.output

            # The mode "send" adds send_draft.
            mcp_auth.update_record(connectors.record_key("outlook-classic"), mode="send")
            await manager.restart("outlook-classic")
            assert "mcp__outlook-classic__send_draft" in {t.name for t in box["tools"]}
        finally:
            await manager.close()

    asyncio.run(main())


def test_the_sidecar_has_the_pywin32_modules_that_load_at_run_time():
    """pywintypes imports win32timezone only when it converts a COM date. PyInstaller does not see that import,
    so the spec must name it. Without it, every tool that reads a date fails in the installed daemon."""
    spec = (Path(outlook_server.__file__).resolve().parents[1] / "packaging" / "harness-daemon.spec").read_text(
        encoding="utf-8")
    for module in ("win32com.client", "pythoncom", "pywintypes", "win32timezone"):
        assert f'"{module}"' in spec


@pytest.mark.skipif(sys.platform != "win32", reason="pywin32 is only on Windows")
def test_pywin32_converts_a_com_date():
    import pywintypes

    value = pywintypes.Time(1700000000)
    assert outlook_server._fmt_dt(value) is not None
