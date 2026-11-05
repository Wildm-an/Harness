"""Fake IMAP and SMTP servers for the Email connector tests (no TLS, on 127.0.0.1).

They speak enough of IMAP4rev1 and of ESMTP for imaplib and smtplib: CAPABILITY, LOGIN, LIST, SELECT,
EXAMINE, UID SEARCH (with a literal), UID FETCH, UID STORE, UID MOVE, LOGOUT; EHLO, AUTH PLAIN, MAIL, RCPT,
DATA, QUIT. One user and one password. The mailboxes are in memory.
"""

from __future__ import annotations

import base64
import re
import socketserver
import threading
from dataclasses import dataclass, field
from email import message_from_bytes, policy
from email.utils import parsedate_to_datetime
from datetime import datetime


@dataclass
class Stored:
    uid: int
    raw: bytes
    flags: set[str] = field(default_factory=set)


class MailStore:
    def __init__(self, user: str, password: str):
        self.user = user
        self.password = password
        self.folders: dict[str, list[Stored]] = {"INBOX": [], "Sent": [], "Trash": [], "Entw&APw-rfe": []}
        self.special = {"Sent": "\\Sent", "Trash": "\\Trash"}
        self.next_uid = 1
        self.sent: list[tuple[str, list[str], bytes]] = []
        self.lock = threading.Lock()

    def add(self, folder: str, raw: bytes, flags: set[str] | None = None) -> int:
        with self.lock:
            uid = self.next_uid
            self.next_uid += 1
            self.folders[folder].append(Stored(uid, raw, set(flags or ())))
            return uid


def tokens(line: str) -> list[str]:
    """The arguments of an IMAP command: atoms, quoted strings, and parenthesized lists as one token."""
    out, i = [], 0
    while i < len(line):
        ch = line[i]
        if ch == " ":
            i += 1
        elif ch == '"':
            j, value = i + 1, ""
            while line[j] != '"':
                if line[j] == "\\":
                    j += 1
                value += line[j]
                j += 1
            out.append(value)
            i = j + 1
        elif ch == "(":
            depth, j = 0, i
            while True:
                depth += line[j] == "("
                depth -= line[j] == ")"
                j += 1
                if depth == 0:
                    break
            out.append(line[i:j])
            i = j
        else:
            j = line.find(" ", i)
            j = len(line) if j < 0 else j
            out.append(line[i:j])
            i = j
    return out


class ImapHandler(socketserver.StreamRequestHandler):
    store: MailStore

    def send(self, text: str | bytes) -> None:
        self.wfile.write(text.encode() if isinstance(text, str) else text)

    def read_line(self) -> str | None:
        line = self.rfile.readline()
        if not line:
            return None
        text = line.decode("utf-8", "replace").rstrip("\r\n")
        literal = re.search(r"\{(\d+)\}$", text)
        if literal:  # A literal: ask for it, then read it and the rest of the line.
            self.send("+ go ahead\r\n")
            data = self.rfile.read(int(literal.group(1))).decode("utf-8")
            rest = self.rfile.readline().decode().rstrip("\r\n")
            text = text[:literal.start()] + '"' + data.replace('"', '\\"') + '"' + rest
        return text

    def handle(self) -> None:
        self.send("* OK [CAPABILITY IMAP4rev1 MOVE UIDPLUS] fake ready\r\n")
        selected: str | None = None
        authed = False
        while True:
            line = self.read_line()
            if line is None:
                return
            tag, _, rest = line.partition(" ")
            command, _, args = rest.partition(" ")
            command = command.upper()
            if command == "UID":
                command, _, args = args.partition(" ")
                command = "UID " + command.upper()
            if command == "CAPABILITY":
                self.send(f"* CAPABILITY IMAP4rev1 MOVE UIDPLUS\r\n{tag} OK done\r\n")
            elif command == "LOGIN":
                user, password = tokens(args)[:2]
                authed = (user, password) == (self.store.user, self.store.password)
                self.send(f"{tag} OK logged in\r\n" if authed else f"{tag} NO [AUTHENTICATIONFAILED] bad login\r\n")
            elif command == "LOGOUT":
                self.send(f"* BYE bye\r\n{tag} OK done\r\n")
                return
            elif command == "NOOP":
                self.send(f"{tag} OK done\r\n")
            elif not authed:
                self.send(f"{tag} NO not logged in\r\n")
            elif command == "LIST":
                for name in self.store.folders:
                    flags = " ".join(filter(None, ["\\HasNoChildren", self.store.special.get(name)]))
                    self.send(f'* LIST ({flags}) "/" "{name}"\r\n')
                self.send(f"{tag} OK done\r\n")
            elif command in ("SELECT", "EXAMINE"):
                name = tokens(args)[0]
                if name not in self.store.folders:
                    self.send(f"{tag} NO no such folder\r\n")
                    continue
                selected = name
                mode = "READ-ONLY" if command == "EXAMINE" else "READ-WRITE"
                self.send(f"* {len(self.store.folders[name])} EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n{tag} OK [{mode}] done\r\n")
            elif selected is None:
                self.send(f"{tag} NO select first\r\n")
            elif command == "UID SEARCH":
                found = [m.uid for m in self.store.folders[selected] if self.matches(m, tokens(args))]
                self.send(f"* SEARCH {' '.join(map(str, found))}\r\n{tag} OK done\r\n".replace("SEARCH \r\n", "SEARCH\r\n"))
            elif command == "UID FETCH":
                uid_set, items = args.split(" ", 1)
                wanted = {int(u) for u in uid_set.split(",")}
                for index, m in enumerate(self.store.folders[selected], 1):
                    if m.uid not in wanted:
                        continue
                    flags = " ".join(sorted(m.flags))
                    if "HEADER.FIELDS" in items:
                        head = m.raw.split(b"\r\n\r\n", 1)[0] + b"\r\n\r\n"
                        section = "BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)]"
                    else:
                        head, section = m.raw, "BODY[]"
                    self.send(f"* {index} FETCH (UID {m.uid} FLAGS ({flags}) RFC822.SIZE {len(m.raw)} {section} {{{len(head)}}}\r\n")
                    self.send(head)
                    self.send(")\r\n")
                self.send(f"{tag} OK done\r\n")
            elif command == "UID STORE":
                uid, mode, flags = args.split(" ", 2)
                names = set(flags.strip("()").split())
                for m in self.store.folders[selected]:
                    if m.uid == int(uid):
                        m.flags = m.flags | names if mode.startswith("+") else m.flags - names
                self.send(f"{tag} OK done\r\n")
            elif command == "UID MOVE":
                uid, target = args.split(" ", 1)
                target = tokens(target)[0]
                if target not in self.store.folders:
                    self.send(f"{tag} NO no such folder\r\n")
                    continue
                with self.store.lock:
                    keep, moved = [], []
                    for m in self.store.folders[selected]:
                        (moved if m.uid == int(uid) else keep).append(m)
                    self.store.folders[selected] = keep
                    self.store.folders[target].extend(moved)
                self.send(f"{tag} OK moved\r\n")
            else:
                self.send(f"{tag} BAD unknown command {command}\r\n")

    @staticmethod
    def matches(m: Stored, criteria: list[str]) -> bool:
        message = message_from_bytes(m.raw, policy=policy.default)
        text = m.raw.decode("utf-8", "replace").lower()
        i = 0
        while i < len(criteria):
            key = criteria[i].upper()
            if key == "CHARSET":
                i += 2
                continue
            if key == "ALL":
                i += 1
                continue
            if key == "UNSEEN":
                if "\\Seen" in m.flags:
                    return False
                i += 1
                continue
            value = criteria[i + 1]
            if key == "FROM" and value.lower() not in str(message.get("From", "")).lower():
                return False
            if key == "SUBJECT" and value.lower() not in str(message.get("Subject", "")).lower():
                return False
            if key in ("TEXT", "X-GM-RAW") and value.lower() not in text:
                return False
            if key in ("SINCE", "BEFORE"):
                day = datetime.strptime(value, "%d-%b-%Y").date()
                sent = parsedate_to_datetime(str(message.get("Date"))).date()
                if (key == "SINCE" and sent < day) or (key == "BEFORE" and sent >= day):
                    return False
            i += 2
        return True


