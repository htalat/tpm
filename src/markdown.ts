// Tiny markdown subset for `tpm serve` task bodies. Same ethos as the YAML
// parser: extending the in-tree implementation is cheaper than adding a
// dependency. Covers what task bodies actually use:
//
//   - ATX headings (`#` … `######`)
//   - Paragraphs (blank-line separated)
//   - Unordered lists (`-`/`*`/`+`); single-level nesting via 2/4-space indent
//   - Ordered lists (`N.`)
//   - Fenced code blocks (```)
//   - GFM tables (`| a | b |` header + `| --- | :-: |` separator + body rows;
//     leading/trailing pipes optional, `\|` escapes a literal pipe, `:` markers
//     set per-column alignment)
//   - Inline: `code`, [text](url), **bold**, *italic*
//
// Not supported: footnotes, blockquotes nested in lists, raw HTML,
// reference-style links, autolinks. If you find yourself wanting one, write
// it in HTML in the body or extend this file.

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const langAttr = lang ? ` class="language-${esc(lang)}"` : "";
      out.push(`<pre><code${langAttr}>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // ATX heading.
    const hMatch = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level}>${renderInline(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // List (consume contiguous list lines).
    if (isListLine(line)) {
      const { html, consumed } = renderList(lines, i);
      out.push(html);
      i += consumed;
      continue;
    }

    // GFM table (header row + separator row + body rows). Checked before the
    // paragraph fallback so a header-shaped line isn't eaten as prose first.
    if (isTableStart(lines, i)) {
      const { html, consumed } = renderTable(lines, i);
      out.push(html);
      i += consumed;
      continue;
    }

    // Blank line → paragraph break / section padding (we just skip).
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Paragraph: gather contiguous non-blank, non-special lines.
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !isListLine(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(buf.join(" "))}</p>`);
  }

  return out.join("\n");
}

function isListLine(line: string): boolean {
  return /^\s*([-*+]|\d+\.)\s+/.test(line);
}

interface ListItem { content: string; children: ListItem[] }

function renderList(lines: string[], start: number): { html: string; consumed: number } {
  // Determine the list type from the first line.
  const first = lines[start];
  const ordered = /^\s*\d+\.\s+/.test(first);
  const baseIndent = first.match(/^(\s*)/)?.[1].length ?? 0;
  const items: ListItem[] = [];
  let i = start;

  while (i < lines.length && isListLine(lines[i]) && (lines[i].match(/^(\s*)/)?.[1].length ?? 0) >= baseIndent) {
    const line = lines[i];
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent === baseIndent) {
      const content = line.replace(/^\s*([-*+]|\d+\.)\s+/, "");
      items.push({ content, children: [] });
      i++;
    } else if (indent > baseIndent && items.length > 0) {
      const sub = renderList(lines, i);
      // Attach as a string child rendered list — we serialize directly.
      items[items.length - 1].children.push({ content: sub.html, children: [] });
      i += sub.consumed;
    } else {
      break;
    }
  }

  const tag = ordered ? "ol" : "ul";
  const itemsHtml = items.map(it => {
    const children = it.children.map(c => c.content).join("");
    return `<li>${renderInline(it.content)}${children}</li>`;
  }).join("");
  return { html: `<${tag}>${itemsHtml}</${tag}>`, consumed: i - start };
}

// A table starts where a header-shaped line is immediately followed by a
// separator row (`| --- | :-: |`). Requiring the separator on lookahead keeps
// a lone `| foo |` line from being misread as a one-row table.
function isTableStart(lines: string[], i: number): boolean {
  if (i + 1 >= lines.length) return false;
  if (!lines[i].includes("|")) return false;
  return isSeparatorRow(lines[i + 1]);
}

function isSeparatorRow(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

// Split a table row into trimmed cells. Leading/trailing pipes are optional;
// `\|` is an escaped literal pipe and stays inside the cell.
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
      continue;
    }
    if (s[k] === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += s[k];
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

function alignAttr(sep: string): string {
  const left = sep.startsWith(":");
  const right = sep.endsWith(":");
  const align = left && right ? "center" : right ? "right" : left ? "left" : "";
  return align ? ` style="text-align:${align}"` : "";
}

function renderTable(lines: string[], start: number): { html: string; consumed: number } {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map(alignAttr);
  const cols = header.length;
  const cell = (tag: string, content: string, c: number): string =>
    `<${tag}${aligns[c] ?? ""}>${renderInline(content ?? "")}</${tag}>`;

  const thead = `<thead><tr>${header.map((h, c) => cell("th", h, c)).join("")}</tr></thead>`;

  let i = start + 2;
  const rows: string[] = [];
  while (i < lines.length && !/^\s*$/.test(lines[i]) && lines[i].includes("|")) {
    const row = splitRow(lines[i]);
    const tds = Array.from({ length: cols }, (_v, c) => cell("td", row[c], c)).join("");
    rows.push(`<tr>${tds}</tr>`);
    i++;
  }
  const tbody = `<tbody>${rows.join("")}</tbody>`;

  return { html: `<table>${thead}${tbody}</table>`, consumed: i - start };
}

// Inline pass: code spans first (so their contents aren't reprocessed),
// then links, then emphasis. Done with placeholders to avoid re-matching
// over already-rendered output.
function renderInline(s: string): string {
  const placeholders: string[] = [];
  const stash = (html: string): string => {
    placeholders.push(html);
    return `\x00${placeholders.length - 1}\x00`;
  };

  // Inline code.
  let work = s.replace(/`([^`\n]+)`/g, (_m, code) => stash(`<code>${esc(code)}</code>`));
  // Links: [text](url). url may not contain ) or whitespace.
  // External links (anything not `/` or `#`-prefixed) open in a new tab with
  // safe rel — keeps task bodies that link to PRs from blowing away the
  // dashboard tab on click.
  work = work.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    const attrs = isExternalHref(url) ? ` target="_blank" rel="noopener noreferrer"` : "";
    return stash(`<a href="${escAttr(url)}"${attrs}>${esc(text)}</a>`);
  });
  // Now escape what's left, then re-apply emphasis.
  work = esc(work);
  // Emphasis (bold then italic, on escaped text — placeholders use \x00 so
  // they survive escape).
  work = work.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  work = work.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  // Restore placeholders.
  return work.replace(/\x00(\d+)\x00/g, (_m, idx) => placeholders[Number(idx)]);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function escAttr(s: string): string {
  // Same as esc; kept separate so we can tighten later (e.g. URL whitelist).
  return esc(s);
}

function isExternalHref(url: string): boolean {
  return !url.startsWith("/") && !url.startsWith("#");
}
