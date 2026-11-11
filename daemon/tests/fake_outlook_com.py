"""A small fake of the Outlook object model (COM), for the tests of outlook_server.py.

It has only the members that outlook_server.py uses. Restrict understands the DASL filters of the server:
unread, and LIKE on the subject, the body, and the sender. ``python fake_outlook_com.py [--check]`` runs the
built-in server with a fake mailbox, in place of ``harness-daemon --mcp-server outlook``.
"""

from __future__ import annotations

import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


class Collection(list):
    @property
    def Count(self) -> int:
        return len(self)


class ComError(Exception):
    """As pywintypes.com_error: (hresult, text, excepinfo, argerr)."""

    def __init__(self, hresult: int, text: str, description: str | None = None):
        super().__init__(hresult, text, (0, "Outlook", description, None, 0, hresult) if description else None, None)
        self.hresult = hresult


class Items:
    def __init__(self, items: list[Any]):
        self._items = list(items)
        self._index = 0
        self.IncludeRecurrences = False

    @property
    def Count(self) -> int:
        return len(self._items)

    def __iter__(self):
        return iter(self._items)

    def Restrict(self, query: str) -> "Items":
        RESTRICTS.append(query)
        items = self._items
        if '"urn:schemas:httpmail:read" = 0' in query:
            items = [i for i in items if i.UnRead]
        text = re.search(r"\"urn:schemas:httpmail:subject\" LIKE '%(.*?)%'", query)
        if text:
            term = text.group(1).replace("''", "'").lower()
            items = [i for i in items if term in i.Subject.lower() or term in i.Body.lower()]
        sender = re.search(r"\"urn:schemas:httpmail:fromname\" LIKE '%(.*?)%'", query)
        if sender:
            term = sender.group(1).replace("''", "'").lower()
            items = [i for i in items if term in i.SenderName.lower() or term in i.SenderEmailAddress.lower()]
        return Items(items)

    def Sort(self, key: str, descending: bool = False) -> None:
        name = key.strip("[]")
        self._items.sort(key=lambda i: getattr(i, name), reverse=descending)

    def GetFirst(self) -> Any:
        self._index = 0
        return self.GetNext()

    def GetNext(self) -> Any:
        if self._index >= len(self._items):
            return None
        self._index += 1
        return self._items[self._index - 1]


class Folders(Collection):
    def __init__(self, owner: "Folder"):
        super().__init__()
        self._owner = owner

    def Add(self, name: str) -> "Folder":
        if any(f.Name.lower() == name.lower() for f in self):
            raise ComError(-2147352567, "Exception occurred.", "Cannot create the folder.")
        return Folder(name, self._owner)


class Folder:
    _count = 0

    def __init__(self, name: str, parent: "Folder | None" = None):
        Folder._count += 1
        self.Name = name
        self.Parent = parent
        self.EntryID = f"folder-{Folder._count}-{name}"
        self.Folders = Folders(self)
        self._items: list[Any] = []
        if parent is not None:
            parent.Folders.append(self)

    def MoveTo(self, target: "Folder") -> None:
        self.Parent.Folders.remove(self)
        target.Folders.append(self)
        self.Parent = target

    @property
    def Items(self) -> Items:
        return Items(self._items)

    @property
    def UnReadItemCount(self) -> int:
        return sum(1 for i in self._items if getattr(i, "UnRead", False))

    def add(self, item: Any) -> Any:
        item.Parent = self
        self._items.append(item)
        return item


class Recipient:
    def __init__(self, name: str, address: str, kind: int):
        self.Name, self.Address, self.Type = name, address, kind
        self.AddressEntry = self

    def GetExchangeUser(self) -> None:
        return None


class Attachment:
    def __init__(self, name: str):
        self.FileName = name