class SmtpHandler(socketserver.StreamRequestHandler):
    store: MailStore

    def handle(self) -> None:
        w = self.wfile
        w.write(b"220 fake ESMTP\r\n")
        sender, recipients, authed = "", [], False
        while True:
            line = self.rfile.readline()
            if not line:
                return
            text = line.decode().rstrip("\r\n")
            upper = text.upper()
            if upper.startswith(("EHLO", "HELO")):
                w.write(b"250-fake\r\n250-AUTH PLAIN\r\n250 OK\r\n")
            elif upper.startswith("AUTH PLAIN"):
                parts = base64.b64decode(text.split()[2]).split(b"\0")
                password = getattr(self.store, "smtp_password", None) or self.store.password
                authed = (parts[1].decode(), parts[2].decode()) == (self.store.user, password)
                w.write(b"235 ok\r\n" if authed else b"535 bad login\r\n")
            elif not authed and upper.startswith(("MAIL", "RCPT", "DATA")):
                w.write(b"530 auth first\r\n")
            elif upper.startswith("MAIL FROM:"):
                sender, recipients = re.search(r"<([^>]*)>", text).group(1), []
                w.write(b"250 ok\r\n")
            elif upper.startswith("RCPT TO:"):
                recipients.append(re.search(r"<([^>]*)>", text).group(1))
                w.write(b"250 ok\r\n")
            elif upper == "DATA":
                w.write(b"354 go\r\n")
                data = b""
                while True:
                    chunk = self.rfile.readline()
                    if chunk in (b".\r\n", b""):
                        break
                    data += chunk
                self.store.sent.append((sender, recipients, data))
                w.write(b"250 queued\r\n")
            elif upper in ("QUIT",):
                w.write(b"221 bye\r\n")
                return
            else:
                w.write(b"250 ok\r\n")


class _Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def start(store: MailStore) -> tuple[_Server, _Server]:
    """Start the two servers on free ports of 127.0.0.1. Return them (server_address has the port)."""
    imap = _Server(("127.0.0.1", 0), type("H", (ImapHandler,), {"store": store}))
    smtp = _Server(("127.0.0.1", 0), type("S", (SmtpHandler,), {"store": store}))
    for server in (imap, smtp):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    return imap, smtp


def message(subject: str, sender: str = "Ann <ann@example.com>", to: str = "pat@example.com",
            text: str = "Hello", date: str = "Tue, 03 Nov 2026 10:00:00 +0000", html: str | None = None) -> bytes:
    body = (f"Content-Type: text/html; charset=utf-8\r\n\r\n{html}" if html is not None
            else f"Content-Type: text/plain; charset=utf-8\r\n\r\n{text}")
    return (f"From: {sender}\r\nTo: {to}\r\nSubject: {subject}\r\nDate: {date}\r\n"
            f"Message-ID: <{abs(hash(subject))}@example.com>\r\nMIME-Version: 1.0\r\n{body}\r\n").encode("utf-8")
