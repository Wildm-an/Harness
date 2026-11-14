"""Remove the external-content tags (tools/base.py external) from a tool result, for tests that compare the text."""

from __future__ import annotations

import re

_OPEN = re.compile(r'<external-content-[0-9a-f]{8} source="[^"]*">\n')
_CLOSE = re.compile(r"\n</external-content-[0-9a-f]{8}>")


def untag(text: str) -> str:
    return _CLOSE.sub("", _OPEN.sub("", text))
