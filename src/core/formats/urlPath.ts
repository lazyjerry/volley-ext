// URL ⇄ OpenAPI path 轉換與投影規則。
// 目標：能投影的 request 進 paths.{path}.{method}，其餘進 x-volley.extraRequests。

import { interpolate } from '../vars/template';
import type { Collection } from '../model/types';

/** 去掉 query/fragment 的 URL 主體與 query 字串。 */
export function splitQuery(url: string): { main: string; query: string } {
  const hashIdx = url.indexOf('#');
  const noHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const qIdx = noHash.indexOf('?');
  if (qIdx < 0) {
    return { main: noHash, query: '' };
  }
  return { main: noHash.slice(0, qIdx), query: noHash.slice(qIdx + 1) };
}

/**
 * 收集可作為 base URL 的字首候選：collection.servers + base 環境中值形如 http(s)://
 * 的變數（以 `{{ _.name }}` 與 `{{ name }}` 兩種模板形式比對）。
 */
export function basePrefixCandidates(collection: Collection): Array<{ prefix: string; server: string }> {
  const out: Array<{ prefix: string; server: string }> = [];
  for (const server of collection.servers) {
    out.push({ prefix: server, server });
  }
  for (const [key, value] of Object.entries(collection.environments.base.data)) {
    if (typeof value === 'string' && /^https?:\/\//.test(value)) {
      out.push({ prefix: `{{ _.${key} }}`, server: value });
      out.push({ prefix: `{{_.${key}}}`, server: value });
      out.push({ prefix: `{{ ${key} }}`, server: value });
      out.push({ prefix: `{{${key}}}`, server: value });
    }
  }
  // 長字首優先，避免 https://a 誤吃 https://a/b 的情況
  return out.sort((a, b) => b.prefix.length - a.prefix.length);
}

const TEMPLATE_SEG_RE = /\{\{\s*_?\.?\s*([^{}]*?)\s*\}\}/g;

/** 將 path 中的 `{{ _.x }}` 轉為 `{x}`；無法轉出合法 path 段回傳 null。 */
function templateToPathParams(path: string): string | null {
  const converted = path.replace(TEMPLATE_SEG_RE, (_whole, expr: string) => {
    const name = expr.replace(/^_\.?/, '').replace(/[^\w.-]/g, '_');
    return `{${name || 'var'}}`;
  });
  if (/[{}]/.test(converted.replace(/\{[\w.-]+\}/g, ''))) {
    return null; // 還殘留無法轉換的大括號（如 {% %} tag）
  }
  if (!converted.startsWith('/')) {
    return null;
  }
  if (/\s/.test(converted)) {
    return null;
  }
  return converted;
}

export interface Projection {
  path: string;
  method: string;
}

/**
 * 嘗試把 request URL 投影成 OpenAPI path。
 * 規則：去除 base 字首（servers 或 base env URL 變數）→ 剩餘須為合法 path。
 */
export function projectUrl(
  url: string,
  method: string,
  candidates: Array<{ prefix: string; server: string }>,
): Projection | null {
  const { main } = splitQuery(url.trim());
  if (main === '') {
    return null;
  }
  let remainder: string | null = null;
  for (const { prefix } of candidates) {
    if (main.startsWith(prefix)) {
      const rest = main.slice(prefix.length);
      remainder = rest === '' ? '/' : rest;
      break;
    }
  }
  if (remainder === null) {
    if (/^https?:\/\//.test(main)) {
      // 絕對 URL 且不匹配任何 server：取 origin 之後的 path
      try {
        const probe = interpolate(main, {}).result;
        const u = new URL(probe);
        remainder = u.pathname || '/';
        if (/[{}]/.test(u.host)) {
          return null;
        }
      } catch {
        return null;
      }
    } else if (main.startsWith('/')) {
      remainder = main;
    } else {
      return null;
    }
  }
  if (!remainder.startsWith('/')) {
    return null;
  }
  const path = templateToPathParams(remainder);
  if (!path) {
    return null;
  }
  const m = method.toLowerCase();
  const OPENAPI_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
  if (!OPENAPI_METHODS.includes(m)) {
    return null;
  }
  return { path, method: m };
}
