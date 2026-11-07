"""The harnesses that can run the agent loop of a session through ACP (Agent Client Protocol).

Settings > Operating Harness lists them. The user setting ``operating_harness`` holds the id of the
harness for new sessions. No value (or "harness") is the built-in agent loop of Harness (agent.py).

The list comes from the ACP registry (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json,
November 2026), plus Oh My Pi, which is not in the registry. An entry starts in one of three ways:

- ``bin``: a program on the PATH of the daemon computer, with its ACP arguments.
- ``npx``: an npm package at a fixed version. Node.js must be installed. npx downloads the package
  at the first start.
- ``uvx``: a Python package at a fixed version. uv must be installed.

An entry with ``bin`` and ``npx`` uses the program when it is on the PATH, else npx.

The user can add custom harnesses (a name and a command line). They are in ~/.harness/harnesses.json.
"""

from __future__ import annotations

import os
import re
import shlex
import shutil
from dataclasses import dataclass, field
from typing import Any

from .config import harness_home, read_json, write_json

BUILTIN_ID = "harness"  # The agent loop of Harness. It is not an ACP harness.
CUSTOM_PREFIX = "custom-"
MAX_CUSTOM = 20


@dataclass(frozen=True)
class HarnessSpec:
    id: str
    name: str
    description: str
    website: str
    license: str
    bin: tuple[str, tuple[str, ...]] | None = None  # (program, args)
    npx: tuple[str, tuple[str, ...]] | None = None  # (package@version, args)
    uvx: tuple[str, tuple[str, ...]] | None = None  # (package==version, args)
    env: dict[str, str] = field(default_factory=dict, hash=False, compare=False)
    custom: bool = False
    command_line: str = ""  # A custom harness: the command as the user typed it.

    def command_text(self) -> str:
        """The command line, for the client."""
        if self.command_line:
            return self.command_line
        if self.bin is not None and (self.npx is None or shutil.which(self.bin[0])):
            return " ".join([self.bin[0], *self.bin[1]])
        if self.npx is not None:
            return " ".join(["npx", "-y", self.npx[0], *self.npx[1]])
        if self.uvx is not None:
            return " ".join(["uvx", self.uvx[0], *self.uvx[1]])
        return ""


def _h(id: str, name: str, description: str, website: str, license: str, *,
       bin: tuple[str, list[str]] | None = None, npx: tuple[str, list[str]] | None = None,
       uvx: tuple[str, list[str]] | None = None, env: dict[str, str] | None = None) -> HarnessSpec:
    return HarnessSpec(
        id=id, name=name, description=description, website=website, license=license,
        bin=(bin[0], tuple(bin[1])) if bin else None,
        npx=(npx[0], tuple(npx[1])) if npx else None,
        uvx=(uvx[0], tuple(uvx[1])) if uvx else None,
        env=dict(env or {}),
    )


