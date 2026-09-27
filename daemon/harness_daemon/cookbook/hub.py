"""The Hugging Face model browser (SPEC.md section 7.3), with the ``HfApi`` class of ``huggingface_hub``.

- Search results stay in a cache for 10 minutes. Model details stay for 1 hour.
- The browser works with no token for public models. A token (from the keychain of the
  client, in memory only) gives access to gated models.
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any

import httpx

from .fit import quant_of, split_key
from .gguf import GgufError, ModelShape, fetch_shape

PAGE_SIZE = 25
SEARCH_TTL = 600
DETAIL_TTL = 3600
MAX_CARD = 120_000
HF = "https://huggingface.co"

SORTS = {"downloads": "downloads", "likes": "likes", "trending": "trending_score", "updated": "last_modified"}
# Parameter count filters: the label in the client -> the num_parameters filter of the Hub API.
PARAMS = {"3B": "max:3B", "7B": "min:3B,max:9B", "14B": "min:9B,max:20B", "32B": "min:20B,max:40B", "70B": "min:40B"}
LIBRARIES = ("gguf", "safetensors")
EXPAND = ["gguf", "safetensors", "downloads", "likes", "lastModified", "gated", "tags", "author", "library_name",
          "pipeline_tag"]


class HubError(Exception):
    pass


def _api(token: str | None):
    try:
        from huggingface_hub import HfApi
    except ImportError:
        raise HubError("huggingface_hub is not installed in the daemon. Install it with: pip install huggingface_hub") from None
    return HfApi(token=token or False)


def _license(tags: list[str] | None) -> str | None:
    return next((t.split(":", 1)[1] for t in tags or [] if t.startswith("license:")), None)


def _params(info: Any) -> int | None:
    gguf = getattr(info, "gguf", None) or {}
    if isinstance(gguf, dict) and gguf.get("total"):
        return int(gguf["total"])
    st = getattr(info, "safetensors", None)
    total = getattr(st, "total", None)
    return int(total) if total else None


def _item(info: Any) -> dict[str, Any]:
    gguf = getattr(info, "gguf", None) or {}
    repo_id = info.id
    return {
        "repo_id": repo_id,
        "author": info.author or repo_id.split("/")[0],
        "name": repo_id.split("/")[-1],
        "params": _params(info),
        "license": _license(info.tags),
        "downloads": info.downloads or 0,
        "likes": info.likes or 0,
        "last_modified": info.last_modified.isoformat() if info.last_modified else None,
        "gated": bool(info.gated),
        "library": info.library_name,
        "architecture": gguf.get("architecture") if isinstance(gguf, dict) else None,
        "context_length": gguf.get("context_length") if isinstance(gguf, dict) else None,
    }


def group_files(siblings: list[tuple[str, int]]) -> list[dict[str, Any]]:
    """Model files as downloads. The parts of a split GGUF file are one download.

    The safetensors files of a repository are one download (a vLLM model).
    """
    groups: dict[str, dict[str, Any]] = {}
    for name, size in siblings:
        base = name.rsplit("/", 1)[-1].lower()
        if name.endswith(".gguf") and not base.startswith("mmproj"):
            split = split_key(name)
            key = f"{split[0]}#{split[2]}" if split else name
            group = groups.setdefault(key, {"name": name, "label": split[0] if split else name, "files": [],
                                            "size": 0, "quant": quant_of(name), "format": "gguf",
                                            "parts": split[2] if split else 1})
            group["files"].append(name)
            group["size"] += size or 0
        elif name.endswith(".safetensors"):
            group = groups.setdefault("safetensors", {"name": "safetensors", "label": "safetensors (all files)",
                                                      "files": [], "size": 0, "quant": "BF16", "format": "safetensors",
                                                      "parts": 0})
            group["files"].append(name)
            group["size"] += size or 0
            group["parts"] += 1
    for group in groups.values():
        group["files"].sort()
        group["name"] = group["files"][0]
        if group["parts"] > 1 and group["format"] == "gguf":
            group["label"] = f"{group['label']} ({group['parts']} parts)"
    return sorted(groups.values(), key=lambda g: g["size"])


def _strip_front_matter(text: str) -> str:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            return text[end + 4:].lstrip()
    return text


def shape_from_config(config: dict[str, Any]) -> ModelShape | None:
    """The model shape from a transformers config.json, for safetensors models."""
    cfg = config.get("text_config") if isinstance(config.get("text_config"), dict) else config
    layers, heads = cfg.get("num_hidden_layers"), cfg.get("num_attention_heads")
    if not layers or not heads:
        return None
    return ModelShape(
        architecture=str(config.get("model_type") or cfg.get("model_type") or ""),
        layers=int(layers), heads=int(heads), kv_heads=int(cfg.get("num_key_value_heads") or heads),
        embedding=int(cfg.get("hidden_size") or 0),
        key_length=int(cfg["head_dim"]) if cfg.get("head_dim") else None,
        context_length=int(cfg["max_position_embeddings"]) if cfg.get("max_position_embeddings") else None,
    )


class Hub:
    def __init__(self) -> None:
        self.token: str | None = None
        self._search: dict[tuple, tuple[float, list[dict[str, Any]], bool]] = {}
        self._detail: dict[str, tuple[float, dict[str, Any]]] = {}

    def set_token(self, token: str | None) -> None:
        if token != self.token:
            self.token = token or None
            self._detail.clear()  # Access to gated models can change.

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    async def search(self, query: str, library: str, task: str | None, params: str | None, sort: str,
                     page: int) -> tuple[list[dict[str, Any]], bool]:
        """One page of results and True if there are more."""
        if library not in LIBRARIES:
            raise HubError(f"The library must be one of: {', '.join(LIBRARIES)}.")
        if sort not in SORTS:
            raise HubError(f"The sort must be one of: {', '.join(SORTS)}.")
        if params and params not in PARAMS:
            raise HubError(f"The parameter filter must be one of: {', '.join(PARAMS)}.")
        key = (query.strip().lower(), library, task or "", params or "", sort)
        need = (page + 1) * PAGE_SIZE
        cached = self._search.get(key)
        if cached and time.time() - cached[0] < SEARCH_TTL and (len(cached[1]) > need or cached[2]):
            items, exhausted = cached[1], cached[2]
        else:
            # Ask for one more page than necessary: the result shows if more pages exist.
            limit = need + PAGE_SIZE

            def fetch() -> list[dict[str, Any]]:
                api = _api(self.token)
                found = api.list_models(
                    search=query.strip() or None, filter=library, pipeline_tag=task or None,
                    num_parameters=PARAMS.get(params or ""), sort=SORTS[sort], limit=limit, expand=EXPAND)
                return [_item(m) for m in found]

            try:
                items = await asyncio.to_thread(fetch)
            except HubError:
                raise
            except Exception as e:  # noqa: BLE001 - network or API errors.
                raise HubError(f"The Hugging Face search failed: {e}") from None
            exhausted = len(items) < limit
            self._search[key] = (time.time(), items, exhausted)
        start = page * PAGE_SIZE
        return items[start:start + PAGE_SIZE], len(items) > start + PAGE_SIZE

    async def detail(self, repo_id: str) -> dict[str, Any]:
        cached = self._detail.get(repo_id)
        if cached and time.time() - cached[0] < DETAIL_TTL:
            return cached[1]

        def fetch() -> Any:
            return _api(self.token).model_info(repo_id, files_metadata=True)

        try:
            info = await asyncio.to_thread(fetch)
        except Exception as e:  # noqa: BLE001
            name = type(e).__name__
            if "RepositoryNotFound" in name:
                raise HubError(f"The model {repo_id} does not exist, or it is private.") from None
            raise HubError(f"The model details failed: {e}") from None

        groups = group_files([(s.rfilename, s.size or 0) for s in info.siblings or []])
        access = await self._access(repo_id, bool(info.gated))
        card, (shape, shape_error) = await asyncio.gather(self._card(repo_id), self._shape(repo_id, groups, access))
        detail = {
            "repo_id": repo_id,
            "url": f"{HF}/{repo_id}",
            "item": _item(info),
            "groups": groups,
            "card": card,
            "gated": bool(info.gated),
            "access": access,
            "shape": shape.to_json() if shape else None,
            "shape_error": shape_error,
            "_shape": shape,
            "_sizes": {s.rfilename: int(s.size or 0) for s in info.siblings or []},
        }
        self._detail[repo_id] = (time.time(), detail)
        return detail

    async def _access(self, repo_id: str, gated: bool) -> bool:
        if not gated:
            return True
        if not self.token:
            return False

        def check() -> bool:
            try:
                _api(self.token).auth_check(repo_id)
                return True
            except Exception:  # noqa: BLE001 - GatedRepoError and others: no access.
                return False

        return await asyncio.to_thread(check)

    async def _card(self, repo_id: str) -> str:
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                r = await client.get(f"{HF}/{repo_id}/raw/main/README.md", headers=self.headers())
        except httpx.HTTPError:
            return ""
        if r.status_code != 200:
            return ""
        return _strip_front_matter(r.text[:MAX_CARD])

    async def _shape(self, repo_id: str, groups: list[dict[str, Any]],
                     access: bool) -> tuple[ModelShape | None, str | None]:
        """The model shape for the fit calculator, or an error text."""
        if not access:
            return None, "No access to the files. Accept the license of the model on Hugging Face."
        gguf = [g for g in groups if g["format"] == "gguf"]
        try:
            if gguf:
                first = gguf[0]["files"][0]  # All quants of a repository have the same shape.
                return await fetch_shape(f"{HF}/{repo_id}/resolve/main/{first}", self.token), None
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                r = await client.get(f"{HF}/{repo_id}/resolve/main/config.json", headers=self.headers())
            if r.status_code == 200:
                return shape_from_config(r.json()), None
            return None, "The model has no config.json."
        except (GgufError, httpx.HTTPError, ValueError) as e:
            return None, f"The model shape is not known: {e}"
