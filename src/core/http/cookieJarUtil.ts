// 簡易 cookie jar：Set-Cookie 解析、domain/path/secure 匹配、過期清除。
// 純函式，jar 內容持久化回 collection.cookieJar。

import type { CookieJar, CookieRecord } from '../model/types';

function domainMatches(cookieDomain: string, host: string, hostOnly: boolean): boolean {
  const d = cookieDomain.toLowerCase().replace(/^\./, '');
  const h = host.toLowerCase();
  if (hostOnly) {
    return h === d;
  }
  return h === d || h.endsWith(`.${d}`);
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) {
    return true;
  }
  if (requestPath.startsWith(cookiePath)) {
    return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
  }
  return false;
}

function isExpired(cookie: CookieRecord, now: number): boolean {
  if (!cookie.expires) {
    return false;
  }
  const t = Date.parse(cookie.expires);
  return !Number.isNaN(t) && t <= now;
}

export function parseSetCookie(header: string, requestUrl: URL): CookieRecord | null {
  const parts = header.split(';');
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf('=');
  if (eq <= 0) {
    return null;
  }
  const cookie: CookieRecord = {
    id: `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
    key: nameValue.slice(0, eq).trim(),
    value: nameValue.slice(eq + 1).trim(),
    domain: requestUrl.hostname,
    path: '/',
    hostOnly: true,
    secure: false,
    httpOnly: false,
    expires: null,
  };
  for (const attr of attrs) {
    const aEq = attr.indexOf('=');
    const name = (aEq >= 0 ? attr.slice(0, aEq) : attr).trim().toLowerCase();
    const value = aEq >= 0 ? attr.slice(aEq + 1).trim() : '';
    switch (name) {
      case 'domain':
        if (value) {
          cookie.domain = value.replace(/^\./, '');
          cookie.hostOnly = false;
        }
        break;
      case 'path':
        cookie.path = value || '/';
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'expires': {
        const t = Date.parse(value);
        if (!Number.isNaN(t)) {
          cookie.expires = new Date(t).toISOString();
        }
        break;
      }
      case 'max-age': {
        const seconds = Number(value);
        if (Number.isFinite(seconds)) {
          cookie.expires = new Date(Date.now() + seconds * 1000).toISOString();
        }
        break;
      }
    }
  }
  return cookie;
}

/** 將新 cookie 存入 jar（同 domain+path+key 覆蓋；過期即刪除）。 */
export function storeCookie(jar: CookieJar, cookie: CookieRecord): void {
  const idx = jar.cookies.findIndex(
    (c) => c.key === cookie.key && c.domain === cookie.domain && c.path === cookie.path,
  );
  const expired = isExpired(cookie, Date.now());
  if (idx >= 0) {
    if (expired) {
      jar.cookies.splice(idx, 1);
    } else {
      jar.cookies[idx] = cookie;
    }
  } else if (!expired) {
    jar.cookies.push(cookie);
  }
}

/** 取得應隨請求送出的 Cookie header 值；無匹配回傳 ''。 */
export function cookieHeaderFor(jar: CookieJar, url: URL): string {
  const now = Date.now();
  const path = url.pathname || '/';
  return jar.cookies
    .filter(
      (c) =>
        !isExpired(c, now) &&
        domainMatches(c.domain, url.hostname, c.hostOnly === true) &&
        pathMatches(c.path, path) &&
        (!c.secure || url.protocol === 'https:'),
    )
    .map((c) => `${c.key}=${c.value}`)
    .join('; ');
}