CATALOG: tuple[HarnessSpec, ...] = (
    _h("amp-acp", "Amp", "ACP wrapper for Amp, the coding agent of Sourcegraph.", "https://github.com/tao12345666333/amp-acp", "Apache-2.0", bin=("amp-acp", [])),
    _h("auggie", "Auggie CLI", "The software agent of Augment Code.", "https://www.augmentcode.com/", "Proprietary", npx=("@augmentcode/auggie@0.37.0", ["--acp"]), env={"AUGMENT_DISABLE_AUTO_UPDATE": "1"}),
    _h("autohand", "Autohand Code", "Autohand Code CLI with ACP support.", "https://github.com/autohandai/code-cli", "Apache-2.0", bin=("autohand", ["--acp"])),
    _h("bob", "Bob", "The AI development partner of IBM.", "https://bob.ibm.com", "Proprietary", npx=("@ibm/bob@2.0.9", ["acp"])),
    _h("claude-acp", "Claude Agent", "ACP adapter for Claude Code. Needs an Anthropic account.", "https://github.com/agentclientprotocol/claude-agent-acp", "Proprietary", npx=("@agentclientprotocol/claude-agent-acp@0.101.0", [])),
    _h("cline", "Cline", "Autonomous coding agent CLI: it edits files, runs commands, and uses a browser.", "https://cline.bot/cli", "Apache-2.0", npx=("cline@3.0.74", ["--acp"])),
    _h("codebuddy-code", "Codebuddy Code", "The coding tool of Tencent Cloud.", "https://www.codebuddy.cn/cli/", "Proprietary", npx=("@tencent-ai/codebuddy-code@2.181.0", ["--acp"])),
    _h("codex-acp", "Codex", "ACP adapter for Codex, the coding agent of OpenAI.", "https://github.com/agentclientprotocol/codex-acp", "Apache-2.0", npx=("@agentclientprotocol/codex-acp@2.5.0", [])),
    _h("cortex-code", "Cortex Code", "The Cortex Code coding agent of Snowflake.", "https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code", "Proprietary", bin=("cortex", ["acp", "serve"])),
    _h("corust-agent", "Corust Agent", "A coding agent for Rust projects.", "https://corust.ai/", "GPL-3.0-or-later", bin=("corust-agent-acp", [])),
    _h("crow-cli", "crow-cli", "A small coding agent with native ACP.", "https://crow-ai.dev", "MIT", bin=("crow-cli", ["acp"])),
    _h("cursor", "Cursor", "The coding agent of Cursor.", "https://cursor.com/docs/cli/acp", "Proprietary", bin=("cursor-agent", ["acp"])),
    _h("deepagents", "DeepAgents", "A coding and general agent on LangChain.", "https://docs.langchain.com/oss/javascript/deepagents/overview", "MIT", npx=("deepagents-acp@0.1.7", [])),
    _h("devin", "Devin", "The Devin CLI coding agent of Cognition.", "https://docs.devin.ai/cli", "Proprietary", bin=("devin", ["acp"])),
    _h("dimcode", "DimCode", "A coding agent for many models.", "https://dimagent.cn/", "Proprietary", npx=("dimcode@0.5.24", ["acp"])),
    _h("dirac", "Dirac", "An open source coding agent with hash-anchored edits.", "https://dirac.run", "Apache-2.0", npx=("dirac-cli@0.5.24", ["--acp"])),
    _h("factory-droid", "Factory Droid", "The coding agent of Factory AI.", "https://factory.ai/product/cli", "Proprietary", npx=("droid@1.5.0", ["exec", "--output-format", "acp-daemon"]), env={"DROID_DISABLE_AUTO_UPDATE": "true", "FACTORY_DROID_AUTO_UPDATE_ENABLED": "false"}),
    _h("fast-agent", "fast-agent", "An agent framework with support for many model providers.", "https://fast-agent.ai", "Apache-2.0", uvx=("fast-agent-acp==0.10.1", ["-x"])),
    _h("gemini", "Gemini CLI", "The CLI agent of Google for Gemini.", "https://geminicli.com", "Apache-2.0", npx=("@google/gemini-cli@0.67.0", ["--acp"])),
    _h("github-copilot-cli", "GitHub Copilot", "The Copilot CLI agent of GitHub.", "https://github.com/features/copilot/cli/", "Proprietary", npx=("@github/copilot@1.0.107", ["--acp"])),
    _h("glm-acp-agent", "GLM Agent", "An ACP agent for the GLM Coding Plan models of Zhipu AI.", "https://github.com/stefandevo/glm-acp-agent", "Apache-2.0", npx=("glm-acp-agent@1.17.0", [])),
    _h("goose", "goose", "A local, open source AI agent of Block.", "https://block.github.io/goose/", "Apache-2.0", bin=("goose", ["acp"])),
    _h("grok-build", "Grok Build", "The coding agent of xAI.", "https://x.ai/cli", "Proprietary", npx=("@xai-official/grok@1.0.78", ["agent", "stdio"])),
    _h("harn", "Harn", "Runs .harn agent pipelines as an ACP coding agent.", "https://harnlang.com", "Apache-2.0", bin=("harn", ["serve", "acp"])),
    _h("junie", "Junie", "The coding agent of JetBrains.", "https://junie.jetbrains.com", "Proprietary", bin=("junie", ["--acp=true"])),
    _h("kilo", "Kilo", "An open source coding agent.", "https://kilo.ai/", "MIT", bin=("kilo", ["acp"]), npx=("@kilocode/cli@7.8.27", ["acp"])),
    _h("kimchi", "Kimchi", "A coding agent with multi-model orchestration.", "https://kimchi.dev", "Apache-2.0", bin=("kimchi", ["--mode", "acp"])),
    _h("kimi-code", "Kimi Code", "The coding agent of Moonshot AI.", "https://moonshotai.github.io/kimi-code/", "MIT", npx=("@moonshot-ai/kimi-code@2.5.2", ["acp"])),
    _h("kiro", "Kiro CLI", "The Kiro coding agent.", "https://kiro.dev/docs/cli/acp/", "Proprietary", bin=("kiro-cli", ["acp", "--agent-engine=v3"])),
    _h("minimax-code", "MiniMax Code", "The coding agent of MiniMax.", "https://agent.minimax.io", "MIT", npx=("@minimax-ai/code@0.2.7", ["acp"])),
    _h("minion-code", "Minion Code", "A code assistant on the Minion framework.", "https://github.com/femto/minion-code", "AGPL-3.0", uvx=("minion-code@0.1.44", ["acp"])),
    _h("mistral-vibe", "Mistral Vibe", "The open source coding assistant of Mistral.", "https://mistral.ai/products/vibe", "Apache-2.0", bin=("vibe-acp", [])),
    _h("nova", "Nova", "The software engineer agent of Compass AI.", "https://www.compassap.ai/portfolio/nova.html", "Proprietary", npx=("@compass-ai/nova@1.1.64", ["acp"])),
    _h("omp", "Oh My Pi", "A terminal coding agent, a fork of Pi with more tools. Not in the ACP registry.", "https://github.com/can1357/oh-my-pi", "MIT", bin=("omp", ["--mode", "acp"])),
    _h("opencode", "OpenCode", "An open source coding agent. It can use local models.", "https://opencode.ai", "MIT", bin=("opencode", ["acp"])),
    _h("pi-acp", "Pi", "ACP adapter for the Pi coding agent.", "https://github.com/svkozak/pi-acp", "MIT", npx=("pi-acp@0.0.34", [])),
    _h("qoder", "Qoder CLI", "A coding assistant with agent features.", "https://qoder.com", "Proprietary", npx=("@qoder-ai/qodercli@0.2.14", ["--acp"])),
    _h("qwen-code", "Qwen Code", "The coding assistant of Alibaba for Qwen models.", "https://qwenlm.github.io/qwen-code-docs/en/users/overview", "Apache-2.0", npx=("@qwen-code/qwen-code@0.26.9", ["--acp", "--experimental-skills"])),
    _h("sigit", "siGit Code", "A local-first coding agent with optional on-device models.", "https://github.com/getsigit/sigit", "Apache-2.0", bin=("sigit", []), npx=("@smbcloud/sigit@1.7.8", [])),
    _h("stakpak", "Stakpak", "An open source DevOps agent in Rust.", "https://stakpak.dev", "Apache-2.0", bin=("stakpak", ["acp"])),
    _h("vtcode", "VT Code", "An open source coding agent with support for many model providers.", "https://github.com/vinhnx/VTCode", "MIT", bin=("vtcode", ["acp"])),
)


