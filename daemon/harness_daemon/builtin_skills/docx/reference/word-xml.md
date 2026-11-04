# WordprocessingML: the XML of a Word document

Read this file before you edit `word/document.xml` by hand. The prefix `w:` is the main namespace. `r:` is the relationship namespace.

## Parts of the archive

| Part | Contents |
|---|---|
| `[Content_Types].xml` | The content type of each part. A new part needs an `Override` here. |
| `_rels/.rels` | The link to the main document. |
| `word/document.xml` | The main text. |
| `word/_rels/document.xml.rels` | The links from the main text to styles, images, headers, comments, and web addresses. |
| `word/styles.xml` | The paragraph, character, and table styles. |
| `word/numbering.xml` | The bullet and number definitions of lists. |
| `word/header1.xml`, `word/footer1.xml` | Headers and footers. |
| `word/comments.xml` | The comment text. |
| `word/footnotes.xml`, `word/endnotes.xml` | Footnotes and endnotes. |
| `word/media/` | Images. |
| `word/settings.xml` | Document settings, for example `w:trackRevisions` and `w:updateFields`. |

## Body, paragraph, and run

```xml
<w:document>
  <w:body>
    <w:p>                                   <!-- a paragraph -->
      <w:pPr>                               <!-- paragraph properties: always the first child -->
        <w:pStyle w:val="Heading1"/>        <!-- the style ID, not the style name -->
        <w:jc w:val="center"/>              <!-- alignment: left, center, right, both -->
        <w:spacing w:before="120" w:after="120"/>  <!-- twentieths of a point -->
      </w:pPr>
      <w:r>                                 <!-- a run: text with one format -->
        <w:rPr>                             <!-- run properties: always the first child -->
          <w:b/><w:i/>
          <w:color w:val="1F3864"/>
          <w:sz w:val="24"/>                <!-- half points: 24 = 12 pt -->
        </w:rPr>
        <w:t xml:space="preserve">Text with a space at the end </w:t>
      </w:r>
    </w:p>
    <w:sectPr>...</w:sectPr>               <!-- page size and margins of the last section: always last -->
  </w:body>
</w:document>
```

Rules:

- Put `xml:space="preserve"` on each `w:t` that starts or ends with a space. Without it, Word removes the space.
- Escape `&`, `<`, and `>` in text as `&amp;`, `&lt;`, and `&gt;`.
- Word splits text into many runs, often in the middle of a word. Search for a short part of the text, then read the runs near it.
- A tab is `<w:tab/>` in a run. A line break is `<w:br/>`. A page break is `<w:br w:type="page"/>`.
- The order of the children in `w:pPr` and `w:rPr` is fixed by the schema. When you add a property, put it in the same position as in a similar paragraph of the same document. Common order in `w:rPr`: `rStyle, rFonts, b, i, caps, strike, color, sz, szCs, highlight, u, vertAlign, lang`.
- Units: twentieths of a point (twips) for spacing, indents, and page sizes. 1440 twips = 1 inch. Half points for font sizes. Eighths of a point for border widths. EMU for images: 914400 EMU = 1 inch.

## Lists

A list paragraph has a numbering reference. The numbering definitions are in `word/numbering.xml`.

```xml
<w:pPr>
  <w:pStyle w:val="ListParagraph"/>
  <w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>
</w:pPr>
```

To add an item to a list, copy the `w:pPr` of an item of the same list.

## Tables

```xml
<w:tbl>
  <w:tblPr>
    <w:tblStyle w:val="TableGrid"/>
    <w:tblW w:w="9360" w:type="dxa"/>
  </w:tblPr>
  <w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid>
  <w:tr>
    <w:trPr><w:tblHeader/></w:trPr>        <!-- repeat this row on each page -->
    <w:tc>
      <w:tcPr>
        <w:tcW w:w="4680" w:type="dxa"/>
        <w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>
      </w:tcPr>
      <w:p><w:r><w:t>Cell text</w:t></w:r></w:p>   <!-- each cell needs at least one w:p -->
    </w:tc>
  </w:tr>
</w:tbl>
```

The `w:gridCol` widths and the `w:tcW` widths must agree. A merged cell uses `w:gridSpan` (across) or `w:vMerge` (down).

## Tracked changes

Each change has a `w:id`, a `w:author`, and a `w:date`. Each `w:id` must be different from all other change IDs.

Inserted text: the runs are in `w:ins`.

```xml
<w:ins w:id="101" w:author="Harness" w:date="2026-01-15T10:00:00Z">
  <w:r><w:rPr>...</w:rPr><w:t>new text</w:t></w:r>
</w:ins>
```

