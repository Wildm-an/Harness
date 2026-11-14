// Page breaks of a Word file in the Preview pane. docx-preview breaks a page only at a page break or
// a section break of the file, so a long section shows as one tall page. Word breaks a page when
// the text gets to the bottom margin. paginateDocx does that in the browser: it measures each page
// and moves the content below the bottom margin to a new page, as many times as necessary.
//
// The content moves in this order of preference:
// 1. The lines of a paragraph (at least 2 lines stay on each page, as the widow control of Word).
// 2. The rows of a table.
// 3. A full block. A heading moves with the block after it.
//
// All measurements use getBoundingClientRect, so they are correct when the view has a CSS zoom.

/** The marker class of the second part of a paragraph that a page break divides. */
export const CONTINUED_CLASS = "docx-continued";

const MAX_PAGES = 2000; // A stop for a file that the code cannot divide.

/** Divide each page of a docx-preview render that is taller than its page size. */
export function paginateDocx(root: HTMLElement): void {
  let count = 0;
  for (const page of [...root.querySelectorAll<HTMLElement>("section.docx")]) {
    let current: HTMLElement | null = page;
    while (current && count < MAX_PAGES) {
      current = splitPage(current);
      count++;
    }
  }
}

/** The height of a CSS length (for example "11in") in client pixels, in the coordinates of `inside`. */
function measureLength(length: string, inside: HTMLElement): number {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;left:0;top:0;width:1px;visibility:hidden;height:${length}`;
  inside.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return height;
}

/**
 * Move the content below the bottom margin of `page` to a new page after it. Return the new page,
 * or null when the page fits or the code cannot divide it.
 */
function splitPage(page: HTMLElement): HTMLElement | null {
  const pageSize = page.style.minHeight;
  if (!pageSize) return null;
  const article = page.querySelector<HTMLElement>(":scope > article");
  if (!article || article.children.length === 0) return null;
  // The code does not measure text in columns: a page with columns stays as it is.
  if ((parseInt(getComputedStyle(article).columnCount, 10) || 1) > 1) return null;

  const pageHeight = measureLength(pageSize, page);
  const pageBox = page.getBoundingClientRect();
  if (pageHeight <= 0 || pageBox.height <= pageHeight + 1) return null;

  // Below the text: the footnotes, the footer, and the bottom margin. Their height does not change.
  const tail = pageBox.bottom - article.getBoundingClientRect().bottom;
  const limit = pageBox.top + pageHeight - tail;

  const blocks = [...article.children] as HTMLElement[];
  const index = blocks.findIndex((b) => b.getBoundingClientRect().bottom > limit + 0.5 && !isFloating(b));
  if (index < 0) return null;

  const block = blocks[index];
  let moved: Node[];
  const part = block.tagName === "TABLE" ? splitTable(block as HTMLTableElement, limit)
    : block.tagName === "P" ? splitParagraph(block, limit)
    : null;
  if (part) {
    moved = [part, ...blocks.slice(index + 1)];
  } else if (index === 0) {
    // One block is taller than the page. It stays on this page, and the next blocks move.
    if (blocks.length === 1) return null;
    moved = blocks.slice(1);
  } else {
    // A heading stays with the block after it, as "Keep with next" in Word.
    let start = index;
    while (start > 1 && isHeading(blocks[start - 1])) start--;
    moved = blocks.slice(start);
  }

  const next = page.cloneNode(false) as HTMLElement;
  const body = article.cloneNode(false) as HTMLElement;
  body.append(...moved);
  for (const child of [...page.children]) {
    if (child === article) next.appendChild(body);
    else if (child.tagName === "HEADER" || child.tagName === "FOOTER") next.appendChild(child.cloneNode(true));
    else next.appendChild(child); // The notes go to the last page of the section.
  }
  page.after(next);
  return next;
}

function isFloating(el: HTMLElement): boolean {
  const position = getComputedStyle(el).position;
  return position === "absolute" || position === "fixed";
}

/** A heading: an h1 to h6, or a paragraph with a Heading or Title style ("docx_heading1"). */
function isHeading(el: HTMLElement): boolean {
  if (/^H[1-6]$/.test(el.tagName)) return true;
  return el.tagName === "P" && [...el.classList].some((c) => /heading|title/i.test(c));
}

/** Move the rows of `table` below `limit` to a new table, and return it. Null if no row fits. */
function splitTable(table: HTMLTableElement, limit: number): HTMLTableElement | null {
  const rows = [...table.rows].filter((r) => r.closest("table") === table);
  const index = rows.findIndex((r) => r.getBoundingClientRect().bottom > limit + 0.5);
  if (index <= 0) return null;
  const rest = table.cloneNode(false) as HTMLTableElement;
  for (const col of table.querySelectorAll(":scope > colgroup")) rest.appendChild(col.cloneNode(true));
  // A row in a tbody moves to a copy of that tbody.
  const groups = new Map<Element, Element>();
  for (const row of rows.slice(index)) {
    const parent = row.parentElement!;
    if (parent === table) {
      rest.appendChild(row);
      continue;
    }
    let group = groups.get(parent);
    if (!group) {
      group = parent.cloneNode(false) as Element;
      groups.set(parent, group);
      rest.appendChild(group);
    }
    group.appendChild(row);
  }
  return rest;
}

/** A character position in a paragraph. */
type Spot = { node: Text; offset: number };

/** The lines of a paragraph, as client rectangles in reading order. */
function lineBoxes(p: HTMLElement): { top: number; bottom: number }[] {
  const lines: { top: number; bottom: number }[] = [];
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.height <= 0) continue;
      const last = lines[lines.length - 1];
      // A rectangle that starts above the middle of the last line is on that line.
      if (last && r.top < (last.top + last.bottom) / 2) last.bottom = Math.max(last.bottom, r.bottom);
      else lines.push({ top: r.top, bottom: r.bottom });
    }
  }
  return lines;
}

/** The first character with its top at or below `y`, or null. */
function firstCharBelow(p: HTMLElement, y: number): Spot | null {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).length > 0) nodes.push(n as Text);
  const range = document.createRange();
  const top = (node: Text, offset: number): number => {
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const rects = [...range.getClientRects()].filter((r) => r.height > 0);
    return rects.length ? rects[rects.length - 1].top : Number.NEGATIVE_INFINITY;
  };
  for (const node of nodes) {
    if (top(node, node.length - 1) < y) continue;
    // The tops go down in reading order: a binary search finds the first one below y.
    let lo = 0;
    let hi = node.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (top(node, mid) >= y) hi = mid;
      else lo = mid + 1;
    }
    return { node, offset: lo };
  }
  return null;
}

/**
 * Move the lines of `p` below `limit` to a new paragraph, and return it. Null when fewer than 2
 * lines fit, or when fewer than 2 lines move.
 */
function splitParagraph(p: HTMLElement, limit: number): HTMLElement | null {
  const lines = lineBoxes(p);
  let fit = lines.findIndex((l) => l.bottom > limit + 0.5);
  if (fit < 0) return null;
  if (lines.length - fit < 2) fit = lines.length - 2;
  if (fit < 2) return null;
  const spot = firstCharBelow(p, lines[fit].top - 0.5);
  if (!spot) return null;
  const range = document.createRange();
  range.setStart(spot.node, spot.offset);
  range.setEnd(p, p.childNodes.length);
  const rest = p.cloneNode(false) as HTMLElement;
  rest.appendChild(range.extractContents());
  // The second part has no first-line indent, no list number, and no space above.
  rest.classList.add(CONTINUED_CLASS);
  rest.style.textIndent = "0";
  rest.style.marginTop = "0";
  p.style.marginBottom = "0";
  return rest;
}
