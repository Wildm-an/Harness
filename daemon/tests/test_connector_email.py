"""Tests for the Email connector: the built-in mail server (mail_server.py), the connector (connectors.py, the
kind "mail"), the MCP connection, and the removal of the old Chrome and Gmail connectors."""

from __future__ import annotations

import asyncio
import json
import socket
from email import message_from_bytes, policy

import pytest

from harness_daemon import connectors, mcp_auth, mail_server
from harness_daemon.config import harness_home
from harness_daemon.mail_server import Account, Mail, MailError
from harness_daemon.mcp_client import McpManager, load_mcp_config

import fake_mail
from test_server import Client, daemon  # noqa: F401 - the daemon fixture

USER, PASSWORD = "pat@example.com", "app-pass-1234"


@pytest.fixture
def mailbox():
    store = fake_mail.MailStore(USER, PASSWORD)
    imap, smtp = fake_mail.start(store)
    store.add("INBOX", fake_mail.message("Old news", date="Mon, 02 Nov 2026 09:00:00 +0000"), {"\\Seen"})
    store.add("INBOX", fake_mail.message("Invoice 42", sender="Bob <bob@shop.example>", text="Pay by Friday"))
    store.add("INBOX", fake_mail.message("Grüße aus Köln", text="Schöne Grüße", date="Wed, 04 Nov 2026 08:00:00 +0000"))
    store.add("INBOX", fake_mail.message("Newsletter", html="<html><body><p>Big <b>sale</b></p><script>x()</script></body></html>"))
    yield store, imap.server_address[1], smtp.server_address[1]
    imap.shutdown()
    smtp.shutdown()


def account(imap_port: int, smtp_port: int, password: str = PASSWORD) -> Account:
    return Account(USER, password, "127.0.0.1", imap_port, "plain", "127.0.0.1", smtp_port, "plain")


def options(imap_port: int, smtp_port: int, **extra) -> dict:
    return {"email": USER, "password": PASSWORD, "provider": "other", "imap_host": "127.0.0.1",
            "imap_port": imap_port, "imap_security": "plain", "smtp_host": "127.0.0.1", "smtp_port": smtp_port,
            "smtp_security": "plain", **extra}


# -- the mail server -----------------------------------------------------------------------------------------


def test_folders_search_and_read(mailbox):
    store, imap_port, smtp_port = mailbox
    mail = Mail([account(imap_port, smtp_port)], read_only=False)
    folders = {f["name"]: f["special"] for f in mail.list_folders(None)}
    assert folders == {"INBOX": None, "Sent": "sent", "Trash": "trash", "Entwürfe": None}

    newest = mail.search(None, "INBOX", None, None, None, None, None, False, None, 20)
    assert [m["subject"] for m in newest] == ["Newsletter", "Grüße aus Köln", "Invoice 42", "Old news"]
    assert newest[-1]["unread"] is False and newest[0]["unread"] is True
    assert [m["subject"] for m in mail.search(None, "INBOX", None, "bob", None, None, None, False, None, 20)] == ["Invoice 42"]
    unread = mail.search(None, "INBOX", None, None, None, "2026-11-03", None, True, None, 20)
    assert [m["subject"] for m in unread] == ["Newsletter", "Grüße aus Köln", "Invoice 42"]
    # A value with characters that are not ASCII goes as a literal, after the other values.
    umlaut = mail.search(None, "INBOX", "Schöne", None, "aus", None, None, False, None, 20)
    assert [m["subject"] for m in umlaut] == ["Grüße aus Köln"]
    with pytest.raises(MailError, match="Only one search value"):
        mail.search(None, "INBOX", "Schöne", "Köln", "Grüße", None, None, False, None, 20)
    with pytest.raises(MailError, match="YYYY-MM-DD"):
        mail.search(None, "INBOX", None, None, None, "yesterday", None, False, None, 20)
    with pytest.raises(MailError, match="does not exist"):
        mail.search(None, "Nope", None, None, None, None, None, False, None, 20)

    html = mail.read(None, "INBOX", newest[0]["uid"])
    assert html["text"] == "Big sale" and html["attachments"] == []
    invoice = mail.read(None, "INBOX", newest[2]["uid"])
    assert invoice["text"].strip() == "Pay by Friday" and invoice["from"] == "Bob <bob@shop.example>"
    assert "\\Seen" not in store.folders["INBOX"][1].flags  # Reading does not mark it as read.


