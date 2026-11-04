# Changes for Harness

This skill is Anthropic's `mcp-builder` skill, licensed under the Apache License 2.0 (see `LICENSE.txt`). Harness changed these files on 2026-11-04:

- `SKILL.md`
  - A note at the top about the origin and the license.
  - The tool names `WebFetch` and "web search" changed to the Harness tools `web_fetch` and `web_search`.
  - A new step "3.3 Connect the Server to Harness": the `.harness/mcp.json` format and how to reload the servers.
  - A new step "4.4 Run the Evaluation": `scripts/evaluation.py` needs an Anthropic API key, and an evaluation with Harness subagents when there is none. The old step 4.4 is now 4.5.
- `reference/python_mcp_server.md`: the tool name `WebFetch` changed to `web_fetch`.
- `scripts/evaluation.py`: it writes the report as UTF-8.

All other files are the same as in the original skill.
