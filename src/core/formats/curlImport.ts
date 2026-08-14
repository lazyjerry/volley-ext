// curl 指令 → RequestItem。
// 關鍵陷阱：IGNORED_VALUE_ARGS 的參數必須「消耗其值但不匯入」，
// 否則該值會被誤判成 URL（例如 -o out.json 的 out.json）。

import type { BodyParam, Header, QueryParam, RequestItem } from '../model/types';
import { defaultSettings } from '../model/types';
import { genId } from '../model/ids';

/** shell 風格 tokenizer：支援單雙引號、跳脫字元、行接續反斜線。 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let hasToken = false;
  let i = 0;
  const s = command.replace(/\\\r?\n/g, ' ');
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") {
      hasToken = true;
      i++;
      while (i < s.length && s[i] !== "'") {
        cur += s[i++];
      }
      i++;
    } else if (ch === '"') {
      hasToken = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
          i++;
        }
        cur += s[i++];
      }
      i++;
    } else if (ch === '\\' && i + 1 < s.length) {
      hasToken = true;
      cur += s[i + 1];
      i += 2;
    } else if (/\s/.test(ch)) {
      if (hasToken || cur !== '') {
        tokens.push(cur);
        cur = '';
        hasToken = false;
      }
      i++;
    } else {
      hasToken = true;
      cur += s[i++];
    }
  }
  if (hasToken || cur !== '') {
    tokens.push(cur);
  }
  return tokens;
}

// 有值但不匯入的參數（必須消耗值）
const IGNORED_VALUE_ARGS = new Set([
  '-o', '--output',
  '-A', '--user-agent',
  '-e', '--referer',
  '-x', '--proxy',
  '-m', '--max-time',
  '--connect-timeout',
  '--retry',
  '--max-redirs',
  '--limit-rate',
  '--cacert',
  '-E', '--cert',
  '--key',
  '-T', '--upload-file',
  '-w', '--write-out',
  '-D', '--dump-header',
  '-r', '--range',
  '-C', '--continue-at',
  '-c', '--cookie-jar',
  '-K', '--config',
  '--resolve',
  '--connect-to',
  '--interface',
]);

// 無值的旗標（直接跳過）
const BOOLEAN_FLAGS = new Set([
  '-s', '--silent',
  '-v', '--verbose',
  '-k', '--insecure',
  '-L', '--location',
  '-i', '--include',
  '-f', '--fail',
  '-S', '--show-error',
  '--compressed',
  '--http1.1', '--http2',
  '-4', '-6',
  '-g', '--globoff',
]);

export function importCurl(command: string): RequestItem {
  const tokens = tokenize(command.trim());
  if (tokens.length === 0 || !/^curl(\.exe)?$/i.test(tokens[0])) {
    throw new Error('不是 curl 指令');
  }

  let url = '';
  let method = '';
  const headers: Header[] = [];
  const dataParts: string[] = [];
  const urlencodeParts: string[] = [];
  const formParams: BodyParam[] = [];
  let isGet = false;
  let isHead = false;
  let auth: RequestItem['authentication'] = {};
  let isBinary = false;

  let i = 1;
  const next = (): string => tokens[++i] ?? '';
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === '-X' || tok === '--request') {
      method = next().toUpperCase();
    } else if (tok === '-H' || tok === '--header') {
      const raw = next();
      const idx = raw.indexOf(':');
      if (idx > 0) {
        headers.push({ name: raw.slice(0, idx).trim(), value: raw.slice(idx + 1).trim() });
      }
    } else if (tok === '-u' || tok === '--user') {
      const raw = next();
      const idx = raw.indexOf(':');
      auth = {
        type: 'basic',
        username: idx >= 0 ? raw.slice(0, idx) : raw,
        password: idx >= 0 ? raw.slice(idx + 1) : '',
        disabled: false,
      };
    } else if (tok === '-b' || tok === '--cookie') {
      const raw = next();
      if (raw.includes('=')) {
        headers.push({ name: 'Cookie', value: raw });
      } // 檔案路徑形式忽略
    } else if (tok === '-d' || tok === '--data' || tok === '--data-raw' || tok === '--data-ascii') {
      dataParts.push(next());
    } else if (tok === '--data-urlencode') {
      urlencodeParts.push(next());
    } else if (tok === '--data-binary') {
      dataParts.push(next());
      isBinary = true;
    } else if (tok === '-F' || tok === '--form') {
      const raw = next();
      const idx = raw.indexOf('=');
      if (idx > 0) {
        const name = raw.slice(0, idx);
        const value = raw.slice(idx + 1);
        if (value.startsWith('@')) {
          formParams.push({ name, value: '', type: 'file', fileName: value.slice(1) });
        } else {
          formParams.push({ name, value });
        }
      }
    } else if (tok === '-G' || tok === '--get') {
      isGet = true;
    } else if (tok === '-I' || tok === '--head') {
      isHead = true;
    } else if (tok === '--url') {
      url = next();
    } else if (IGNORED_VALUE_ARGS.has(tok)) {
      next(); // 消耗值但不匯入
    } else if (BOOLEAN_FLAGS.has(tok)) {
      // 無值旗標，跳過
    } else if (tok.startsWith('-') && tok !== '-') {
      // 未知旗標：保守起見只跳過旗標本身
    } else if (url === '') {
      url = tok;
    }
    i++;
  }

  url = url.replace(/^['"]|['"]$/g, '');
  const parameters: QueryParam[] = [];

  const contentTypeHeader = headers.find((h) => h.name.toLowerCase() === 'content-type');
  const declaredType = contentTypeHeader?.value.split(';')[0].trim().toLowerCase();

  const body: RequestItem['body'] = {};
  const allData = [...dataParts, ...urlencodeParts];
  if (isGet && allData.length > 0) {
    // -G：data 轉為 query string
    for (const part of allData) {
      const idx = part.indexOf('=');
      if (idx >= 0) {
        parameters.push({ name: part.slice(0, idx), value: part.slice(idx + 1) });
      } else {
        parameters.push({ name: part, value: '' });
      }
    }
  } else if (formParams.length > 0) {
    body.mimeType = 'multipart/form-data';
    body.params = formParams;
  } else if (allData.length > 0) {
    const joined = allData.join('&');
    if (declaredType && declaredType !== 'application/x-www-form-urlencoded') {
      body.mimeType = declaredType;
      body.text = joined;
    } else if (isBinary && !declaredType) {
      body.mimeType = 'application/octet-stream';
      body.text = joined;
    } else {
      body.mimeType = 'application/x-www-form-urlencoded';
      body.params = joined.split('&').map((pair) => {
        const idx = pair.indexOf('=');
        return idx >= 0
          ? { name: pair.slice(0, idx), value: pair.slice(idx + 1) }
          : { name: pair, value: '' };
      });
    }
  }

  if (!method) {
    if (isHead) {
      method = 'HEAD';
    } else if (!isGet && (dataParts.length > 0 || urlencodeParts.length > 0 || formParams.length > 0)) {
      method = 'POST';
    } else {
      method = 'GET';
    }
  }

  // URL 中的 query string 拆進 parameters
  const qIdx = url.indexOf('?');
  if (qIdx >= 0) {
    const qs = url.slice(qIdx + 1);
    url = url.slice(0, qIdx);
    for (const pair of qs.split('&')) {
      if (pair === '') {
        continue;
      }
      const eq = pair.indexOf('=');
      parameters.push(
        eq >= 0
          ? { name: pair.slice(0, eq), value: pair.slice(eq + 1) }
          : { name: pair, value: '' },
      );
    }
  }

  return {
    kind: 'request',
    id: genId('req'),
    name: url || 'Imported from curl',
    sortKey: 0,
    method,
    url,
    parameters,
    pathParameters: [],
    headers,
    body,
    authentication: auth,
    settings: defaultSettings(),
  };
}