def test_change_move_delete_and_send(mailbox):
    store, imap_port, smtp_port = mailbox
    mail = Mail([account(imap_port, smtp_port)], read_only=False)
    invoice = store.folders["INBOX"][1].uid
    mail.mark(None, "INBOX", invoice, True, True)
    assert store.folders["INBOX"][1].flags == {"\\Seen", "\\Flagged"}
    mail.mark(None, "INBOX", invoice, False, None)
    assert store.folders["INBOX"][1].flags == {"\\Flagged"}

    assert mail.move(None, "INBOX", invoice, "Entwürfe") == "The message is in Entwürfe."
    assert [m.uid for m in store.folders["Entw&APw-rfe"]] == [invoice]
    with pytest.raises(MailError, match="does not exist"):
        mail.move(None, "INBOX", store.folders["INBOX"][0].uid, "Archive")

    old = store.folders["INBOX"][0].uid
    assert mail.delete(None, "INBOX", old) == "The message is in Trash."
    assert [m.uid for m in store.folders["Trash"]] == [old]
    with pytest.raises(MailError, match="already in the trash"):
        mail.delete(None, "Trash", old)

    # A reply joins the thread of the original message.
    original = store.folders["INBOX"][0]
    original_id = message_from_bytes(original.raw, policy=policy.default)["Message-ID"]
    assert mail.send(None, ["Ann <ann@example.com>"], "Re: Grüße", "Danke!", ["cc@example.com"], ["bcc@example.com"],
                     original.uid, "INBOX") == "Sent to ann@example.com, cc@example.com, bcc@example.com."
    sender, recipients, data = store.sent[-1]
    sent = message_from_bytes(data, policy=policy.default)
    assert sender == USER and recipients == ["ann@example.com", "cc@example.com", "bcc@example.com"]
    assert sent["In-Reply-To"] == original_id and sent["Subject"] == "Re: Grüße" and "Bcc" not in sent
    assert sent.get_content().strip() == "Danke!"


def test_read_only_errors_and_accounts(mailbox):
    store, imap_port, smtp_port = mailbox
    read_only = Mail([account(imap_port, smtp_port)], read_only=True)
    for call in (lambda: read_only.mark(None, "INBOX", 1, True, None), lambda: read_only.delete(None, "INBOX", 1),
                 lambda: read_only.send(None, ["a@example.com"], "s", "b", None, None, None, "INBOX")):
        with pytest.raises(MailError, match="read-only"):
            call()

    with pytest.raises(MailError, match="refused the login"):
        Mail([account(imap_port, smtp_port, "wrong")], False).list_folders(None)
    two = Mail([account(imap_port, smtp_port), Account("sam@example.com", "x", "127.0.0.1", imap_port, "plain",
                                                       "", 0, "plain")], False)
    with pytest.raises(MailError, match="Name the account"):
        two.list_folders(None)
    with pytest.raises(MailError, match="No connected account"):
        two.list_folders("nobody@example.com")
    with pytest.raises(MailError, match="No email account"):
        Mail([], False).list_folders(None)
    with pytest.raises(MailError, match="only for a mail server on this computer"):
        Account.from_json({"email": USER, "password": "x", "imap_host": "imap.example.com", "imap_port": 143,
                           "imap_security": "plain"})
    store.smtp_password = "another"  # IMAP takes the password, and SMTP refuses it.
    with pytest.raises(MailError, match="refused the login for sending"):
        mail_server.check_account(account(imap_port, smtp_port), True)
    mail_server.check_account(account(imap_port, smtp_port), False)  # Read-only: no SMTP check.


def test_folder_names():
    assert mail_server.encode_folder("Entwürfe & Co") == "Entw&APw-rfe &- Co"
    assert mail_server.decode_folder("Entw&APw-rfe &- Co") == "Entwürfe & Co"
    assert mail_server.decode_folder(mail_server.encode_folder("下書き")) == "下書き"


