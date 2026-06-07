// Minimal YAML frontmatter parser/serializer.
// Supports the tpm schema: scalars, flow lists ([a, b]), block lists, and
// single-level block mappings (key:\n  k: v). No multi-level nesting.

export interface Parsed {
  data: Record<string, unknown>;
  body: string;
}

export function parse(text: string): Parsed {
  const start = text.startsWith("---\r\n") ? 5 : text.startsWith("---\n") ? 4 : -1;
  if (start < 0) return { data: {}, body: text };
  const endRe = /\n---\s*(\r?\n|$)/;
  const m = endRe.exec(text.slice(start));
  if (!m) return { data: {}, body: text };
  const yaml = text.slice(start, start + m.index);
  let body = text.slice(start + m.index + m[0].length);
  if (body.startsWith("\n")) body = body.slice(1);
  return { data: parseYaml(yaml), body };
}

function parseYaml(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!m) { i++; continue; }
    const [, key, rest] = m;
    if (rest === "") {
      const items: unknown[] = [];
      const map: Record<string, unknown> = {};
      let kind: "list" | "map" | null = null;
      let j = i + 1;
      while (j < lines.length) {
        const ln = lines[j];
        if (!ln.trim()) { j++; continue; }
        const listM = ln.match(/^\s+-\s+(.*)$/);
        const mapM = ln.match(/^\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
        if (listM && (kind === null || kind === "list")) {
          kind = "list";
          items.push(parseValue(listM[1].trim()));
          j++;
        } else if (mapM && (kind === null || kind === "map")) {
          kind = "map";
          map[mapM[1]] = parseValue(mapM[2]);
          j++;
        } else break;
      }
      out[key] = kind === "list" ? items : kind === "map" ? map : null;
      i = j;
    } else {
      out[key] = parseValue(rest);
      i++;
    }
  }
  return out;
}

function parseValue(rest: string): unknown {
  if (rest === "") return null;
  if (rest.startsWith("[") && rest.endsWith("]")) {
    const inner = rest.slice(1, -1).trim();
    return inner === "" ? [] : splitFlow(inner).map(coerce);
  }
  return coerce(rest);
}

function splitFlow(s: string): string[] {
  const out: string[] = [];
  let depth = 0, inStr: string | null = null, buf = "";
  for (const c of s) {
    if (inStr) {
      buf += c;
      if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") {
      inStr = c; buf += c;
    } else if (c === "[" || c === "{") {
      depth++; buf += c;
    } else if (c === "]" || c === "}") {
      depth--; buf += c;
    } else if (c === "," && depth === 0) {
      out.push(buf.trim()); buf = "";
    } else {
      buf += c;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function coerce(v: string): unknown {
  if (v === "" || v === "null" || v === "~") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

export function stringify(data: Record<string, unknown>, body: string): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      lines.push(`${key}:`);
    } else if (Array.isArray(value)) {
      lines.push(value.length === 0
        ? `${key}: []`
        : `${key}: [${value.map(formatScalar).join(", ")}]`);
    } else if (typeof value === "object") {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${k}: ${formatScalar(v)}`);
      }
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  lines.push("---");
  lines.push("");
  const trimmedBody = body.startsWith("\n") ? body : "\n" + body;
  return lines.join("\n") + trimmedBody;
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    if (v === "") return '""';
    if (/^[A-Za-z0-9_./:-][A-Za-z0-9_ ./:@#-]*$/.test(v) && !/^\s|\s$/.test(v)) return v;
    return JSON.stringify(v);
  }
  return String(v);
}