# The harnesses that the page shows first, in this order, with the reason for each. They have native ACP or
# an adapter of the ACP project, and they are in active use. "local": they can use a local model server, for
# example the llama-server of the Local Models page.
RECOMMENDED: dict[str, tuple[str, bool]] = {
    "opencode": ("Open source, with native ACP. It works with many providers and with local models.", True),
    "omp": ("Open source, with native ACP. A fork of Pi with more tools, LSP, and a debugger.", False),
    "codex-acp": ("The ACP adapter of the ACP project for OpenAI Codex.", False),
    "claude-acp": ("The ACP adapter of the ACP project for Claude Code. Needs an Anthropic account.", False),
    "gemini": ("Native ACP. Gemini CLI was the first harness with ACP, together with Zed.", False),
    "goose": ("Open source, with native ACP. It works with many providers and with local models (Ollama).", True),
    "qwen-code": ("Open source, with native ACP. It works with OpenAI-compatible servers, also local ones.", True),
    "cline": ("Open source, with native ACP. It works with local models (Ollama, LM Studio).", True),
}


class HarnessError(Exception):
    pass


def _custom_path():
    return harness_home() / "harnesses.json"


def _split(command: str) -> list[str]:
    """Split a command line. On Windows, a backslash is a path separator, not an escape."""
    if os.name == "nt":
        parts = shlex.split(command, posix=False)
        return [p[1:-1] if len(p) >= 2 and p[0] == p[-1] and p[0] in "\"'" else p for p in parts]
    return shlex.split(command)


def custom_harnesses() -> list[HarnessSpec]:
    data = read_json(_custom_path(), {})
    items = data.get("harnesses") if isinstance(data, dict) else None
    result = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        hid, name, command = item.get("id"), item.get("name"), item.get("command")
        if not (isinstance(hid, str) and isinstance(name, str) and isinstance(command, str)):
            continue
        try:
            argv = _split(command)
        except ValueError:
            continue
        if not argv:
            continue
        result.append(HarnessSpec(id=hid, name=name, description="A custom harness.", website="", license="",
                                  bin=(argv[0], tuple(argv[1:])), custom=True, command_line=command))
    return result


def all_harnesses() -> list[HarnessSpec]:
    return [*CATALOG, *custom_harnesses()]


def find(harness_id: str) -> HarnessSpec | None:
    for spec in all_harnesses():
        if spec.id == harness_id:
            return spec
    return None


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "harness"


