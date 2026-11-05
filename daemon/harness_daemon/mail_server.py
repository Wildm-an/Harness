"""The built-in mail server of the Email connector (connectors.py, the kind "mail"): an MCP server on stdio.

It uses only the standard library: imaplib for the mailboxes and smtplib to send. The daemon starts it as
``harness-daemon --mcp-server mail`` (frozen) or ``python -m harness_daemon --mcp-server mail``, and gives it
the accounts in the environment, not in mcp.json:

- HARNESS_MAIL_ACCOUNTS: a JSON list of accounts: {"email", "password", "imap_host", "imap_port",
  "imap_security", "smtp_host", "smtp_port", "smtp_security"}. Security is "ssl", "starttls", or "plain"
  (plain only for a server on this computer, for tests).
- HARNESS_MAIL_READ_ONLY: "1" removes the tools that send, change, move, or delete.

Each tool call opens its own connection and closes it at the end. A tool takes an "account" parameter (the
address). With one account, the parameter is optional.
"""

from __future__ import annotations

import base64
import email
import email.policy
import imaplib
import json
import os
import re
import smtplib
import socket
import ssl
from dataclasses import dataclass
from datetime import date, datetime
from email.message import EmailMessage, Message
from email.utils import getaddresses, make_msgid, parsedate_to_datetime
from html import unescape
from typing import Any

TIMEOUT = 30


def ehlo_name() -> str:
    """The name of this computer in the SMTP greeting (EHLO). With no name, smtplib asks socket.getfqdn(): a
    reverse DNS lookup that can take many seconds, for example on macOS. Mail servers do not check this name."""
    name = socket.gethostname()
    return name if re.fullmatch(r"[A-Za-z0-9.-]{1,253}", name or "") else "localhost"
MAX_TEXT = 20_000  # The characters of a message body that read_message returns.
MAX_RESULTS = 100
SECURITY = ("ssl", "starttls", "plain")
LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")


class MailError(Exception):
    """A mail error. The text is for the user and the agent."""


@dataclass
class Account:
    email: str
    password: str
    imap_host: str
    imap_port: int
    imap_security: str
    smtp_host: str
    smtp_port: int
    smtp_security: str

    @classmethod
    def from_json(cls, raw: dict[str, Any]) -> "Account":
        account = cls(
            email=str(raw["email"]).strip(), password=str(raw["password"]),
            imap_host=str(raw["imap_host"]).strip(), imap_port=int(raw["imap_port"]),
            imap_security=str(raw.get("imap_security", "ssl")),
            smtp_host=str(raw.get("smtp_host") or "").strip(), smtp_port=int(raw.get("smtp_port") or 0),
            smtp_security=str(raw.get("smtp_security", "ssl")))
        for host, security in ((account.imap_host, account.imap_security), (account.smtp_host, account.smtp_security)):
            if security not in SECURITY:
                raise MailError(f"The security must be one of: {', '.join(SECURITY)}.")
            if security == "plain" and host and host not in LOCAL_HOSTS:
                raise MailError("A connection with no encryption is only for a mail server on this computer.")
        return account


# -- modified UTF-7 (RFC 3501, section 5.1.3) for the names of folders ------------------------------------


def encode_folder(name: str) -> str:
    out: list[str] = []
    buffer = ""

    def flush() -> None:
        nonlocal buffer
        if buffer:
            data = base64.b64encode(buffer.encode("utf-16-be")).decode().rstrip("=").replace("/", ",")
            out.append(f"&{data}-")
            buffer = ""

    for ch in name:
        if 0x20 <= ord(ch) <= 0x7E:
            flush()
            out.append("&-" if ch == "&" else ch)
        else:
            buffer += ch
    flush()
    return "".join(out)


def decode_folder(name: str) -> str:
    def replace(match: re.Match) -> str:
        data = match.group(1)
        if not data:
            return "&"
        data = data.replace(",", "/")
        data += "=" * (-len(data) % 4)
        return base64.b64decode(data).decode("utf-16-be")

    return re.sub(r"&([A-Za-z0-9+,]*)-", replace, name)


