"""Plugins: bundles of Python code that add tools, commands, skills, prompt text, hooks, MCP
servers, and model providers. See docs/PLUGINS.md.

A plugin needs no import for most work. For the other values, import them from here::

    from harness_daemon.plugins import Prompt, ToolError, ToolResult
"""

from __future__ import annotations

from ..tools.base import Tool, ToolContext, ToolError, ToolResult
from .host import (
    BUILTIN_SERVICES,
    EVENTS,
    Command,
    Context,
    Hooks,
    Invocation,
    PluginError,
    PluginHost,
    PluginTool,
    Prompt,
    RequestErrorEvent,
    RequestEvent,
    StepEvent,
    StreamEvent,
    ToolCall,
    TurnEvent,
    TurnStoppingEvent,
    object_schema,
    run_command,
)

__all__ = [
    "BUILTIN_SERVICES",
    "Command",
    "Context",
    "EVENTS",
    "Hooks",
    "Invocation",
    "PluginError",
    "PluginHost",
    "PluginTool",
    "Prompt",
    "Tool",
    "RequestErrorEvent",
    "RequestEvent",
    "StepEvent",
    "StreamEvent",
    "ToolCall",
    "ToolContext",
    "ToolError",
    "ToolResult",
    "TurnEvent",
    "TurnStoppingEvent",
    "object_schema",
    "run_command",
]