def save_custom(name: str, command: str, harness_id: str | None = None) -> HarnessSpec:
    """Add a custom harness, or change it (``harness_id``). Return the saved harness."""
    name = " ".join(name.split())
    command = command.strip()
    if not name or len(name) > 60:
        raise HarnessError("Give a name of 1 to 60 characters.")
    if not command:
        raise HarnessError("Give the command that starts the harness in ACP mode, for example: omp --mode acp")
    try:
        argv = _split(command)
    except ValueError as e:
        raise HarnessError(f"The command is not valid: {e}.") from None
    if not argv:
        raise HarnessError("Give the command that starts the harness in ACP mode.")
    data = read_json(_custom_path(), {})
    items = [i for i in (data.get("harnesses") or []) if isinstance(i, dict)] if isinstance(data, dict) else []
    if harness_id is not None:
        entry = next((i for i in items if i.get("id") == harness_id), None)
        if entry is None:
            raise HarnessError(f"Unknown custom harness: {harness_id}.")
        entry.update(name=name, command=command)
    else:
        if len(items) >= MAX_CUSTOM:
            raise HarnessError(f"You can add {MAX_CUSTOM} custom harnesses or less.")
        used = {i.get("id") for i in items}
        base = CUSTOM_PREFIX + _slug(name)
        harness_id, n = base, 2
        while harness_id in used:
            harness_id, n = f"{base}-{n}", n + 1
        items.append({"id": harness_id, "name": name, "command": command})
    write_json(_custom_path(), {"harnesses": items})
    spec = find(harness_id)
    assert spec is not None
    return spec


def delete_custom(harness_id: str) -> None:
    data = read_json(_custom_path(), {})
    items = [i for i in (data.get("harnesses") or []) if isinstance(i, dict)] if isinstance(data, dict) else []
    kept = [i for i in items if i.get("id") != harness_id]
    if len(kept) == len(items):
        raise HarnessError(f"Unknown custom harness: {harness_id}.")
    write_json(_custom_path(), {"harnesses": kept})


def launch_argv(spec: HarnessSpec) -> tuple[list[str], dict[str, str]]:
    """The program with its arguments, and the extra environment. Raise HarnessError when the program
    is not on the daemon computer."""
    if spec.bin is not None:
        program, args = spec.bin
        path = program if re.search(r"[\\/]", program) and os.path.exists(program) else shutil.which(program)
        if path is not None:
            return [path, *args], dict(spec.env)
    if spec.npx is not None:
        npx = shutil.which("npx")
        if npx is None:
            raise HarnessError(f"{spec.name} runs with npx. Install Node.js (it has npx) on the daemon computer.")
        package, args = spec.npx
        return [npx, "-y", package, *args], dict(spec.env)
    if spec.uvx is not None:
        uvx = shutil.which("uvx")
        if uvx is None:
            raise HarnessError(f"{spec.name} runs with uvx. Install uv on the daemon computer.")
        package, args = spec.uvx
        return [uvx, package, *args], dict(spec.env)
    assert spec.bin is not None
    where = f" See {spec.website}." if spec.website else ""
    raise HarnessError(f"'{spec.bin[0]}' is not on the PATH of the daemon computer. Install {spec.name} first.{where}")


def status(spec: HarnessSpec) -> tuple[str, str]:
    """The state for the client: ("installed" | "npx" | "uvx" | "missing", a short detail)."""
    if spec.bin is not None:
        program = spec.bin[0]
        found = program if re.search(r"[\\/]", program) and os.path.exists(program) else shutil.which(program)
        if found:
            return "installed", found
    if spec.npx is not None:
        if shutil.which("npx"):
            return "npx", f"npx downloads {spec.npx[0]} at the first start."
        return "missing", "Install Node.js (it has npx)."
    if spec.uvx is not None:
        if shutil.which("uvx"):
            return "uvx", f"uvx downloads {spec.uvx[0]} at the first start."
        return "missing", "Install uv (it has uvx)."
    return "missing", f"'{spec.bin[0] if spec.bin else ''}' is not on the PATH."


def public(spec: HarnessSpec) -> dict[str, Any]:
    state, detail = status(spec)
    reason, local = RECOMMENDED.get(spec.id, ("", False)) if not spec.custom else ("", False)
    rank = list(RECOMMENDED).index(spec.id) if reason else None
    return {
        "recommended": rank,  # The place in the Recommended group, or None.
        "reason": reason,
        "local_models": local,
        "id": spec.id,
        "name": spec.name,
        "description": spec.description,
        "website": spec.website,
        "license": spec.license,
        "command": spec.command_text(),
        "status": state,
        "detail": detail,
        "custom": spec.custom,
    }


def listing() -> list[dict[str, Any]]:
    return [public(s) for s in all_harnesses()]
