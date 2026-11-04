---
name: init
description: "Make or improve the HARNESS.md file of a project: the instructions that Harness gives the agent at the start of each session. Use for /init, or when the user asks to set up, write, or update the project instructions, HARNESS.md, or CLAUDE.md."
---

# Make the project instruction file

Harness reads `HARNESS.md` in the project folder at the start of each session. If there is no `HARNESS.md`, it reads `CLAUDE.md`. The agent of each future session reads this file before it does any work. A good file saves each session from the same exploration.

## 1. Find what exists

1. Look for `HARNESS.md` and `CLAUDE.md` in the project folder.
   - If one of them exists, read it. Improve that file. Do not make a second file.
   - If none exists, you will make `HARNESS.md`.
2. Look for other instruction files and use their rules: `AGENTS.md`, `.cursorrules`, `.cursor/rules/`, `.github/copilot-instructions.md`, `.windsurfrules`, `CONTRIBUTING.md`.
3. Read `README.md`.

## 2. Explore the project

Find the facts that a new developer needs and that take time to find. Use `glob`, `grep`, and `read`. For a large project, use the `agent` tool to explore parts of it at the same time.

- **Commands.** Build, run, test, lint, and format. Find them in `package.json` scripts, `Makefile`, `pyproject.toml`, `Cargo.toml`, `justfile`, CI files (`.github/workflows/`), and the README. Find how to run one test file or one test.
- **Structure.** The main folders and what each one holds. The entry points. How the parts talk to each other (for example, a client and a server, a protocol, a database).
- **Conventions.** The code style, the naming rules, the test style, the commit message style (`git log --oneline -20`), and the branch rules.
- **Traps.** Things that are not obvious and that break work: generated files that must not be edited, a step that must run before the tests, environment variables, platform differences, slow commands.

Do not run commands that change files, install packages, or take a long time. Reading is enough.

## 3. Write the file

Write short, specific facts. The agent reads this file in each session, so each line must earn its place.

Use this structure. Leave out a section that has nothing useful:

```markdown
# <Project name>

<One or two sentences: what the project is and what it is built with.>

## Commands

- Install: `...`
- Build: `...`
- Run: `...`
- Test all: `...`
- Test one file: `...`
- Lint and format: `...`

## Structure

- `src/api/`: <what it holds>
- `src/web/`: <what it holds>

## Architecture

<A short description of how the main parts work together. Only what needs more than one file to understand.>

## Conventions

- <A rule that the code follows, with an example if it helps.>

## Traps

- <A thing that is not obvious and that breaks work.>
```

Rules:

- Write facts that you found in the project. Do not write general advice ("write clean code", "add tests", "handle errors").
- Do not list every file. The agent can list files. Describe only what is not clear from the names.
- Do not copy the README. Point to it if it has more detail.
- Keep the file under about 150 lines.
- Write commands exactly, in code format, so that the agent can copy them.
- Do not put secrets, tokens, or passwords in the file.

## 4. Finish

1. If you improve an existing file, keep the correct parts and the rules of the user. Change only what is wrong, missing, or too long. Tell the user what you changed.
2. Show the user the result: the path of the file and a short list of what it contains.
3. Ask the user to check the commands and the rules, because the next sessions will follow them.