# -- the connector -------------------------------------------------------------------------------------------


def user_servers() -> dict:
    return json.loads((harness_home() / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]


def email_status() -> dict:
    return next(i for i in asyncio.run(connectors.items())["items"] if i["id"] == "email")


def test_connect_accounts(harness_home, mailbox):
    store, imap_port, smtp_port = mailbox
    status = email_status()
    assert status["source"] is None and status["kind"] == "mail"
    assert [p["id"] for p in status["providers"]] == ["gmail", "icloud", "yahoo", "fastmail", "zoho", "gmx", "other"]

    login = asyncio.run(connectors.connect("email", "mail", options=options(imap_port, smtp_port)))
    assert login == USER
    assert user_servers()["email"] == {"command": "harness-daemon", "args": ["--mcp-server", "mail"],
                                      "connector": "email"}
    assert PASSWORD not in json.dumps(user_servers())  # mcp.json has no password.
    status = email_status()
    assert status["accounts"] == [{"login": USER, "type": "other", "read_only": False}]
    assert PASSWORD not in json.dumps(status)
    env = connectors.server_env("email")
    assert json.loads(env["HARNESS_MAIL_ACCOUNTS"])[0]["password"] == PASSWORD and env["HARNESS_MAIL_READ_ONLY"] == "0"

    with pytest.raises(connectors.ConnectorError, match="refused the login"):
        asyncio.run(connectors.connect("email", "mail", options={**options(imap_port, smtp_port), "password": "nope"}))
    with pytest.raises(connectors.ConnectorError, match="email address"):
        asyncio.run(connectors.connect("email", "mail", options={**options(imap_port, smtp_port), "email": "pat"}))
    with pytest.raises(Exception, match="source of Email"):
        asyncio.run(connectors.connect("email", "token", "x"))

    # Google shows an app password in groups of 4: the spaces go away.
    again = {**options(imap_port, smtp_port), "password": " ".join([PASSWORD[:4], PASSWORD[4:]])}
    asyncio.run(connectors.connect("email", "mail", options=again))
    assert len(email_status()["accounts"]) == 1  # The same address replaces the account.

    asyncio.run(connectors.remove_account("email", USER))
    assert "email" not in user_servers() and email_status()["source"] is None

    asyncio.run(connectors.connect("email", "mail", options=options(imap_port, smtp_port, read_only=True)))
    assert connectors.server_env("email")["HARNESS_MAIL_READ_ONLY"] == "1"
    asyncio.run(connectors.disconnect("email"))
    assert "email" not in user_servers() and mcp_auth.read_record(connectors.record_key("email")) == {}


def test_smtp_does_not_look_up_the_host_name(mailbox, monkeypatch):
    """smtplib calls socket.getfqdn() for the EHLO name when it gets no name. On macOS that DNS lookup can take
    many seconds, and the connect of the Email connector timed out in the release build."""
    store, imap_port, smtp_port = mailbox

    def no_lookup(*args):
        raise AssertionError("socket.getfqdn() was called")

    monkeypatch.setattr(socket, "getfqdn", no_lookup)
    mail_server.check_account(account(imap_port, smtp_port), True)
    mail = Mail([account(imap_port, smtp_port)], read_only=False)
    assert mail.send(None, ["bob@shop.example"], "Hi", "Hello", None, None, None, "INBOX").startswith("Sent to")
    assert mail_server.ehlo_name()


def test_a_preset_provider():
    account = connectors._mail_account({"email": "pat@gmail.com", "password": "abcd efgh ijkl mnop", "provider": "gmail"})
    assert (account["imap_host"], account["imap_port"], account["imap_security"]) == ("imap.gmail.com", 993, "ssl")
    assert (account["smtp_host"], account["smtp_port"], account["password"]) == ("smtp.gmail.com", 465, "abcdefghijklmnop")
    with pytest.raises(connectors.ConnectorError, match="IMAP server"):
        connectors._mail_account({"email": "a@b.example", "password": "x", "provider": "other"})


def test_the_mail_server_over_mcp(harness_home, project, mailbox):
    store, imap_port, smtp_port = mailbox
    asyncio.run(connectors.connect("email", "mail", options=options(imap_port, smtp_port)))
    servers, problems = load_mcp_config(project)
    assert problems == [] and servers["email"].connector == "email" and servers["email"].transport == "stdio"

    async def main() -> None:
        box: dict = {"tools": []}

        async def emit(event: dict) -> None:
            return None

        manager = McpManager(project, emit, lambda tools: box.__setitem__("tools", tools))
        try:
            await manager.start()
            assert manager.servers["email"].state == "connected", manager.servers["email"].error
            names = {t.name for t in box["tools"]}
            assert {"mcp__email__search_messages", "mcp__email__read_message", "mcp__email__send_message"} <= names
            search = next(t for t in box["tools"] if t.name == "mcp__email__search_messages")
            result = await search.run({"sender": "bob"}, None)
            assert json.loads(result.output)[0]["subject"] == "Invoice 42"
            delete = next(t for t in box["tools"] if t.name == "mcp__email__delete_message")
            failed = await delete.run({"uid": 999, "folder": "Trash"}, None)
            assert failed.is_error and "already in the trash" in failed.output

            # Read-only: the server has no tools that change mail.
            data = mcp_auth.read_record(connectors.record_key("email"))
            mcp_auth.update_record(connectors.record_key("email"), read_only=True)
            assert data
            await manager.restart("email")
            names = {t.name for t in box["tools"]}
            assert "mcp__email__search_messages" in names and "mcp__email__send_message" not in names
        finally:
            await manager.close()

    asyncio.run(main())


def test_email_messages(daemon, project, fake_model, mailbox):  # noqa: F811
    store, imap_port, smtp_port = mailbox
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "connectors.connect", "id": "email", "source": "mail", "options": options(imap_port, smtp_port)})
    listing = c.until("connectors", timeout=30)[0]
    email = next(i for i in listing["items"] if i["id"] == "email")
    assert email["accounts"][0]["login"] == USER
    status = c.until("mcp", timeout=60)[0]
    while not any(i["name"] == "email" and i["state"] == "connected" for i in status["items"]):
        status = c.until("mcp", timeout=60)[0]
    c.send({"type": "connectors.remove_account", "id": "email", "login": USER})
    listing = c.until("connectors", timeout=30)[0]
    assert next(i for i in listing["items"] if i["id"] == "email")["source"] is None
    c.close()