def quote(value: str) -> str:
    """An IMAP quoted string."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


# -- IMAP ---------------------------------------------------------------------------------------------------


LIST_RE = re.compile(r'\((?P<flags>[^)]*)\)\s+(?P<delim>"(?:[^"\\]|\\.)*"|NIL)\s+(?P<name>.+)$')
UID_RE = re.compile(rb"UID (\d+)")
FLAGS_RE = re.compile(rb"FLAGS \(([^)]*)\)")


def _text(value: Any) -> str:
    return value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)


class Imap:
    """One IMAP connection, opened with "with"."""

    def __init__(self, account: Account):
        self.account = account
        self.conn: imaplib.IMAP4 | None = None

    def __enter__(self) -> "Imap":
        a = self.account
        try:
            if a.imap_security == "ssl":
                conn: imaplib.IMAP4 = imaplib.IMAP4_SSL(a.imap_host, a.imap_port, ssl_context=ssl.create_default_context(),
                                                        timeout=TIMEOUT)
            else:
                conn = imaplib.IMAP4(a.imap_host, a.imap_port, timeout=TIMEOUT)
                if a.imap_security == "starttls":
                    conn.starttls(ssl.create_default_context())
        except (OSError, imaplib.IMAP4.error) as e:
            raise MailError(f"Harness could not reach the mail server {a.imap_host}:{a.imap_port}: {e}") from None
        # iCloud can want only the part before "@" for IMAP.
        names = [a.email, a.email.split("@")[0]] if a.imap_host.endswith("mail.me.com") else [a.email]
        for index, name in enumerate(names):
            try:
                conn.login(name, a.password)
                break
            except imaplib.IMAP4.error:
                if index + 1 < len(names):
                    continue
                try:
                    conn.logout()
                except Exception:  # noqa: BLE001
                    pass
                raise MailError(f"The mail server refused the login of {a.email}. Check the address and the app password.") from None
        self.conn = conn
        return self

    def __exit__(self, *exc: Any) -> None:
        if self.conn is not None:
            try:
                self.conn.logout()
            except Exception:  # noqa: BLE001
                pass
            self.conn = None

    def _ok(self, result: tuple[str, list[Any]], what: str) -> list[Any]:
        status, data = result
        if status != "OK":
            detail = _text(data[0]) if data and data[0] else status
            raise MailError(f"The mail server could not {what}: {detail}")
        return data

    def folders(self) -> list[dict[str, Any]]:
        assert self.conn is not None
        out = []
        for line in self._ok(self.conn.list(), "list the folders"):
            if not line:
                continue
            match = LIST_RE.match(_text(line))
            if not match:
                continue
            raw = match.group("name").strip()
            if raw.startswith('"') and raw.endswith('"'):
                raw = raw[1:-1].replace('\\"', '"').replace("\\\\", "\\")
            flags = match.group("flags").split()
            special = next((f[1:].lower() for f in flags if f in ("\\Trash", "\\Sent", "\\Drafts", "\\Junk", "\\All",
                                                                     "\\Archive", "\\Flagged")), None)
            out.append({"name": decode_folder(raw), "raw": raw, "special": special,
                        "selectable": "\\Noselect" not in flags and "\\NoSelect" not in flags})
        return out

    def select(self, folder: str, readonly: bool) -> None:
        assert self.conn is not None
        status, data = self.conn.select(quote(encode_folder(folder)), readonly=readonly)
        if status != "OK":
            raise MailError(f"The folder {folder!r} does not exist. Use list_folders to see the folders.")

    def search(self, criteria: list[str], literal: str | None) -> list[int]:
        """UID SEARCH. ``literal`` is a value with characters that are not ASCII, sent as the last argument."""
        assert self.conn is not None
        args = list(criteria)
        if literal is not None:
            self.conn.literal = literal.encode("utf-8")  # type: ignore[attr-defined]
            args = ["CHARSET", "UTF-8", *args]
        data = self._ok(self.conn.uid("SEARCH", *args), "search")
        return [int(x) for x in _text(data[0] or b"").split()]

    def fetch_headers(self, uids: list[int]) -> list[dict[str, Any]]:
        assert self.conn is not None
        if not uids:
            return []
        fields = "BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)]"
        data = self._ok(self.conn.uid("FETCH", ",".join(map(str, uids)), f"(UID FLAGS RFC822.SIZE {fields})"),
                        "read the messages")
        found: dict[int, dict[str, Any]] = {}
        for part in data:
            if not isinstance(part, tuple):
                continue
            head, body = part[0], part[1]
            uid = UID_RE.search(head)
            if not uid:
                continue
            flags = FLAGS_RE.search(head)
            message = email.message_from_bytes(body, policy=email.policy.default)
            found[int(uid.group(1))] = _summary(int(uid.group(1)), message,
                                                _text(flags.group(1)).split() if flags else [])
        return [found[u] for u in uids if u in found]

    def fetch_message(self, uid: int) -> tuple[Message, list[str]]:
        assert self.conn is not None
        data = self._ok(self.conn.uid("FETCH", str(uid), "(UID FLAGS BODY.PEEK[])"), "read the message")
        for part in data:
            if isinstance(part, tuple):
                flags = FLAGS_RE.search(part[0])
                return (email.message_from_bytes(part[1], policy=email.policy.default),
                        _text(flags.group(1)).split() if flags else [])
        raise MailError(f"The message {uid} does not exist in this folder. Use search_messages to find it.")

    def store(self, uid: int, add: bool, flags: str) -> None:
        assert self.conn is not None
        self._ok(self.conn.uid("STORE", str(uid), "+FLAGS.SILENT" if add else "-FLAGS.SILENT", f"({flags})"),
                 "change the message")

    def move(self, uid: int, target: str) -> None:
        assert self.conn is not None
        folder = quote(encode_folder(target))
        capabilities = {_text(c).upper() for c in self.conn.capabilities}
        if "MOVE" in capabilities:
            self._ok(self.conn.uid("MOVE", str(uid), folder), f"move the message to {target}")
            return
        self._ok(self.conn.uid("COPY", str(uid), folder), f"copy the message to {target}")
        self.store(uid, True, "\\Deleted")
        if "UIDPLUS" in capabilities:
            self._ok(self.conn.uid("EXPUNGE", str(uid)), "remove the message from the folder")
        else:
            self._ok(self.conn.expunge(), "remove the message from the folder")


def _summary(uid: int, message: Message, flags: list[str]) -> dict[str, Any]:
    when = message.get("Date")
    try:
        sent = parsedate_to_datetime(when).isoformat() if when else None
    except (TypeError, ValueError):
        sent = None
    return {"uid": uid, "from": str(message.get("From", "")), "to": str(message.get("To", "")),
            "subject": str(message.get("Subject", "")), "date": sent,
            "unread": "\\Seen" not in flags, "flagged": "\\Flagged" in flags,
            "message_id": str(message.get("Message-ID", "")) or None}


def html_to_text(html: str) -> str:
    html = re.sub(r"(?is)<(script|style|head)\b.*?</\1>", " ", html)
    html = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</tr>|</h[1-6]>", "\n", html)
    text = unescape(re.sub(r"<[^>]+>", " ", html))
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def message_text(message: Message) -> tuple[str, list[dict[str, Any]]]:
    """The text of a message (the plain part, or the HTML part as text), and its attachments."""
    body = message.get_body(preferencelist=("plain", "html")) if hasattr(message, "get_body") else None
    text = ""
    if body is not None:
        try:
            content = body.get_content()
        except (LookupError, ValueError):
            content = body.get_payload(decode=True) or b""
            content = content.decode("utf-8", "replace") if isinstance(content, bytes) else str(content)
        text = html_to_text(content) if body.get_content_type() == "text/html" else str(content)
    attachments = []
    for part in message.iter_attachments() if hasattr(message, "iter_attachments") else []:
        payload = part.get_payload(decode=True) or b""
        attachments.append({"name": part.get_filename() or "(no name)", "type": part.get_content_type(),
                            "size": len(payload)})
    return text, attachments


# -- the operations of the tools ----------------------------------------------------------------------------


class Mail:
    """The accounts and the operations. The MCP tools call these methods."""

    def __init__(self, accounts: list[Account], read_only: bool):
        self.accounts = accounts
        self.read_only = read_only

    @classmethod
    def from_env(cls) -> "Mail":
        try:
            raw = json.loads(os.environ.get("HARNESS_MAIL_ACCOUNTS") or "[]")
        except ValueError:
            raw = []
        return cls([Account.from_json(a) for a in raw if isinstance(a, dict)],
                   os.environ.get("HARNESS_MAIL_READ_ONLY") == "1")

    def account(self, address: str | None) -> Account:
        if not self.accounts:
            raise MailError("No email account is connected. Ask the user to add one on the Connectors tab.")
        if not address:
            if len(self.accounts) == 1:
                return self.accounts[0]
            names = ", ".join(a.email for a in self.accounts)
            raise MailError(f"Name the account: one of {names}.")
        for a in self.accounts:
            if a.email.lower() == address.strip().lower():
                return a
        raise MailError(f"No connected account {address}. The accounts: {', '.join(a.email for a in self.accounts)}.")

    def _writable(self) -> None:
        if self.read_only:
            raise MailError("The Email connector is read-only.")

    def list_accounts(self) -> list[str]:
        return [a.email for a in self.accounts]

    def list_folders(self, account: str | None) -> list[dict[str, Any]]:
        with Imap(self.account(account)) as imap:
            return [{k: v for k, v in f.items() if k != "raw"} for f in imap.folders() if f["selectable"]]

    def search(self, account: str | None, folder: str, text: str | None, sender: str | None, subject: str | None,
               since: str | None, before: str | None, unread_only: bool, gmail_query: str | None,
               limit: int) -> list[dict[str, Any]]:
        a = self.account(account)
        criteria: list[str] = []
        for name, value in (("SINCE", since), ("BEFORE", before)):
            if value:
                try:
                    day = date.fromisoformat(value)
                except ValueError:
                    raise MailError(f"'{name.lower()}' must be a date as YYYY-MM-DD.") from None
                criteria.extend([name, day.strftime("%d-%b-%Y")])
        if unread_only:
            criteria.append("UNSEEN")
        if gmail_query and "gmail" not in a.imap_host:
            raise MailError("gmail_query works only with a Gmail account.")
        # A value with characters that are not ASCII goes as a literal, and IMAP sends a literal last.
        literal: str | None = None
        last: str | None = None
        for key, value in (("FROM", sender), ("SUBJECT", subject), ("TEXT", text), ("X-GM-RAW", gmail_query)):
            if not value:
                continue
            if value.isascii():
                criteria.extend([key, quote(value)])
            elif literal is None:
                literal, last = value, key
            else:
                raise MailError("Only one search value can have characters that are not ASCII.")
        if last is not None:
            criteria.append(last)
        with Imap(a) as imap:
            imap.select(folder, readonly=True)
            uids = imap.search(criteria or ["ALL"], literal)
            newest = sorted(uids, reverse=True)[:max(1, min(limit, MAX_RESULTS))]
            return imap.fetch_headers(newest)

    def read(self, account: str | None, folder: str, uid: int) -> dict[str, Any]:
        with Imap(self.account(account)) as imap:
            imap.select(folder, readonly=True)
            message, flags = imap.fetch_message(uid)
        text, attachments = message_text(message)
        result = _summary(uid, message, flags)
        result["cc"] = str(message.get("Cc", "")) or None
        result["text"] = text if len(text) <= MAX_TEXT else text[:MAX_TEXT] + "\n[The text is longer. It ends here.]"
        result["attachments"] = attachments
        return result

    def mark(self, account: str | None, folder: str, uid: int, read: bool | None, flagged: bool | None) -> str:
        self._writable()
        if read is None and flagged is None:
            raise MailError("Give 'read', 'flagged', or both.")
        with Imap(self.account(account)) as imap:
            imap.select(folder, readonly=False)
            if read is not None:
                imap.store(uid, read, "\\Seen")
            if flagged is not None:
                imap.store(uid, flagged, "\\Flagged")
        return "The message is changed."

    def move(self, account: str | None, folder: str, uid: int, to_folder: str) -> str:
        self._writable()
        with Imap(self.account(account)) as imap:
            names = {f["name"] for f in imap.folders()}
            if to_folder not in names:
                raise MailError(f"The folder {to_folder!r} does not exist. Use list_folders to see the folders.")
            imap.select(folder, readonly=False)
            imap.move(uid, to_folder)
        return f"The message is in {to_folder}."

    def delete(self, account: str | None, folder: str, uid: int) -> str:
        """Move the message to the trash folder of the account (the folder with the \\Trash flag)."""
        self._writable()
        with Imap(self.account(account)) as imap:
            trash = next((f["name"] for f in imap.folders() if f["special"] == "trash"), None)
            if trash is None:
                raise MailError("The account has no trash folder. Use move_message with a folder.")
            if trash == folder:
                raise MailError("The message is already in the trash.")
            imap.select(folder, readonly=False)
            imap.move(uid, trash)
        return f"The message is in {trash}."

    def send(self, account: str | None, to: list[str], subject: str, body: str, cc: list[str] | None,
             bcc: list[str] | None, reply_to_uid: int | None, folder: str) -> str:
        self._writable()
        a = self.account(account)
        if not a.smtp_host:
            raise MailError(f"The account {a.email} has no SMTP server.")
        recipients = [addr for _, addr in getaddresses([*to, *(cc or []), *(bcc or [])]) if addr]
        if not recipients:
            raise MailError("Give at least one recipient.")
        message = EmailMessage()
        message["From"] = a.email
        message["To"] = ", ".join(to)
        if cc:
            message["Cc"] = ", ".join(cc)
        message["Subject"] = subject
        message["Message-ID"] = make_msgid(domain=a.email.split("@")[-1])
        message["Date"] = email.utils.format_datetime(datetime.now().astimezone())
        if reply_to_uid is not None:
            with Imap(a) as imap:
                imap.select(folder, readonly=True)
                original, _ = imap.fetch_message(reply_to_uid)
            original_id = original.get("Message-ID")
            if original_id:
                message["In-Reply-To"] = original_id
                message["References"] = " ".join(filter(None, [str(original.get("References", "")), original_id]))
        message.set_content(body)
        try:
            if a.smtp_security == "ssl":
                server: smtplib.SMTP = smtplib.SMTP_SSL(a.smtp_host, a.smtp_port, timeout=TIMEOUT, local_hostname=ehlo_name(),
                                                        context=ssl.create_default_context())
            else:
                server = smtplib.SMTP(a.smtp_host, a.smtp_port, timeout=TIMEOUT, local_hostname=ehlo_name())
                if a.smtp_security == "starttls":
                    server.starttls(context=ssl.create_default_context())
            with server:
                server.login(a.email, a.password)
                server.send_message(message, from_addr=a.email, to_addrs=recipients)
        except smtplib.SMTPAuthenticationError:
            raise MailError(f"The mail server refused the login of {a.email}. Check the address and the app password.") from None
        except (smtplib.SMTPException, OSError) as e:
            raise MailError(f"The message was not sent: {e}") from None
        return f"Sent to {', '.join(recipients)}."


def check_account(account: Account, send: bool) -> None:
    """Log in to IMAP, and to SMTP if ``send``. Raise MailError with a text for the user. Blocks."""
    with Imap(account) as imap:
        imap.folders()
    if not send or not account.smtp_host:
        return
    try:
        if account.smtp_security == "ssl":
            server: smtplib.SMTP = smtplib.SMTP_SSL(account.smtp_host, account.smtp_port, timeout=TIMEOUT,
                                                    local_hostname=ehlo_name(),
                                                    context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(account.smtp_host, account.smtp_port, timeout=TIMEOUT,
                                  local_hostname=ehlo_name())
            if account.smtp_security == "starttls":
                server.starttls(context=ssl.create_default_context())
        with server:
            server.login(account.email, account.password)
    except smtplib.SMTPAuthenticationError:
        raise MailError("The mail server refused the login for sending (SMTP). Check the app password.") from None
    except (smtplib.SMTPException, OSError, socket.timeout) as e:
        raise MailError(f"Harness could not reach the sending server {account.smtp_host}:{account.smtp_port}: {e}") from None


# -- the MCP server -----------------------------------------------------------------------------------------


def build_server(mail: Mail) -> Any:
    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError

    names = ", ".join(mail.list_accounts()) or "none"
    server = MCPServer("harness-email", instructions=(
        f"Email accounts: {names}. Each tool takes 'account' (the address); with one account it is optional. "
        "Find messages with search_messages, then read one with read_message and its uid. A uid is valid only "
        "in its folder." + (" The connector is read-only." if mail.read_only else "")))

    def run(fn, *args: Any) -> Any:
        try:
            return fn(*args)
        except MailError as e:
            raise ToolError(str(e)) from None

    @server.tool(description="List the connected email accounts.")
    def list_accounts() -> str:
        return json.dumps(mail.list_accounts())

    @server.tool(description="List the folders of an account, with the special folders (inbox, sent, trash, ...).")
    def list_folders(account: str | None = None) -> str:
        return json.dumps(run(mail.list_folders, account), ensure_ascii=False, indent=1)

    @server.tool(description=(
        "Search the messages of a folder, newest first. All the given fields must match. 'since' and 'before' "
        "are dates as YYYY-MM-DD. 'gmail_query' takes Gmail search syntax (Gmail accounts only). Returns the "
        "uid, from, to, subject, date, unread, and flagged of each message."))
    def search_messages(account: str | None = None, folder: str = "INBOX", text: str | None = None,
                        sender: str | None = None, subject: str | None = None, since: str | None = None,
                        before: str | None = None, unread_only: bool = False, gmail_query: str | None = None,
                        limit: int = 20) -> str:
        return json.dumps(run(mail.search, account, folder, text, sender, subject, since, before, unread_only,
                              gmail_query, limit), ensure_ascii=False, indent=1)

    @server.tool(description="Read one message: the headers, the text, and the names of its attachments. It does not mark the message as read.")
    def read_message(uid: int, folder: str = "INBOX", account: str | None = None) -> str:
        return json.dumps(run(mail.read, account, folder, uid), ensure_ascii=False, indent=1)

    if not mail.read_only:
        @server.tool(description="Send a message. To reply, give reply_to_uid (and its folder): the reply joins the thread.")
        def send_message(to: list[str], subject: str, body: str, cc: list[str] | None = None,
                         bcc: list[str] | None = None, account: str | None = None, reply_to_uid: int | None = None,
                         folder: str = "INBOX") -> str:
            return run(mail.send, account, to, subject, body, cc, bcc, reply_to_uid, folder)

        @server.tool(description="Mark a message as read or unread, and flagged or not flagged.")
        def mark_message(uid: int, folder: str = "INBOX", read: bool | None = None, flagged: bool | None = None,
                         account: str | None = None) -> str:
            return run(mail.mark, account, folder, uid, read, flagged)

        @server.tool(description="Move a message to another folder.")
        def move_message(uid: int, to_folder: str, folder: str = "INBOX", account: str | None = None) -> str:
            return run(mail.move, account, folder, uid, to_folder)

        @server.tool(description="Move a message to the trash folder of the account.")
        def delete_message(uid: int, folder: str = "INBOX", account: str | None = None) -> str:
            return run(mail.delete, account, folder, uid)

    return server


def main() -> None:
    build_server(Mail.from_env()).run("stdio")


if __name__ == "__main__":
    main()