Deleted text: the runs are in `w:del`, and the text is in `w:delText`, not in `w:t`.

```xml
<w:del w:id="102" w:author="Harness" w:date="2026-01-15T10:00:00Z">
  <w:r><w:rPr>...</w:rPr><w:delText>old text</w:delText></w:r>
</w:del>
```

A replacement is a `w:del` followed by a `w:ins`. Keep the `w:rPr` of the original run in both, so that the format does not change.

An inserted or deleted paragraph also marks the paragraph mark:

```xml
<w:p>
  <w:pPr><w:rPr><w:del w:id="103" w:author="Harness" w:date="..."/></w:rPr></w:pPr>
  <w:del w:id="104" w:author="Harness" w:date="..."><w:r><w:delText>Removed paragraph.</w:delText></w:r></w:del>
</w:p>
```

A format change keeps the old format in `w:rPrChange` (or `w:pPrChange`):

```xml
<w:rPr>
  <w:b/>
  <w:rPrChange w:id="105" w:author="Harness" w:date="..."><w:rPr/></w:rPrChange>
</w:rPr>
```

To make Word record the user's next edits as tracked changes, add `<w:trackRevisions/>` to `word/settings.xml`.

`scripts/redline.py` makes text changes for you. Edit this XML by hand only for other changes.

## Comments

A comment has a range in `document.xml` and its text in `comments.xml`. The `w:id` values must agree.

```xml
<w:commentRangeStart w:id="0"/>
<w:r><w:t>commented text</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
```

`comments.xml` also needs a relationship in `document.xml.rels` and an `Override` in `[Content_Types].xml`. `scripts/comment.py` adds all of these for you.

## Fields

A field has a begin mark, an instruction, a separate mark, the shown value, and an end mark.

```xml
<w:r><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
<w:r><w:fldChar w:fldCharType="separate"/></w:r>
<w:r><w:t>1</w:t></w:r>
<w:r><w:fldChar w:fldCharType="end"/></w:r>
```

Common instructions: `PAGE`, `NUMPAGES`, `DATE \@ "MMMM d, yyyy"`, `TOC \o "1-3" \h \z \u`, `SEQ Figure \* ARABIC`, `REF bookmark \h`. Add `<w:updateFields w:val="true"/>` to `word/settings.xml` to make Word update the fields when it opens the file.

## Footnotes

The reference in the text:

```xml
<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="2"/></w:r>
```

The note in `word/footnotes.xml`. IDs -1 and 0, or 0 and 1, are the separator notes. Do not change them. Use the next free ID.

```xml
<w:footnote w:id="2">
  <w:p>
    <w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>
    <w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>
    <w:r><w:t xml:space="preserve"> The text of the note.</w:t></w:r>
  </w:p>
</w:footnote>
```

If the document has no `footnotes.xml`, add the footnote with Word or with a template that has one. Making the part by hand needs the part, its relationship, its content type, and the separator notes.

## Hyperlinks

```xml
<w:hyperlink r:id="rId12" w:history="1">
  <w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>example.com</w:t></w:r>
</w:hyperlink>
```

`rId12` is a relationship with `TargetMode="External"` in `document.xml.rels`. A link inside the document uses `w:anchor="bookmarkName"` instead of `r:id`.

## Images

An image is a `w:drawing` in a run. It refers to the image part through `r:embed="rIdN"`. The size is in EMU in `wp:extent` and `a:ext`. Adding an image by hand needs the file in `word/media/`, a relationship, and a content type for the extension. Use python-docx (`add_picture`) instead when you can.

## Sections and pages

```xml
<w:sectPr>
  <w:headerReference w:type="default" r:id="rId8"/>
  <w:pgSz w:w="12240" w:h="15840"/>                 <!-- letter: 8.5 x 11 in. A4: 11906 x 16838 -->
  <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/>
</w:sectPr>
```

Landscape: add `w:orient="landscape"` to `w:pgSz` and swap `w:w` and `w:h`. A section break in the text is a `w:sectPr` in the `w:pPr` of the last paragraph of the section.

## Common errors

| Error | Cause |
|---|---|
| Word says the file is damaged. | XML that is not valid, a missing relationship, or a part with no content type. Run `ooxml.py check`. |
| Text has no spaces between words. | `xml:space="preserve"` is missing on a `w:t`. |
| A deleted text shows as normal text. | The text is in `w:t` inside `w:del`. Use `w:delText`. |
| Tracked changes disappear. | Two changes have the same `w:id`. |
| A list continues at the wrong number. | The paragraph uses the `w:numId` of another list. |
| A table is wider than the page. | The sum of the `w:gridCol` widths is more than the text width. |
