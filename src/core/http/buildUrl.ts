// RequestItem → 實際送出的網址：插值、補 http://、接 query 參數、apikey 放 query 時一併接上。
// buildRequest（送出）與 webview 底部的完整網址列（顯示）共用，兩邊才不會各組各的。

import type { RequestItem } from '../model/types';

/** render = 變數插值；missing／warnings 的蒐集由呼叫端在 render 裡自己做。 */
export function buildUrl(request: RequestItem, render: (s: string) => string): string {
  let url = render(request.url.trim());
  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }

  const query = request.parameters
    .filter((p) => !p.disabled && p.name !== '')
    .map((p) => {
      const name = render(p.name);
      const value = render(p.value);
      return request.settings.encodeUrl
        ? `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
        : `${name}=${value}`;
    })
    .join('&');
  if (query) {
    url += (url.includes('?') ? '&' : '?') + query;
  }

  const auth = request.authentication;
  if (auth.disabled !== true && (auth.type ?? 'none') === 'apikey' && (auth.addTo ?? 'header') === 'queryParams') {
    const key = render(String(auth.key ?? ''));
    const value = render(String(auth.value ?? ''));
    url += (url.includes('?') ? '&' : '?') + `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
  return url;
}
