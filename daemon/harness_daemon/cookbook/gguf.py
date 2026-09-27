"""Read the model shape from the header of a GGUF file, with HTTP range requests.

The fit calculator needs the layer count, the KV head count, and the head size. They are
key-value pairs at the start of the file. The daemon reads only the first megabytes: it stops
at the tokenizer keys, which come after the model keys.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Any

import httpx

MAGIC = b"GGUF"
FIRST_READ = 512 * 1024
MAX_READ = 32 * 1024 * 1024

# Value types of the GGUF format.
_SCALARS = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
STRING, ARRAY = 8, 9


class NeedMore(Exception):
    """The buffer ends before the value. Read more bytes."""


class GgufError(Exception):
    pass


@dataclass
class ModelShape:
    architecture: str
    layers: int
    heads: int
    kv_heads: int
    embedding: int
    key_length: int | None = None
    value_length: int | None = None
    context_length: int | None = None

    @property
    def head_dim(self) -> int:
        return self.key_length or (self.embedding // self.heads if self.heads else 0)

    def kv_bytes_per_token(self, bytes_per_value: int = 2) -> int:
        """KV cache bytes for one token: 2 (K and V) × layers × kv_heads × head_dim × bytes_per_value."""
        key = self.key_length or self.head_dim
        value = self.value_length or self.head_dim
        return self.layers * self.kv_heads * (key + value) * bytes_per_value

    def to_json(self) -> dict[str, Any]:
        return {"architecture": self.architecture, "layers": self.layers, "heads": self.heads,
                "kv_heads": self.kv_heads, "embedding": self.embedding, "head_dim": self.head_dim,
                "context_length": self.context_length}


class _Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def take(self, n: int) -> bytes:
        if self.pos + n > len(self.data):
            raise NeedMore()
        chunk = self.data[self.pos:self.pos + n]
        self.pos += n
        return chunk

    def scalar(self, fmt: str) -> Any:
        return struct.unpack(fmt, self.take(struct.calcsize(fmt)))[0]

    def string(self) -> str:
        return self.take(self.scalar("<Q")).decode("utf-8", errors="replace")

    def value(self, kind: int, keep: bool) -> Any:
        if kind in _SCALARS:
            return self.scalar(_SCALARS[kind])
        if kind == STRING:
            return self.string()
        if kind == ARRAY:
            item_kind = self.scalar("<I")
            count = self.scalar("<Q")
            if item_kind in _SCALARS:
                size = struct.calcsize(_SCALARS[item_kind])
                raw = self.take(size * count)
                return list(struct.unpack(f"<{count}{_SCALARS[item_kind][1]}", raw)) if keep else None
            items = [self.value(item_kind, keep) for _ in range(count)]
            return items if keep else None
        raise GgufError(f"Unknown GGUF value type {kind}.")


def parse_metadata(data: bytes) -> dict[str, Any]:
    """The key-value pairs before the tokenizer keys. Raises NeedMore if ``data`` is too short."""
    r = _Reader(data)
    if r.take(4) != MAGIC:
        raise GgufError("The file is not a GGUF file.")
    version = r.scalar("<I")
    count_fmt = "<I" if version == 1 else "<Q"
    r.scalar(count_fmt)  # The tensor count.
    kv_count = r.scalar(count_fmt)
    found: dict[str, Any] = {}
    for _ in range(kv_count):
        key = r.string()
        if key.startswith("tokenizer."):
            break  # The model keys come first. The tokenizer arrays are large.
        kind = r.scalar("<I")
        found[key] = r.value(kind, keep=kind != ARRAY)
    return found


def shape_from_metadata(meta: dict[str, Any]) -> ModelShape:
    arch = str(meta.get("general.architecture") or "")
    if not arch:
        raise GgufError("The GGUF file has no general.architecture key.")

    def get(name: str) -> Any:
        value = meta.get(f"{arch}.{name}")
        return value[0] if isinstance(value, list) and value else value  # Some models have one value per layer.

    layers, heads = get("block_count"), get("attention.head_count")
    if not layers or not heads:
        raise GgufError(f"The GGUF file has no layer or head count for the architecture {arch}.")
    return ModelShape(
        architecture=arch,
        layers=int(layers),
        heads=int(heads),
        kv_heads=int(get("attention.head_count_kv") or heads),
        embedding=int(get("embedding_length") or 0),
        key_length=int(get("attention.key_length")) if get("attention.key_length") else None,
        value_length=int(get("attention.value_length")) if get("attention.value_length") else None,
        context_length=int(get("context_length")) if get("context_length") else None,
    )


async def fetch_shape(url: str, token: str | None = None) -> ModelShape:
    """Read the header of a remote GGUF file. Reads more bytes until the model keys are complete."""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    size = FIRST_READ
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        while True:
            response = await client.get(url, headers={**headers, "Range": f"bytes=0-{size - 1}"})
            if response.status_code in (401, 403):
                raise GgufError("No access to the file. The model can be gated: accept its license on Hugging Face.")
            if response.status_code not in (200, 206):
                raise GgufError(f"HTTP {response.status_code} for the GGUF header.")
            try:
                return shape_from_metadata(parse_metadata(response.content))
            except NeedMore:
                if size >= MAX_READ or len(response.content) < size:
                    raise GgufError("The GGUF header is larger than expected.") from None
                size *= 4


def read_local_shape(path: str) -> ModelShape:
    """Read the header of a GGUF file on disk."""
    size = FIRST_READ
    with open(path, "rb") as f:
        while True:
            f.seek(0)
            data = f.read(size)
            try:
                return shape_from_metadata(parse_metadata(data))
            except NeedMore:
                if size >= MAX_READ or len(data) < size:
                    raise GgufError("The GGUF header is larger than expected.") from None
                size *= 4
