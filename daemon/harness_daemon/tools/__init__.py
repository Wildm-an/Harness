"""The tool set of the agent. Keep it small: small models make more errors with many tools."""

from __future__ import annotations

from .apply_patch import APPLY_PATCH_FAMILIES, ApplyPatchTool, uses_patch
from .base import Approval, ReadState, Tool, ToolContext, ToolError, ToolResult, truncate
from .bash import BashTool
from .document import ShowDocumentTool
from .edit import EditTool
from .glob import GlobTool
from .grep import GrepTool
from .preview import preview_tools
from .office import OfficeEditTool
from .progress import UpdatePlanTool, WrapUpTool
from .read import ReadTool
from .shell import ShellInfo, detect_shell
from .share import ArtifactTool, SendFileTool
from .skill import SkillTool
from .visual import ShowVisualTool
from .web import WebFetchTool, WebSearchTool
from .write import WriteTool


def default_tools() -> list[Tool]:
    return [ReadTool(), GlobTool(), GrepTool(), EditTool(), WriteTool(), BashTool(), OfficeEditTool(), ShowDocumentTool(), ShowVisualTool(), SendFileTool(), ArtifactTool(), UpdatePlanTool(), WrapUpTool(),
            WebSearchTool(), WebFetchTool()]


__all__ = [
    "APPLY_PATCH_FAMILIES",
    "ApplyPatchTool",
    "Approval",
    "BashTool",
    "EditTool",
    "GlobTool",
    "GrepTool",
    "OfficeEditTool",
    "ShowDocumentTool",
    "ShowVisualTool",
    "SendFileTool",
    "ArtifactTool",
    "ReadTool",
    "ShellInfo",
    "SkillTool",
    "Tool",
    "ReadState",
    "ToolContext",
    "ToolError",
    "ToolResult",
    "default_tools",
    "detect_shell",
    "preview_tools",
    "truncate",
    "uses_patch",
    "UpdatePlanTool",
    "WrapUpTool",
    "WebFetchTool",
    "WebSearchTool",
    "WriteTool",
]
