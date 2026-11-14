# Changes for Harness

This skill is Anthropic's `xlsx` skill, licensed under the Apache License 2.0 (see `LICENSE.txt`). The source is the version of 2026-11-12 (the Claude app and https://github.com/anthropics/skills). Harness changed these files on 2026-11-13:

- `SKILL.md`
  - A shorter description: Harness shows at most 300 characters of a description.
  - A note at the top about the origin and the license.
  - `openpyxl`, `pandas`, and `markitdown` are not preinstalled: the skill says to install them only if an import fails.
  - The examples `='[1]Returns Analysis'!B2`, `='Assumptions Inputs'!B5`, and `=B5*(1+B6)` have no `$` before the row number: in a Harness skill, a `$` followed by a digit becomes an argument of the user.
  - The Dependencies section tells how to install LibreOffice on Windows, macOS, and Linux.
- `scripts/office/soffice.py`
  - When `soffice` is not on the PATH, it adds the program folder of a standard LibreOffice install (Windows and macOS), so the scripts that start `soffice` by name find it.
  - `_needs_shim()` returns False when Python has no `AF_UNIX` (Windows), in place of an error.
- New file `scripts/office/pack.py`: packs an unpacked folder as `zip -XrD` does, for a computer with no `zip` command (Git Bash on Windows).

All other files are the same as in the original skill.
