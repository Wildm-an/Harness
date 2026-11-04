---
name: pptx
description: "Use for any PowerPoint task: make, read, edit, or restyle a .pptx or .potx file (slide deck, pitch deck, presentation, slides). Also for decks from a template, speaker notes, charts and tables on slides, and text taken from a .pptx. Not for a Word document, a PDF, or Google Slides."
---

# Presentations (.pptx)

The scripts are in `${CLAUDE_SKILL_DIR}/scripts`. The shared Office scripts are in `${CLAUDE_SKILL_DIR}/../_office`. Read `${CLAUDE_SKILL_DIR}/reference/design.md` before you make a new deck.

## 1. Choose the method

| Task | Method |
|---|---|
| Read the text | The `read` tool. It shows each slide and numbers the shapes [2.1], [2.2]. |
| Change some text | The `office_edit` tool (replace, set_text, set_notes, add_slide, delete_slide). |
| Make a new deck | A Python script with python-pptx and `scripts/pptx_helpers.py` (section 3). |
| Make a deck from a template | `inventory.py`, `rearrange.py`, and `replace_text.py` (section 4). |
| See the shapes, positions, and layouts | `python "${CLAUDE_SKILL_DIR}/scripts/inventory.py" deck.pptx --layouts` |
| Look at the slides | `../_office/render.py grid deck.pptx` (section 5). |
| Convert .ppt to .pptx | `soffice --headless --convert-to pptx file.ppt` |
| Other changes: animations, themes, masters | Edit the XML with `../_office/ooxml.py` unpack and pack. |

## 2. Set up

1. Run `python -c "import pptx, PIL"`. On macOS and Linux the command is often `python3`.
2. If the import fails, run `python -m pip install python-pptx pillow`.
3. To look at slides, LibreOffice and pypdfium2 (`python -m pip install pypdfium2`) are necessary. They are optional.

## 3. Make a new deck

1. **Plan the content.** Write a short outline: one line for each slide, with its message. A slide has one message.
2. **Plan the design.** Read `reference/design.md`. Select a palette, a font pair, and a layout for each slide type (title, section, content, comparison, chart, closing). Use these choices on all slides.
3. **Write a build script**, for example `build_deck.py`. Use the helpers for exact positions.
4. **Run the script.** Fix each error and run it again.
5. **Check the slides** (section 5). Fix the problems in the build script, and build again.
6. Tell the user the file name and the number of slides.

```python
import sys
sys.path.insert(0, r"${CLAUDE_SKILL_DIR}/scripts")
from pptx_helpers import *

INK, MUTED, ACCENT, BG = "1E293B", "64748B", "2563EB", "F8FAFC"
prs = new_presentation()                          # 16:9, 13.333 x 7.5 in

s = blank_slide(prs)
set_background(s, "0F172A")
add_text(s, "Quarterly Review", 0.8, 2.5, 11.7, 1.3, size=48, bold=True, color="FFFFFF")
add_text(s, "Finance team, October 2026", 0.8, 3.9, 11.7, 0.6, size=20, color="94A3B8")

s = blank_slide(prs)
set_background(s, BG)
add_text(s, "Revenue grew in all regions", 0.6, 0.45, 12.1, 0.9, size=32, bold=True, color=INK)
add_bullets(s, ["North: +12%", "South: +8%", ("New stores drove the growth", 1)],
            0.6, 1.6, 5.6, 4.8, size=20, color=INK, bullet_color=ACCENT)
add_chart(s, "bar", ["North", "South", "West"], {"Revenue (M)": [1.2, 0.9, 0.7]},
          6.6, 1.5, 6.1, 5.0, colors=[ACCENT], labels=True)
add_notes(s, "Growth came mostly from the four new stores.")
prs.save("Quarterly Review.pptx")
```

The helpers are: `new_presentation`, `blank_slide`, `layout_slide`, `set_background`, `add_text`, `add_bullets`, `add_shape`, `add_line`, `add_image`, `add_table`, `add_chart`, `add_notes`, `rgb`. All positions are in inches from the top-left corner of the slide. Read the file for the parameters.

### Rules for a new deck

- Keep all shapes inside the slide, with a margin of at least 0.4 inches on each side.
- Do not let shapes overlap, unless one shape is a background for the other.
- Use real bullets (`add_bullets`), not typed "•" or "-" characters.
- Use native charts (`add_chart`) for numbers. The user can edit them in PowerPoint.
- Use `add_image(..., mode="contain")` or `mode="cover"`. Never stretch a picture.
- Put the details that the speaker says in the notes (`add_notes`), not on the slide.
- Do not use placeholder text such as "Lorem ipsum" or "Click to add text".

## 4. Make a deck from a template

Use this method when the user gives a .pptx or .potx file as the template, or asks for "our template".

1. **Look at the template.** Run `inventory.py template.pptx --layouts`. If you can, also run `render.py grid template.pptx` and read the image.
2. **Map the content to the template slides.** For each slide of the new deck, pick a template slide with a matching layout: a title slide, a section slide, a slide with two columns, a slide with a picture. Write the plan as a list, for example "1 (title), 4 (bullets), 4 (bullets), 7 (two columns), 12 (closing)". Pick a slide whose number of text areas agrees with the content. Do not put three items in a layout for four items.
3. **Make the draft:**
   `python "${CLAUDE_SKILL_DIR}/scripts/rearrange.py" template.pptx draft.pptx 1,4,4,7,12`
4. **List the shapes of the draft:** `inventory.py draft.pptx`. The slide numbers are now the new numbers.
5. **Write the text** in a JSON file. Use the shape keys of the draft:

   ```json
   {
     "1.1": "Quarterly Review",
     "1.2": "October 2026",
     "2.1": "Revenue grew in all regions",
     "2.2": [{"text": "North: +12%"}, {"text": "New stores drove the growth", "level": 1}],
     "notes:2": "Growth came from the four new stores."
   }
   ```

6. **Apply the text:**
   `python "${CLAUDE_SKILL_DIR}/scripts/replace_text.py" draft.pptx text.json -o final.pptx --clear-unlisted`
   `--clear-unlisted` removes the sample text of the template from the shapes that you did not fill.
7. **Check the slides** (section 5). Delete empty shapes or fix text that is too long. Then delete `draft.pptx` and `text.json`.

## 5. Check the slides

Always check a deck that you make or change.

1. Run `inventory.py final.pptx`. Look for "may overflow", empty text boxes, and sample text of the template.
2. If the model of this session accepts images, make a grid of the slides and read it:
   `python "${CLAUDE_SKILL_DIR}/../_office/render.py" grid final.pptx --cols 4`
   For details, make one image for each slide with `render.py images final.pptx --pages 3`.
3. Look for these problems: text that goes out of its box or off the slide, shapes that overlap, text with low contrast, slides that are too full, and slides that look different from the others.
4. Fix the problems and check again. Two or three rounds are normal.
5. If LibreOffice is not installed, step 2 fails. Then use only step 1, and tell the user that you did not check the look of the slides.
6. Delete the image files when you are done.
