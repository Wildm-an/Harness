"""The plugin rows and the patch layers, the same model as DeepSeek Harness (cordis.patch.yml).

A patch file is a YAML list of patches. A patch with ``insert`` adds rows. Any other patch
needs the ``id`` of a row and replaces the keys that it gives::

    - insert:
        - id: hello             # The row id. It is unique in all layers.
          name: hello           # The module: <bundle> (its main file) or <bundle>/<file>.
          config: { greeting: Hi }
          disabled: false
    - id: hello                 # An override: a later layer wins.
      config: { greeting: Hey } # "config" replaces the full value. It does not merge.

The layers, from the first to the last (a later layer wins for each row):

1. The patch of each bundle that is on, in the bundle order.
2. The user layer: ``~/.harness/plugins.patch.yml``.
3. The project layer: ``<project>/.harness/plugins.patch.yml``.

The order of the rows does not set the load order. The ``inject`` list of each plugin sets it.
A row can name only the modules of installed bundles. Thus a project file cannot run its own code.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from ..config import harness_home

PATCH_FILE = "plugins.patch.yml"
ROW_KEYS = {"id", "name", "config", "disabled", "inject"}


@dataclass
class Row:
    id: str
    name: str  # <bundle> or <bundle>/<module>
    config: Any = None
    disabled: bool = False
    inject: list[str] | None = None  # Replaces the inject list of the module, if it is set.
    layer: str = ""  # The layer that added the row.
    overrides: list[str] = field(default_factory=list)  # The layers that changed the row.

    @property
    def bundle(self) -> str:
        return self.name.split("/", 1)[0]


@dataclass
class Layer:
    label: str  # "bundle:<name>", "user", or "project"
    path: Path
    patches: list[dict[str, Any]]


def user_patch_path() -> Path:
    return harness_home() / PATCH_FILE


def project_patch_path(cwd: Path) -> Path:
    return Path(cwd) / ".harness" / PATCH_FILE


def read_patch_file(path: Path) -> list[dict[str, Any]]:
    """Read a patch file. A missing or empty file has no patches. Raise ValueError for a bad file."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise ValueError(f"{path} is not valid YAML: {e}") from None
    if data is None:
        return []
    if not isinstance(data, list) or not all(isinstance(p, dict) for p in data):
        raise ValueError(f"{path} must be a YAML list of patches.")
    return data


def write_patch_file(path: Path, patches: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(yaml.safe_dump(patches, sort_keys=False, allow_unicode=True), encoding="utf-8")
    tmp.replace(path)


def compose(layers: list[Layer]) -> tuple[dict[str, Row], list[str]]:
    """Apply the layers in order to an empty row list. Return the rows and the warnings."""
    rows: dict[str, Row] = {}
    warnings: list[str] = []
    for layer in layers:
        where = f"{layer.path}"
        for patch in layer.patches:
            patch = copy.deepcopy(patch)
            if "insert" in patch:
                if patch.get("id") is not None:
                    warnings.append(f"{where}: an insert into a group is not supported. The patch is ignored.")
                    continue
                entries = patch["insert"]
                if not isinstance(entries, list):
                    warnings.append(f"{where}: 'insert' must be a list of rows.")
                    continue
                for entry in entries:
                    problem = _row_problem(entry)
                    if problem:
                        warnings.append(f"{where}: {problem}")
                    elif entry["id"] in rows:
                        warnings.append(f"{where}: the row {entry['id']!r} already exists. The insert is ignored.")
                    else:
                        rows[entry["id"]] = Row(
                            id=entry["id"], name=entry["name"], config=entry.get("config"),
                            disabled=bool(entry.get("disabled")), inject=entry.get("inject"), layer=layer.label)
                continue
            row_id = patch.pop("id", None)
            if not isinstance(row_id, str):
                warnings.append(f"{where}: a patch with no 'insert' needs an 'id'.")
                continue
            target = rows.get(row_id)
            if target is None:
                warnings.append(f"{where}: the row {row_id!r} does not exist.")
                continue
            name = patch.pop("name", None)
            if name is not None and name != target.name:
                warnings.append(f"{where}: the row {row_id!r} is {target.name!r}, not {name!r}. The patch is ignored.")
                continue
            unknown = set(patch) - ROW_KEYS
            if unknown:
                warnings.append(f"{where}: unknown keys for the row {row_id!r}: {', '.join(sorted(unknown))}.")
            if "config" in patch:
                target.config = patch["config"]
            if "disabled" in patch:
                target.disabled = bool(patch["disabled"])
            if "inject" in patch:
                target.inject = patch["inject"]
            target.overrides.append(layer.label)
    return rows, warnings


def _row_problem(entry: Any) -> str | None:
    if not isinstance(entry, dict):
        return "a row must be an object with 'id' and 'name'."
    if not isinstance(entry.get("id"), str) or not entry["id"].strip():
        return "a row needs an 'id' string."
    if not isinstance(entry.get("name"), str) or not entry["name"].strip():
        return f"the row {entry['id']!r} needs a 'name' string."
    inject = entry.get("inject")
    if inject is not None and not (isinstance(inject, list) and all(isinstance(i, str) for i in inject)):
        return f"the row {entry['id']!r}: 'inject' must be a list of service names."
    return None


def set_row_disabled(row_id: str, disabled: bool, cwd: Path | None) -> Path:
    """Write ``disabled`` for a row. Return the file that changed.

    The value goes to the last writable layer that already sets ``disabled`` for the row: the
    project layer, if it does, else the user layer. Thus the toggle always has an effect.
    """
    path = user_patch_path()
    if cwd is not None:
        project = project_patch_path(cwd)
        if any(_sets_disabled(p, row_id) for p in read_patch_file(project)):
            path = project
    patches = read_patch_file(path)
    for patch in reversed(patches):
        if "insert" not in patch and patch.get("id") == row_id:
            patch["disabled"] = disabled
            break
        inserted = next((e for e in patch.get("insert") or [] if isinstance(e, dict) and e.get("id") == row_id), None)
        if inserted is not None:
            inserted["disabled"] = disabled
            break
    else:
        patches.append({"id": row_id, "disabled": disabled})
    write_patch_file(path, patches)
    return path


def _sets_disabled(patch: dict[str, Any], row_id: str) -> bool:
    if "insert" in patch:
        return any(isinstance(e, dict) and e.get("id") == row_id and "disabled" in e for e in patch["insert"] or [])
    return patch.get("id") == row_id and "disabled" in patch
