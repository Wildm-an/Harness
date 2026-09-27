"""The fit calculator (SPEC.md section 7.2).

- Weights: the file size of the GGUF (all parts of a split file).
- KV cache: 2 × layers × kv_heads × head_dim × context × bytes_per_value (f16: 2 bytes).
- Total: (weights + KV cache) + 10% overhead.

Results: ``fits`` (in VRAM), ``offload`` (VRAM and system RAM together), or ``no`` (does not fit).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .gguf import ModelShape

OVERHEAD = 1.10
RECOMMEND_CONTEXT = 16384
RAM_SHARE = 0.8  # The share of the system RAM that a model can use with CPU offload.
# Bits for each weight of common quants, for an estimate from the parameter count.
ESTIMATE_BITS = 4.85  # Q4_K_M.
# KV cache bytes for each token and each billion parameters: an estimate for a model with no header.
ESTIMATE_KV_PER_TOKEN_PER_B = 12_000

QUANT_RE = re.compile(r"(?:^|[-_.])((?:UD-)?I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|FP16|F32|MXFP4)(?=[-_.]|$)", re.I)
SPLIT_RE = re.compile(r"-(\d{5})-of-(\d{5})(?=\.gguf$)", re.I)


@dataclass
class Hardware:
    vram: int  # Bytes, all GPUs together.
    ram: int  # Bytes.

    @classmethod
    def from_json(cls, data: dict[str, Any] | None) -> "Hardware | None":
        if not data:
            return None
        vram = sum(int(g.get("vram_total") or 0) for g in data.get("gpus") or [])
        return cls(vram=vram, ram=int(data.get("ram_total") or 0))


def quant_of(filename: str) -> str | None:
    """The quant type from the file name, or from its folder (for example "Q4_K_M/model-00001-of-00002.gguf")."""
    parts = SPLIT_RE.sub("", filename).removesuffix(".gguf").split("/")
    for part in reversed(parts):
        matches = QUANT_RE.findall(part)
        if matches:
            return matches[-1].upper()
    return None


def split_key(filename: str) -> tuple[str, int, int] | None:
    """(the name without the part number, part, count) for a split GGUF file."""
    match = SPLIT_RE.search(filename)
    if not match:
        return None
    return SPLIT_RE.sub("", filename), int(match.group(1)), int(match.group(2))


def total_bytes(weights: int, kv: int) -> int:
    return int((weights + kv) * OVERHEAD)


def classify(total: int, hw: Hardware) -> str:
    if hw.vram and total <= hw.vram:
        return "fits"
    if total <= hw.vram + hw.ram * RAM_SHARE:
        return "offload"
    return "no"


def fit(weights: int, shape: ModelShape | None, hw: Hardware, context: int = RECOMMEND_CONTEXT,
        params: int | None = None) -> dict[str, Any]:
    """The fit of one file at one context size. With no shape, the KV cache is an estimate."""
    per_token = shape.kv_bytes_per_token() if shape else int((params or 0) / 1e9 * ESTIMATE_KV_PER_TOKEN_PER_B)
    kv = per_token * context
    total = total_bytes(weights, kv)
    result: dict[str, Any] = {
        "result": classify(total, hw),
        "context": context,
        "weights": weights,
        "kv_cache": kv,
        "total": total,
        "estimate": shape is None,
    }
    # The maximum context that fits in VRAM.
    free = hw.vram / OVERHEAD - weights
    max_context = int(free // per_token) if per_token and free > 0 else 0
    if shape and shape.context_length:
        max_context = min(max_context, shape.context_length)
    result["max_context_vram"] = max_context
    if shape:
        result["gpu_layers"] = gpu_layers(weights, kv, shape.layers, hw)
    return result


def gpu_layers(weights: int, kv: int, layers: int, hw: Hardware) -> int:
    """The number of layers for the GPU (llama-server -ngl). All layers if the model fits."""
    total = total_bytes(weights, kv)
    if hw.vram and total <= hw.vram:
        return layers
    per_layer = total / max(layers, 1)
    return max(0, min(layers, int(hw.vram // per_layer))) if per_layer else 0


def estimate_badge(params: int | None, hw: Hardware | None) -> dict[str, Any] | None:
    """A fit badge for the model list, from the parameter count: a Q4_K_M file with a 16K context."""
    if not params or hw is None:
        return None
    weights = int(params * ESTIMATE_BITS / 8)
    return fit(weights, None, hw, RECOMMEND_CONTEXT, params)


def recommend(groups: list[dict[str, Any]]) -> str | None:
    """The largest quant that fits in VRAM with a 16K context."""
    fitting = [g for g in groups if g.get("fit") and g["fit"]["result"] == "fits"]
    return max(fitting, key=lambda g: g["size"])["name"] if fitting else None
