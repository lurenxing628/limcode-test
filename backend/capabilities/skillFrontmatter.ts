/**
 * SKILL.md frontmatter 解析：只依赖 Node 内置能力，覆盖技能文件实际用到的 YAML 子集——
 * 顶层映射、单/双引号字符串（可跨行）、`|` / `>` 块标量（含 `-`/`+` 与缩进指示符）、多行普通标量、
 * 行尾 `#` 注释、块列表与行内 `[a, b]` 列表、嵌套映射（如 `metadata:`、openai.yaml 的 `policy:`）。
 * 值一律保持字符串，由调用方按需解释布尔值。不认识的写法原样保留为字符串，不抛错。
 */
export type YamlValue = string | null | YamlValue[] | { [key: string]: YamlValue };

export interface ParsedSkillFile {
  data: Record<string, YamlValue>;
  /** frontmatter 之后的正文；没有 frontmatter 时为整个文件（去掉 BOM）。 */
  body: string;
}

const FRONTMATTER_PATTERN = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const BLOCK_SCALAR_PATTERN = /^([|>])([1-9]?[+-]?|[+-][1-9]?)[ \t]*(?:#.*)?$/;

export function parseSkillFrontmatter(raw: string): ParsedSkillFile {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) return { data: {}, body: raw.replace(/^﻿/, '') };
  const data = parseMapping((match[1] ?? '').split(/\r?\n/));
  return { data: isMapping(data) ? data : {}, body: raw.slice(match[0].length) };
}

export function yamlText(value: YamlValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function yamlBoolean(value: YamlValue | undefined): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
  if (['false', 'no', 'off', '0'].includes(normalized)) return false;
  return undefined;
}

export function yamlMapping(value: YamlValue | undefined): Record<string, YamlValue> | undefined {
  return isMapping(value) ? value : undefined;
}

function isMapping(value: YamlValue | undefined): value is Record<string, YamlValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isIgnorable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

function indentOf(line: string): number {
  return line.length - line.replace(/^[ \t]+/, '').length;
}

function parseMapping(lines: readonly string[]): Record<string, YamlValue> {
  const result: Record<string, YamlValue> = {};
  const significant = lines.filter((line) => !isIgnorable(line));
  if (significant.length === 0) return result;
  const baseIndent = Math.min(...significant.map(indentOf));
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (isIgnorable(line) || indentOf(line) !== baseIndent) continue;
    const entry = splitKeyValue(line.slice(baseIndent));
    if (!entry) continue;
    const children: string[] = [];
    const inline = entry.value;
    while (index < lines.length) {
      const next = lines[index];
      const nestedSequence = inline === '' && !isBlank(next) && indentOf(next) === baseIndent && /^-(\s|$)/.test(next.trim());
      if (!isBlank(next) && indentOf(next) <= baseIndent && !nestedSequence) break;
      children.push(next);
      index += 1;
    }
    result[entry.key] = parseValue(inline, children, baseIndent);
  }
  return result;
}

/**
 * `key: value` of one mapping line: the key ends at the first colon followed by a blank or the end of
 * the line (so `Use when: x` stays one value and URLs keep their colons). Linear in the line length.
 */
