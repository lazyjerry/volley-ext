// HTTP 發送層：使用 Node 內建 global fetch（undici）。
// redirect: manual 自迴圈——逐跳套 cookie、記 redirectChain、303/301/302+POST 降 GET。

import { readFile } from 'node:fs/promises';
import type { CookieJar, RequestItem, ResponseRecord } from '../model/types';
import type { BuiltRequest } from './buildRequest';
import { cookieHeaderFor, parseSetCookie, storeCookie } from './cookieJarUtil';

export interface HttpClientOptions {
  timeoutMs: number;
  followRedirectsGlobal: boolean;
  maxRedirects: number;
  maxStoredBodyBytes: number;
}

export interface SendResult {
  record: ResponseRecord;
  /** 完整（未截斷）body，供當次 Preview 顯示。 */
  fullBody: string;
  fullBodyEncoding: 'utf8' | 'base64';
}

const TEXTUAL_RE = /^(text\/|application\/(json|xml|yaml|javascript|x-www-form-urlencoded|graphql))/i;

function shouldFollow(request: RequestItem, options: HttpClientOptions): boolean {
  const setting = request.settings.followRedirects;
  if (setting === 'on') {
    return true;
  }
  if (setting === 'off') {
    return false;
  }
  return options.followRedirectsGlobal;
}

export async function sendRequest(
  request: RequestItem,
  built: BuiltRequest,
  jar: CookieJar,
  options: HttpClientOptions,
  externalSignal?: AbortSignal,
): Promise<SendResult> {
  const start = performance.now();
  const redirectChain: string[] = [];
  const warnings = [...built.warnings];
  const requestHeaders = built.headers.map(([name, value]) => ({ name, value }));

  const signals: AbortSignal[] = [AbortSignal.timeout(options.timeoutMs)];
  if (externalSignal) {
    signals.push(externalSignal);
  }
  const signal = AbortSignal.any(signals);

  let currentUrl = built.url;
  let currentMethod = built.method;
  let sendBody = true;
  let response: Response | null = null;

  const makeBody = async (): Promise<BodyInit | undefined> => {
    if (!sendBody || currentMethod === 'GET' || currentMethod === 'HEAD') {
      return undefined;
    }
    if (built.formParams) {
      const form = new FormData();
      for (const p of built.formParams) {
        if (p.type === 'file' && p.fileName) {
          const buf = await readFile(p.fileName);
          form.append(p.name, new Blob([new Uint8Array(buf)]), p.fileName.split('/').pop() ?? 'file');
        } else {
          form.append(p.name, p.value);
        }
      }
      return form;
    }
    if (built.bodyFile) {
      const buf = await readFile(built.bodyFile);
      return new Uint8Array(buf);
    }
    return built.bodyText;
  };

  const follow = shouldFollow(request, options);
  let hops = 0;
  try {
    for (;;) {
      const url = new URL(currentUrl);
      const headers = new Headers();
      for (const [name, value] of built.headers) {
        headers.append(name, value);
      }
      if (request.settings.cookies.send) {
        const cookieValue = cookieHeaderFor(jar, url);
        if (cookieValue) {
          headers.set('Cookie', cookieValue);
        }
      }
      if (built.mimeType && !headers.has('Content-Type') && built.bodyText !== undefined && currentMethod !== 'GET' && currentMethod !== 'HEAD' && !built.formParams) {
        headers.set('Content-Type', built.mimeType);
      }

      response = await fetch(url, {
        method: currentMethod,
        headers,
        body: await makeBody(),
        redirect: 'manual',
        signal,
      });

      if (request.settings.cookies.store) {
        for (const setCookie of response.headers.getSetCookie()) {
          const cookie = parseSetCookie(setCookie, url);
          if (cookie) {
            storeCookie(jar, cookie);
          }
        }
      }

      const isRedirect = response.status >= 300 && response.status < 400 && response.headers.has('location');
      if (!isRedirect || !follow) {
        break;
      }
      if (hops >= options.maxRedirects) {
        warnings.push(`已達重新導向上限（${options.maxRedirects} 次），停止跟隨`);
        break;
      }
      const location = response.headers.get('location')!;
      const nextUrl = new URL(location, url).toString();
      redirectChain.push(`${response.status} → ${nextUrl}`);
      // 301/302 對 POST、303 對所有方法：降為 GET 並丟棄 body
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && currentMethod === 'POST')
      ) {
        currentMethod = 'GET';
        sendBody = false;
      }
      currentUrl = nextUrl;
      hops++;
      await response.arrayBuffer().catch(() => undefined); // 排掉中繼回應的 body
    }

    const buf = Buffer.from(await response!.arrayBuffer());
    const durationMs = Math.round(performance.now() - start);
    const contentType = response!.headers.get('content-type') ?? undefined;
    const isText = contentType ? TEXTUAL_RE.test(contentType) : !buf.includes(0);
    const encoding: 'utf8' | 'base64' = isText ? 'utf8' : 'base64';
    const fullBody = buf.toString(encoding);
    const truncated = buf.length > options.maxStoredBodyBytes;
    const storedBody = truncated ? buf.subarray(0, options.maxStoredBodyBytes).toString(encoding) : fullBody;

    const responseHeaders: Array<{ name: string; value: string }> = [];
    response!.headers.forEach((value, name) => {
      responseHeaders.push({ name, value });
    });

    const record: ResponseRecord = {
      id: `res_${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16)}`,
      requestId: request.id,
      at: Date.now(),
      durationMs,
      method: built.method,
      url: built.url,
      status: response!.status,
      statusText: response!.statusText,
      requestHeaders,
      responseHeaders,
      contentType,
      bodyEncoding: encoding,
      body: storedBody,
      bodySize: buf.length,
      bodyTruncated: truncated,
      ...(redirectChain.length > 0 ? { redirectChain } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    return { record, fullBody, fullBodyEncoding: encoding };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const message =
      err instanceof Error
        ? err.name === 'TimeoutError'
          ? `請求逾時（${options.timeoutMs}ms）`
          : err.name === 'AbortError'
            ? '請求已取消'
            : `${err.message}${err.cause instanceof Error ? `：${err.cause.message}` : ''}`
        : String(err);
    const record: ResponseRecord = {
      id: `res_${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16)}`,
      requestId: request.id,
      at: Date.now(),
      durationMs,
      method: built.method,
      url: built.url,
      status: 0,
      statusText: '',
      requestHeaders,
      responseHeaders: [],
      bodyEncoding: 'utf8',
      body: '',
      bodySize: 0,
      bodyTruncated: false,
      ...(redirectChain.length > 0 ? { redirectChain } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      error: message,
    };
    return { record, fullBody: '', fullBodyEncoding: 'utf8' };
  }
}
