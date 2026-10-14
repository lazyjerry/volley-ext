// Body 美化：依 MIME 重排文字內容。不合法就丟 Error，由呼叫端提示使用者。

import { parseDocument } from 'yaml';
import { TEMPLATE_RE } from '../vars/template';

/**
 * `{{ }}`／`{% %}` 片段不是合法 JSON，先換成佔位字串再 parse，排版後原樣放回。
 * 片段在字串常值外（`"id": {{ _.x }}`）要連引號一起換，在字串內（`"a {{ _.x }}"`）只換片段本身，
 * 兩種用不同前綴，還原時才分得出引號是佔位帶進來的還是原文的。
 */
export function prettyJson(text: string): string {
  const fragments: string[] = [];
  let masked = '';
  let cursor = 0;
  let inString = false;
  for (const match of text.matchAll(TEMPLATE_RE)) {
    const gap = text.slice(cursor, match.index);
    inString = scanStringState(gap, inString);
    const n = fragments.push(match[0]) - 1;
    masked += gap + (inString ? `__volley_s${n}__` : `"__volley_v${n}__"`);
    cursor = match.index + match[0].length;
  }
  masked += text.slice(cursor);
  const pretty = JSON.stringify(JSON.parse(masked), null, 2);
  return pretty
    .replace(/"__volley_v(\d+)__"/g, (_, n: string) => fragments[Number(n)])
    .replace(/__volley_s(\d+)__/g, (_, n: string) => fragments[Number(n)]);
}

/** 走過一段 JSON 原文，回傳結尾是否停在字串常值內。 */
function scanStringState(src: string, inString: boolean): boolean {
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    }
  }
  return inString;
}

export function prettyYaml(text: string): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(doc.errors[0].message);
  }
  return String(doc);
}

type XmlToken =
  | { kind: 'open'; text: string; name: string }
  | { kind: 'close'; text: string; name: string }
  | { kind: 'self'; text: string; name: string }
  | { kind: 'text'; text: string }
  | { kind: 'other'; text: string };

/** 掃過 XML 並在標籤邊界斷行；標籤配對不上就丟 Error。 */
export function prettyXml(text: string): string {
  const tokens = tokenizeXml(text.trim());
  const stack: string[] = [];
  const lines: string[] = [];
  let depth = 0;
  let hasElement = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'text' || token.kind === 'other') {
      lines.push('  '.repeat(depth) + token.text);
      continue;
    }
    if (token.kind === 'self') {
      hasElement = true;
      lines.push('  '.repeat(depth) + token.text);
      continue;
    }
    if (token.kind === 'open') {
      hasElement = true;
      // <a>text</a> 這種只含單一文字的元素留在同一行
      const next = tokens[i + 1];
      const after = tokens[i + 2];
      if (next?.kind === 'text' && after?.kind === 'close' && after.name === token.name) {
        lines.push('  '.repeat(depth) + token.text + next.text + after.text);
        i += 2;
        continue;
      }
      if (next?.kind === 'close' && next.name === token.name) {
        lines.push('  '.repeat(depth) + token.text + next.text);
        i += 1;
        continue;
      }
      stack.push(token.name);
      lines.push('  '.repeat(depth) + token.text);
      depth++;
      continue;
    }
    const open = stack.pop();
    if (open !== token.name) {
      throw new Error(open ? `結束標籤 </${token.name}> 與 <${open}> 不成對` : `多餘的結束標籤 </${token.name}>`);
    }
    depth--;
    lines.push('  '.repeat(depth) + token.text);
  }

  if (stack.length > 0) {
    throw new Error(`標籤 <${stack[stack.length - 1]}> 未關閉`);
  }
  if (!hasElement) {
    throw new Error('找不到任何 XML 元素');
  }
  return lines.join('\n');
}

/** 註解 / CDATA / DOCTYPE 有各自的結束符，其餘標籤要略過引號內的 '>'。 */
const XML_SPANS: Array<[string, string]> = [
  ['<!--', '-->'],
  ['<![CDATA[', ']]>'],
  ['<!', '>'],
  ['<?', '?>'],
];

function tokenizeXml(src: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '<') {
      const next = src.indexOf('<', i);
      const end = next === -1 ? src.length : next;
      const raw = src.slice(i, end).trim();
      if (raw !== '') {
        tokens.push({ kind: 'text', text: raw });
      }
      i = end;
      continue;
    }
    const span = XML_SPANS.find(([start]) => src.startsWith(start, i));
    if (span) {
      const end = src.indexOf(span[1], i + span[0].length);
      if (end === -1) {
        throw new Error(`未閉合的 ${span[0]} 區塊`);
      }
      tokens.push({ kind: 'other', text: src.slice(i, end + span[1].length) });
      i = end + span[1].length;
      continue;
    }
    const end = findTagEnd(src, i);
    const text = src.slice(i, end + 1);
    const match = /^<\/?\s*([^\s/>]+)/.exec(text);
    if (!match) {
      throw new Error(`無法解析的標籤：${text.slice(0, 20)}`);
    }
    const name = match[1];
    if (text.startsWith('</')) {
      tokens.push({ kind: 'close', text, name });
    } else if (text.endsWith('/>')) {
      tokens.push({ kind: 'self', text, name });
    } else {
      tokens.push({ kind: 'open', text, name });
    }
    i = end + 1;
  }
  return tokens;
}

function findTagEnd(src: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote !== '') {
      if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') {
      return i;
    }
  }
  throw new Error('標籤未以 > 結束');
}
