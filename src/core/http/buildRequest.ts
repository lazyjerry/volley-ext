// RequestItem + 已解析環境 → 可送出的請求描述（URL、headers、body）。
// 變數插值統一在這裡套用；auth 轉為 header/query。

import type { Folder, RequestItem } from '../model/types';
import { interpolate } from '../vars/template';

export interface BuiltRequest {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  bodyText?: string;
  bodyFile?: string;
  formParams?: Array<{ name: string; value: string; type?: string; fileName?: string }>;
  mimeType?: string | null;
  warnings: string[];
}

const UNSUPPORTED_AUTH_EXEC = new Set([
  'digest', 'ntlm', 'oauth1', 'oauth2', 'hawk', 'iam', 'asap', 'netrc',
]);

export function buildRequest(
  request: RequestItem,
  env: Record<string, unknown>,
  folderChain: Folder[] = [],
): BuiltRequest {
  const warnings: string[] = [];
  const missing = new Set<string>();
  const r = (s: string): string => {
    const res = interpolate(s, env);
    res.missing.forEach((m) => missing.add(m));
    if (res.hasTemplateTags) {
      warnings.push('包含未支援的 {% %} template tag，已原樣送出');
    }
    return res.result;
  };

  let url = r(request.url.trim());
  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }

  const query = request.parameters
    .filter((p) => !p.disabled && p.name !== '')
    .map((p) => {
      const name = r(p.name);
      const value = r(p.value);
      return request.settings.encodeUrl
        ? `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
        : `${name}=${value}`;
    })
    .join('&');
  if (query) {
    url += (url.includes('?') ? '&' : '?') + query;
  }

  const headers: Array<[string, string]> = [];
  // 資料夾層級 headers（由外而內），後者可被 request 自身覆蓋
  for (const folder of folderChain) {
    for (const h of folder.headers ?? []) {
      if (!h.disabled && h.name !== '') {
        headers.push([r(h.name), r(h.value)]);
      }
    }
  }
  for (const h of request.headers) {
    if (!h.disabled && h.name !== '') {
      headers.push([r(h.name), r(h.value)]);
    }
  }

  const auth = request.authentication;
  const authType = auth.type ?? 'none';
  if (auth.disabled !== true) {
    if (authType === 'basic') {
      const token = Buffer.from(`${r(String(auth.username ?? ''))}:${r(String(auth.password ?? ''))}`).toString('base64');
      headers.push(['Authorization', `Basic ${token}`]);
    } else if (authType === 'bearer') {
      const prefix = String(auth.prefix ?? '').trim() || 'Bearer';
      headers.push(['Authorization', `${prefix} ${r(String(auth.token ?? ''))}`]);
    } else if (authType === 'apikey') {
      const key = r(String(auth.key ?? ''));
      const value = r(String(auth.value ?? ''));
      if ((auth.addTo ?? 'header') === 'queryParams') {
        url += (url.includes('?') ? '&' : '?') + `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      } else if (key) {
        headers.push([key, value]);
      }
    } else if (UNSUPPORTED_AUTH_EXEC.has(String(authType))) {
      warnings.push(`auth 類型「${String(authType)}」尚未支援執行，本次未附加認證`);
    }
  }

  const built: BuiltRequest = {
    url,
    method: request.method,
    headers,
    mimeType: request.body.mimeType ?? null,
    warnings,
  };

  const body = request.body;
  if (body.mimeType === 'application/x-www-form-urlencoded' && body.params) {
    built.bodyText = body.params
      .filter((p) => !p.disabled)
      .map((p) => `${encodeURIComponent(r(p.name))}=${encodeURIComponent(r(p.value))}`)
      .join('&');
  } else if (body.mimeType === 'multipart/form-data' && body.params) {
    built.formParams = body.params
      .filter((p) => !p.disabled)
      .map((p) => ({ name: r(p.name), value: r(p.value), type: p.type, fileName: p.fileName }));
  } else if (body.fileName) {
    built.bodyFile = body.fileName;
  } else if (body.text !== undefined && body.text !== '') {
    built.bodyText = request.settings.renderRequestBody ? r(body.text) : body.text;
  }

  if (missing.size > 0) {
    warnings.push(`未定義的變數：${[...missing].join(', ')}`);
  }
  return built;
}
