"""The tool set of the agent. Keep it small: small models make more errors with many tools."""

from __future__ import annotations

from .base import Approval, Tool, ToolContext, ToolError, ToolResult, truncate
from .bash import BashTool
from .edit import EditTool
from .glob import GlobTool
from .grep import GrepTool
from .read import ReadTool
from .shell import ShellInfo, detect_shell
from .skill import SkillTool
from .write import WriteTool


def default_tools() -> list[Tool]:
    return [ReadTool(), GlobTool(), GrepTool(), EditTool(), WriteTool(), BashTool()]


__all__ = [
    "Approval",
    "BashTool",
    "EditTool",
    "GlobTool",
    "GrepTool",
    "ReadTool",
    "ShellInfo",
    "SkillTool",
    "Tool",
    "ToolContext",
    "ToolError",
    "ToolResult",
    "default_tools",
    "detect_shell",
    "truncate",
    "WriteTool",
]
