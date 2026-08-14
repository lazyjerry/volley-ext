// RequestItem → curl 指令字串（自寫 generator，不引入 httpsnippet）。
// 變數插值由呼叫端先行處理（傳入已解析的環境資料）。

import type { RequestItem } from '../model/types';
import { interpolate } from '../vars/template';

function shellQuote(value: string): string {
  if (value === '') {
    return "''";
  }
  if (/^[\w@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function exportCurl(request: RequestItem, env: Record<string, unknown> = {}): string {
  const r = (s: string): string => interpolate(s, env).result;
  const parts: string[] = ['curl'];

  const query = request.parameters
    .filter((p) => !p.disabled)
    .map((p) => `${encodeURIComponent(r(p.name))}=${encodeURIComponent(r(p.value))}`)
    .join('&');
  let url = r(request.url);
  if (query) {
    url += (url.includes('?') ? '&' : '?') + query;
  }

  if (request.method !== 'GET' || request.body.mimeType) {
    if (request.method === 'HEAD') {
      parts.push('-I');
    } else if (request.method !== 'GET') {
      parts.push(`-X ${request.method}`);
    }
  }
  parts.push(shellQuote(url));

  for (const h of request.headers) {
    if (!h.disabled) {
      parts.push(`-H ${shellQuote(`${r(h.name)}: ${r(h.value)}`)}`);
    }
  }

  const auth = request.authentication;
  if (auth.type === 'basic' && auth.disabled !== true) {
    parts.push(`-u ${shellQuote(`${r(String(auth.username ?? ''))}:${r(String(auth.password ?? ''))}`)}`);
  } else if (auth.type === 'bearer' && auth.disabled !== true) {
    const prefix = String(auth.prefix ?? '') || 'Bearer';
    parts.push(`-H ${shellQuote(`Authorization: ${prefix} ${r(String(auth.token ?? ''))}`)}`);
  } else if (auth.type === 'apikey' && auth.disabled !== true) {
    if ((auth.addTo ?? 'header') === 'header') {
      parts.push(`-H ${shellQuote(`${String(auth.key ?? '')}: ${r(String(auth.value ?? ''))}`)}`);
    }
  }

  const body = request.body;
  if (body.mimeType === 'application/x-www-form-urlencoded' && body.params) {
    for (const p of body.params) {
      if (!p.disabled) {
        parts.push(`--data-urlencode ${shellQuote(`${r(p.name)}=${r(p.value)}`)}`);
      }
    }
  } else if (body.mimeType === 'multipart/form-data' && body.params) {
    for (const p of body.params) {
      if (p.disabled) {
        continue;
      }
      if (p.type === 'file' && p.fileName) {
        parts.push(`-F ${shellQuote(`${r(p.name)}=@${p.fileName}`)}`);
      } else {
        parts.push(`-F ${shellQuote(`${r(p.name)}=${r(p.value)}`)}`);
      }
    }
  } else if (body.text) {
    if (!request.headers.some((h) => h.name.toLowerCase() === 'content-type') && body.mimeType) {
      parts.push(`-H ${shellQuote(`Content-Type: ${body.mimeType}`)}`);
    }
    parts.push(`--data-raw ${shellQuote(r(body.text))}`);
  }

  return parts.join(' \\\n  ');
}
