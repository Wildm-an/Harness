"""hello/guard: a hook that blocks some bash commands before they run.

The row is off in patch.yml. Turn it on in the Plugins screen.
"""

inject = ["hooks"]
Config = {"blocked": ["rm -rf /"]}


def apply(ctx, config):
    def check(call):
        # call.name, call.args, and call.cwd describe the tool call. call.block() stops it.
        command = str(call.args.get("command", ""))
        if call.name == "bash" and any(text in command for text in config["blocked"]):
            call.block(f"The hello/guard plugin does not allow this command: {command}")

    ctx.on("tool.before", check)