function splitKeyValue(line: string): { key: string; value: string } | undefined {
  const first = line[0];
  if (first === undefined || first === '#' || first === '-' && /^-(\s|$)/.test(line)) return undefined;
  if (first === '"' || first === "'") {
    const close = quotedEnd(line);
    if (close === -1) return undefined;
    const rest = line.slice(close + 1);
    const colon = /^[ \t]*:(?:[ \t]+|$)/.exec(rest);
    return colon ? { key: unquoteKey(line.slice(0, close + 1)), value: rest.slice(colon[0].length).trim() } : undefined;
  }
  for (let index = line.indexOf(':'); index !== -1; index = line.indexOf(':', index + 1)) {
    const next = line[index + 1];
    if (next !== undefined && next !== ' ' && next !== '\t') continue;
    const key = line.slice(0, index).trimEnd();
    if (!key || /[ \t]#/.test(key)) return undefined;
    return { key, value: line.slice(index + 1).trim() };
  }
  return undefined;
}

/** Index of the quote closing the quoted scalar that starts the line, or -1. */
function quotedEnd(line: string): number {
  const quote = line[0];
  for (let index = 1; index < line.length; index += 1) {
    if (quote === '"' && line[index] === '\\') {
      index += 1;
      continue;
    }
    if (line[index] !== quote) continue;
    if (quote === "'" && line[index + 1] === "'") {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

function unquoteKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.startsWith('"')) return parseDoubleQuoted(trimmed);
  if (trimmed.startsWith("'")) return parseSingleQuoted(trimmed);
  return trimmed;
}

function parseValue(inline: string, children: readonly string[], parentIndent: number): YamlValue {
  if (inline === '' || inline.startsWith('#')) {
    const significant = children.filter((line) => !isIgnorable(line));
    if (significant.length === 0) return null;
    const first = significant[0].trim();
    if (/^-(\s|$)/.test(first)) return parseSequence(children);
    if (splitKeyValue(first)) return parseMapping(children);
    // The value itself on the following, indented lines (`description:` then `  "text"`).
    const lines = children.map((line) => line.trim());
    while (lines.length > 0 && lines[0] === '') lines.shift();
    if (first.startsWith('"')) return parseDoubleQuoted(foldQuotedLines(lines.join('\n')));
    if (first.startsWith("'")) return parseSingleQuoted(foldQuotedLines(lines.join('\n')));
    return parsePlain('', children);
  }
  const block = BLOCK_SCALAR_PATTERN.exec(inline);
  if (block) return parseBlockScalar(block[1] as '|' | '>', block[2], children, parentIndent);
  const joined = [inline, ...children.map((line) => line.trim())].join('\n');
  if (inline.startsWith('"')) return parseDoubleQuoted(foldQuotedLines(joined));
  if (inline.startsWith("'")) return parseSingleQuoted(foldQuotedLines(joined));
  if (inline.startsWith('[')) return parseFlowSequence(joined.replace(/\n/g, ' '));
  return parsePlain(inline, children);
}

function parsePlain(inline: string, children: readonly string[]): YamlValue {
  const parts = [stripComment(inline)];
  let blankRun = 0;
  for (const line of children) {
    if (isBlank(line)) {
      blankRun += 1;
      continue;
    }
    parts.push(blankRun > 0 ? `\n${stripComment(line.trim())}` : ` ${stripComment(line.trim())}`);
    blankRun = 0;
  }
  const value = parts.join('').trim();
  return ['~', 'null', 'Null', 'NULL'].includes(value) ? null : value;
}

function stripComment(value: string): string {
  return value.replace(/(^|[ \t])#.*$/, '').trimEnd();
}

function parseBlockScalar(style: '|' | '>', header: string, children: readonly string[], parentIndent: number): string {
  const explicit = /[1-9]/.exec(header)?.[0];
  const chomping = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
  const significant = children.filter((line) => !isBlank(line));
  const indent = explicit
    ? parentIndent + Number(explicit)
    : significant.length > 0 ? Math.min(...significant.map(indentOf)) : parentIndent + 1;
  const lines = children.map((line) => (isBlank(line) ? '' : line.slice(Math.min(indent, indentOf(line)))));
  let trailing = 0;
  while (trailing < lines.length && lines[lines.length - 1 - trailing] === '') trailing += 1;
  const content = lines.slice(0, lines.length - trailing);
  let text: string;
  if (style === '|') {
    text = content.join('\n');
  } else {
    text = '';
    let previous: 'none' | 'text' | 'blank' | 'more' = 'none';
    for (const line of content) {
      if (line === '') {
        text += '\n';
        previous = 'blank';
        continue;
      }
      const more = /^[ \t]/.test(line);
      if (previous === 'text' && !more) text += ' ';
      else if (previous === 'more' || (previous === 'text' && more)) text += '\n';
      text += line;
      previous = more ? 'more' : 'text';
    }
  }
  if (chomping === 'strip' || content.length === 0) return text;
  return chomping === 'keep' ? `${text}\n${'\n'.repeat(trailing)}` : `${text}\n`;
}

/** 引号字符串跨行时，行尾换行折叠成空格，空行变成换行。 */
function foldQuotedLines(value: string): string {
  return value.split('\n').reduce((folded, line, index) => {
    if (index === 0) return line;
    if (line === '') return `${folded}\n`;
    return folded.endsWith('\n') ? `${folded}${line}` : `${folded} ${line}`;
  }, '');
}

function parseDoubleQuoted(value: string): string {
  let result = '';
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') return result;
    if (char !== '\\') {
      result += char;
      continue;
    }
    const next = value[index + 1];
    index += 1;
    switch (next) {
      case 'n': result += '\n'; break;
      case 't': result += '\t'; break;
      case 'r': result += '\r'; break;
      case '0': result += '\0'; break;
      case ' ': result += ' '; break;
      case 'x': result += String.fromCharCode(parseInt(value.slice(index + 1, index + 3), 16)); index += 2; break;
      case 'u': result += String.fromCharCode(parseInt(value.slice(index + 1, index + 5), 16)); index += 4; break;
      case undefined: break;
      default: result += next;
    }
  }
  return result;
}

function parseSingleQuoted(value: string): string {
  let result = '';
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'") {
      if (value[index + 1] !== "'") return result;
      index += 1;
    }
    result += char;
  }
  return result;
}

function parseFlowSequence(value: string): YamlValue[] {
  const inner = value.trim().replace(/^\[/, '').replace(/\][^\]]*$/, '');
  const items: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ',') {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  items.push(current);
  return items.map((item) => item.trim()).filter(Boolean).map((item) =>
    item.startsWith('"') ? parseDoubleQuoted(item) : item.startsWith("'") ? parseSingleQuoted(item) : item);
}

function parseSequence(lines: readonly string[]): YamlValue[] {
  const significant = lines.filter((line) => !isIgnorable(line));
  const itemIndent = Math.min(...significant.map(indentOf));
  const items: YamlValue[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (isIgnorable(line) || indentOf(line) !== itemIndent || !/^-(\s|$)/.test(line.trim())) continue;
    const children: string[] = [];
    while (index < lines.length && (isBlank(lines[index]) || indentOf(lines[index]) > itemIndent)) {
      children.push(lines[index]);
      index += 1;
    }
    const rest = line.trim().slice(1).trim();
    const nestedKey = splitKeyValue(rest);
    items.push(nestedKey && !rest.startsWith('"') && !rest.startsWith("'")
      ? parseMapping([`${' '.repeat(itemIndent + 2)}${rest}`, ...children])
      : parseValue(rest, children, itemIndent));
  }
  return items;
}
