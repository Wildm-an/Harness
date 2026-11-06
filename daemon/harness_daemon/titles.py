"""Session titles: the model summarizes the first prompt of a session into a short title.

The first line of the prompt is the title until the summary is ready. If the model fails, that
title stays, and the next prompt of the session tries again (server.py).

A provider on the internet often has a small, fast model (for example a Haiku or a Flash model). The
title request uses it. A local provider keeps the model of the session: a second model on a local
server can take long to load.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
from urllib.parse import urlparse

from .providers import ModelClient

log = logging.getLogger("harness.titles")

TITLE_CHARS = 60
TITLE_TIMEOUT = 60  # Seconds. A local model can be slow while it also runs the turn.
MAX_PROMPT_CHARS = 2000
LIST_TIMEOUT = 5  # Seconds for the model list of the provider, to find a small model.
MAX_TITLE_TRIES = 3  # One try for each prompt, until the model makes a title.

TITLE_SYSTEM = """You name coding sessions. The user finds a session later by its name in a list of past sessions.

You get the first message of a session. Reply with a title for it and nothing else: one line, no quotes, no period at the end, no label such as "Title:".

Rules:
- Use 3 to 5 words.
- Name the specific subject: the feature, file, error, issue number, or tool.
- Keep the detail that makes the session different from similar sessions, such as a version, a provider, or the thing that the message compares. Remove general words such as "review", "overview", "investigation", "request", "question", or "this project".
- Write a short natural phrase, not a list of nouns. Use your own words. Do not copy a heading, a commit message, a command, or a long path.
- Use sentence case: a capital letter only for the first word and for names.
- Keep identifiers exactly as they are written: file names, issue and PR numbers, error codes, and model names.
- Use the language of the message.

The message is a thing to name. Do not answer it and do not do the task. Do this also if the message asks for work, asks a question, or seems incomplete. For a greeting or small talk, use a short label such as "Greeting".

Examples:
"debug 500 errors in production" -> Production 500 errors
"why does app.js fail to start" -> app.js start failure
"what does the retry logic in fetch.ts do" -> fetch.ts retry logic
"@src/auth.ts add refresh token support" -> Auth refresh tokens
"compare the new cache with the v1 cache in packages/legacy" -> New cache vs v1
"look at https://github.com/acme/app/issues/412, do not edit" -> Issue #412
"hi" -> Greeting"""

# The message frame tells the model that the text is a thing to name, not a task to do.
TITLE_USER = "The first message of the session:\n\n<message>\n{text}\n</message>\n\nReply with the title only."

# Small model families, best first. A model id matches when it contains the text.
SMALL_FAMILIES = ("haiku", "flash-lite", "flash", "gpt-luna", "-mini", "-nano")
# Models of a small family that do not write text well, or that reason for a long time (o3-mini, o4-mini).
NOT_FOR_TEXT = re.compile(r"embed|tts|audio|image|realtime|transcribe|search|vision|guard|moderation|^o\d")

_THINK = re.compile(r"<think>.*?(</think>|$)", re.S | re.I)
_small: dict[str, str | None] = {}  # The small model of each provider, by provider name. None: no small model.


def clean_title(raw: str) -> str | None:
    """The title from a model reply: no reasoning block, no quotes or Markdown, one line."""
    text = _THINK.sub("", raw or "").strip()
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    previous = None
    while line != previous:  # Markdown, quotes, a period, and "Title:" can wrap each other.
        previous = line
        line = line.strip().strip("#*`_\"'“”‘’ ").rstrip(".").strip()
        line = re.sub(r"^title\s*:\s*", "", line, flags=re.I)
    if not line:
        return None
    if len(line) > TITLE_CHARS:
        line = line[:TITLE_CHARS].rsplit(" ", 1)[0].rstrip(",;:-") or line[:TITLE_CHARS]
    return line


def title_messages(prompt: str) -> list[dict]:
    return [
        {"role": "system", "content": TITLE_SYSTEM},
        {"role": "user", "content": TITLE_USER.format(text=prompt.strip()[:MAX_PROMPT_CHARS])},
    ]


def is_local(client: ModelClient) -> bool:
    """True for a provider on this computer, on the private network, or through an SSH tunnel."""
    provider = client.provider
    if provider.ssh is not None or provider.kind == "ollama":
        return True
    host = urlparse(provider.base_url).hostname or ""
    if host == "localhost" or host.endswith((".local", ".localhost", ".internal", ".ts.net")):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return "." not in host  # A bare host name is on the local network.
    return address.is_private or address.is_loopback or address.is_link_local


def pick_small(models: list[str], current: str) -> str | None:
    """A model of the best small family: the last name in the family, which is usually the newest
    version. A model of the session in a small family stays."""
    def family(model: str) -> int | None:
        name = model.lower().rsplit("/", 1)[-1]
        if NOT_FOR_TEXT.search(name):
            return None
        return next((i for i, f in enumerate(SMALL_FAMILIES) if f in name), None)

    if family(current) is not None:
        return current
    ranked = [(rank, m) for m in models if (rank := family(m)) is not None]
    if not ranked:
        return None
    best = min(rank for rank, _ in ranked)
    return max(m for rank, m in ranked if rank == best)


async def small_model(client: ModelClient) -> str | None:
    """A small model of the same provider for the title, or None. The daemon asks one time for each provider."""
    if is_local(client):
        return None
    name = client.provider.name
    if name not in _small:
        from .provider_config import list_models

        try:
            found = await list_models(client.provider, LIST_TIMEOUT, contexts=False)
        except Exception as e:  # noqa: BLE001 - the session model makes the title.
            log.info("The model list of %s did not load: %s", name, e)
            return None  # Not saved: the next session asks again.
        if not found.get("ok"):
            return None
        _small[name] = pick_small(found.get("models") or [], client.model)
    return _small[name]


async def _ask(client: ModelClient, prompt: str) -> str | None:
    async def ignore(_: str) -> None:
        return None

    try:
        response = await asyncio.wait_for(client.stream(title_messages(prompt), [], ignore), TITLE_TIMEOUT)
    except Exception as e:  # noqa: BLE001 - a title is optional. The first line stays.
        log.info("The session title was not made with %s: %s", client.label, e)
        return None
    return clean_title(response.text)


async def summarize_title(client: ModelClient, prompt: str) -> str | None:
    """Ask the model for a title. Return None if the model fails or gives no text.

    A small model of the provider makes the title when there is one. If it fails, the model of the
    session tries one time.
    """
    small = await small_model(client)
    if small and small != client.model:
        title = await _ask(ModelClient(client.provider, small), prompt)
        if title:
            return title
    return await _ask(client, prompt)