class Mail:
    Class = 43
    _count = 0

    def __init__(self, outlook: "App", subject: str = "", sender: str = "", address: str = "", body: str = "",
                 received: datetime | None = None, unread: bool = False, to: list[tuple[str, str]] | None = None,
                 attachments: list[str] | None = None):
        Mail._count += 1
        self._outlook = outlook
        self.EntryID = f"mail-{Mail._count}"
        self.Subject, self.SenderName, self.SenderEmailAddress = subject, sender, address
        self.SenderEmailType = "SMTP"
        self.Body = body
        self.HTMLBody = f"<html><body><p>{body}</p></body></html>"
        self.ReceivedTime = received or datetime(2026, 11, 1, 9, 0)
        self.SentOn = self.ReceivedTime
        self.UnRead = unread
        self.Attachments = Collection(Attachment(a) for a in attachments or [])
        self.Recipients = Collection(Recipient(n, a, 1) for n, a in to or [])
        self.To, self.CC = "", ""
        self.Parent: Folder | None = None
        self.sent = False
        outlook.items[self.EntryID] = self

    def Save(self) -> None:
        if self.Parent is None:
            self._outlook.drafts.add(self)

    def Reply(self) -> "Mail":
        reply = Mail(self._outlook, subject=f"RE: {self.Subject}", body="")
        reply.HTMLBody = f"<html><body><p>Signature</p><p>{self.Body}</p></body></html>"
        reply.To = self.SenderEmailAddress
        return reply

    def ReplyAll(self) -> "Mail":
        reply = self.Reply()
        reply.CC = "; ".join(r.Address for r in self.Recipients)
        return reply

    def Send(self) -> None:
        self.sent = True
        self._outlook.sent.add(self)

    def Move(self, target: Folder) -> "Mail":
        """As Outlook: the moved message gets a new EntryID, and the old one stops working."""
        self.Parent._items.remove(self)
        del self._outlook.items[self.EntryID]
        Mail._count += 1
        self.EntryID = f"mail-{Mail._count}"
        self._outlook.items[self.EntryID] = self
        target.add(self)
        return self


class Event:
    def __init__(self, subject: str, start: datetime, end: datetime):
        self.EntryID = f"event-{subject}"
        self.Subject, self.Start, self.End = subject, start, end
        self.AllDayEvent, self.Location, self.Organizer = False, "Room 1", "Pat"
        self.RequiredAttendees, self.IsRecurring = "Pat; Bob", False


class Account:
    def __init__(self, address: str):
        self.SmtpAddress, self.DisplayName = address, address


class Namespace:
    def __init__(self, outlook: "App"):
        self._outlook = outlook
        self.Folders = Collection([outlook.root, outlook.shared])
        self.Accounts = Collection([Account("pat@example.com")])

    def GetDefaultFolder(self, number: int) -> Folder:
        folders = {6: self._outlook.inbox, 16: self._outlook.drafts, 5: self._outlook.sent, 9: self._outlook.calendar}
        return folders[number]

    def GetItemFromID(self, entry_id: str) -> Any:
        if self._outlook.fail_next is not None:
            error, self._outlook.fail_next = self._outlook.fail_next, None
            raise error
        try:
            return self._outlook.items[entry_id]
        except KeyError:
            raise ComError(-2147221233, "Exception occurred.", "The operation failed. An object could not be found.") from None


class App:
    """The Outlook.Application object, with a mailbox: Inbox (and Inbox/Projects), Drafts, Sent Items, Calendar,
    and a second mailbox "Shared"."""

    def __init__(self) -> None:
        self.items: dict[str, Any] = {}
        self.fail_next: Exception | None = None
        self.root = Folder("pat@example.com")
        self.inbox = Folder("Inbox", self.root)
        self.projects = Folder("Projects", self.inbox)
        self.drafts = Folder("Drafts", self.root)
        self.sent = Folder("Sent Items", self.root)
        self.calendar = Folder("Calendar", self.root)
        self.shared = Folder("Shared")
        Folder("Inbox", self.shared)
        self.inbox.add(Mail(self, "Old news", "Ann", "ann@example.com", "Nothing new.", datetime(2026, 11, 1, 8, 0)))
        self.inbox.add(Mail(self, "Invoice 42", "Bob", "bob@shop.example", "Pay by Friday.",
                            datetime(2026, 11, 3, 9, 0), unread=True, to=[("Pat", "pat@example.com")],
                            attachments=["invoice.pdf"]))
        self.inbox.add(Mail(self, "Bob's plan", "Cy", "cy@example.com", "See the plan.", datetime(2026, 11, 2, 9, 0)))
        self.projects.add(Mail(self, "Kickoff", "Dee", "dee@example.com", "Monday.", datetime(2026, 11, 4, 9, 0)))
        self.calendar.add(Event("Standup", datetime(2026, 11, 10, 9, 0), datetime(2026, 11, 10, 9, 15)))

    def GetNamespace(self, name: str) -> Namespace:
        assert name == "MAPI"
        return Namespace(self)

    def CreateItem(self, kind: int) -> Mail:
        assert kind == 0
        return Mail(self)


RESTRICTS: list[str] = []


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from harness_daemon import outlook_server

    app = App()
    if "--check" in sys.argv:
        import json

        print(json.dumps(outlook_server.check(outlook_server.Outlook(lambda: app, lambda: None))), flush=True)
        sys.exit(0)
    outlook_server.build_server(outlook_server.Outlook(lambda: app, lambda: None),
                                outlook_server.mode_from_env()).run("stdio")
