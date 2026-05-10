// Tiny markdown subset for `tpm serve` task bodies. Same ethos as the YAML
// parser: extending the in-tree implementation is cheaper than adding a
// dependency. Covers what task bodies actually use:
//
//   - ATX headings (`#` … `######`)
//   - Paragraphs (blank-line separated)
//   - Unordered lists (`-`/`*`/`+`); single-level nesting via 2/4-space indent
//   - Ordered lists (`N.`)
//   - Fenced code blocks (```)
//   - Inline: `code`, [text](url), **bold**, *italic*
//
// Not supported: tables, footnotes, blockquotes nested in lists, raw HTML,
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
      !isListLine(lines[i])
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
  work = work.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) =>
    stash(`<a href="${escAttr(url)}">${esc(text)}</a>`),
  );
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
