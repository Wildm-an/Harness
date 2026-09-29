"""Hello: an example Harness plugin.

It shows the parts that a plugin can register. Each registration is removed when the plugin
unloads, so the plugin needs no cleanup code.
"""

inject = ["tools", "commands", "prompt", "skills"]  # The services that apply() uses.
provide = ["greeter"]  # A service for other plugins. hello/guard does not need it. It is an example.
Config = {"greeting": "Hello"}  # The default config. The row config in patch.yml replaces these values.


def apply(ctx, config):
    def greet(name):
        return f"{config['greeting']}, {name}!"

    # Other plugins can use this function: inject = ["greeter"], then ctx.greeter("Ada").
    ctx.provide("greeter", greet)

    # A tool for the agent. The short parameter form is the same as in DeepSeek Harness.
    @ctx.tools.tool("greet", description="Greet a person by name.",
                    parameters={"name": {"type": "string", "description": "The name of the person.", "required": True}})
    def greet_tool(args, tool_ctx):
        return greet(args["name"])

    # A / command for the user. Return text to show it, or Prompt("...") to send it to the agent.
    @ctx.commands.command(description="Greet someone. With no name, greet the world.", argument_hint="[name]")
    def hello(invocation):
        return greet(invocation.args.strip() or "world")

    # Text for the system prompt of the agent.
    ctx.prompt.section("# Greetings\n\nWhen the user asks you to greet someone, use the greet tool.")

    # Skills in the Claude Code SKILL.md format: skills/<name>/SKILL.md in this folder.
    ctx.skills.add_root("skills")