# -- the removed connectors ------------------------------------------------------------------------------------


def test_the_retired_connectors(harness_home, project):
    """Harness 0.1.44 had Chrome and Gmail connectors. Their entries give a clear message, and the Connectors
    tab removes them, with the Gmail credential files."""
    path = harness_home / "mcp.json"
    path.write_text(json.dumps({"mcpServers": {
        "chrome": {"command": "npx", "args": ["-y", "chrome-devtools-mcp@1.12.0"], "connector": "chrome"},
        "gmail": {"command": "uvx", "args": ["workspace-mcp@2.3.0"], "connector": "gmail"},
        "mine": {"command": "my-server"},
    }}), encoding="utf-8")
    creds = harness_home / "connectors" / "gmail" / "credentials"
    creds.mkdir(parents=True)
    (creds / "pat@gmail.com.json").write_text("{}", encoding="utf-8")
    mcp_auth.update_record(connectors.record_key("gmail"), source="google", client_id="x")
    servers, problems = load_mcp_config(project)
    assert "chrome" not in servers and "gmail" not in servers and "mine" in servers
    assert any("no longer has the Chrome" in p for p in problems)
    assert any("no longer has the Gmail" in p for p in problems)

    items = asyncio.run(connectors.items())["items"]
    assert [i["id"] for i in items] == ["github", "outlook", "email"]
    assert list(user_servers()) == ["mine"]
    assert not (harness_home / "connectors" / "gmail").exists()
    assert mcp_auth.read_record(connectors.record_key("gmail")) == {}
