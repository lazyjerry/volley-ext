import * as assert from 'node:assert';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CookieJar } from '../../src/core/model/types';
import { buildRequest } from '../../src/core/http/buildRequest';
import { sendRequest } from '../../src/core/http/httpClient';
import { cookieHeaderFor, parseSetCookie, storeCookie } from '../../src/core/http/cookieJarUtil';
import { sampleRequest } from './helpers';

function makeJar(): CookieJar {
  return { id: 'jar_t', name: 'Default Jar', cookies: [] };
}

const OPTS = { timeoutMs: 3000, followRedirectsGlobal: true, maxRedirects: 5, maxStoredBodyBytes: 1024 };

suite('http', () => {
  let server: http.Server;
  let base: string;

  suiteSetup(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      switch (url.pathname) {
        case '/echo': {
          let body = '';
          req.on('data', (chunk: Buffer) => (body += chunk.toString()));
          req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
              method: req.method,
              path: url.pathname + url.search,
              headers: req.headers,
              body,
            }));
          });
          break;
        }
        case '/redirect1':
          res.statusCode = 302;
          res.setHeader('location', '/redirect2');
          res.end();
          break;
        case '/redirect2':
          res.statusCode = 303;
          res.setHeader('location', '/echo');
          res.end();
          break;
        case '/set-cookie':
          res.setHeader('set-cookie', ['sid=abc123; Path=/; HttpOnly', 'theme=dark; Path=/']);
          res.end('ok');
          break;
        case '/slow':
          setTimeout(() => res.end('late'), 2000);
          break;
        case '/big':
          res.end('x'.repeat(5000));
          break;
        default:
          res.statusCode = 404;
          res.end('nf');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  suiteTeardown(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('POST body 與 headers 送達；回應解析', async () => {
    const request = sampleRequest({
      method: 'POST',
      url: `${base}/echo`,
      parameters: [{ name: 'q', value: 'hi' }],
      headers: [{ name: 'X-Test', value: '{{ _.token }}' }],
      authentication: {},
      body: { mimeType: 'application/json', text: '{"a":1}' },
    });
    const built = buildRequest(request, { token: 'tkn' });
    const { record } = await sendRequest(request, built, makeJar(), OPTS);
    assert.strictEqual(record.status, 200);
    const echoed = JSON.parse(record.body) as { method: string; path: string; headers: Record<string, string>; body: string };
    assert.strictEqual(echoed.method, 'POST');
    assert.strictEqual(echoed.path, '/echo?q=hi');
    assert.strictEqual(echoed.headers['x-test'], 'tkn');
    assert.strictEqual(echoed.headers['content-type'], 'application/json');
    assert.strictEqual(echoed.body, '{"a":1}');
    assert.ok(record.durationMs >= 0);
  });

  test('redirect 鏈：302 → 303 降 GET，記錄 redirectChain', async () => {
    const request = sampleRequest({ method: 'POST', url: `${base}/redirect1`, parameters: [], headers: [], authentication: {}, body: { mimeType: 'text/plain', text: 'x' } });
    const built = buildRequest(request, {});
    const { record } = await sendRequest(request, built, makeJar(), OPTS);
    assert.strictEqual(record.status, 200);
    assert.strictEqual(record.redirectChain?.length, 2);
    const echoed = JSON.parse(record.body) as { method: string };
    assert.strictEqual(echoed.method, 'GET', '303 後應降為 GET');
  });

  test('followRedirects: off 時不跟隨', async () => {
    const request = sampleRequest({ method: 'GET', url: `${base}/redirect1`, parameters: [], headers: [], authentication: {} });
    request.settings.followRedirects = 'off';
    const built = buildRequest(request, {});
    const { record } = await sendRequest(request, built, makeJar(), OPTS);
    assert.strictEqual(record.status, 302);
  });

  test('cookie：store 後於下一請求送出', async () => {
    const jar = makeJar();
    const r1 = sampleRequest({ method: 'GET', url: `${base}/set-cookie`, parameters: [], headers: [], authentication: {} });
    await sendRequest(r1, buildRequest(r1, {}), jar, OPTS);
    assert.strictEqual(jar.cookies.length, 2);
    const r2 = sampleRequest({ method: 'GET', url: `${base}/echo`, parameters: [], headers: [], authentication: {} });
    const { record } = await sendRequest(r2, buildRequest(r2, {}), jar, OPTS);
    const echoed = JSON.parse(record.body) as { headers: Record<string, string> };
    assert.ok(echoed.headers.cookie.includes('sid=abc123'));
    assert.ok(echoed.headers.cookie.includes('theme=dark'));
  });

  test('cookies.send=false 時不送 cookie', async () => {
    const jar = makeJar();
    storeCookie(jar, parseSetCookie('sid=x; Path=/', new URL(`${base}/`))!);
    const request = sampleRequest({ method: 'GET', url: `${base}/echo`, parameters: [], headers: [], authentication: {} });
    request.settings.cookies.send = false;
    const { record } = await sendRequest(request, buildRequest(request, {}), jar, OPTS);
    const echoed = JSON.parse(record.body) as { headers: Record<string, string> };
    assert.strictEqual(echoed.headers.cookie, undefined);
  });

  test('timeout → error record，不丟例外', async () => {
    const request = sampleRequest({ method: 'GET', url: `${base}/slow`, parameters: [], headers: [], authentication: {} });
    const { record } = await sendRequest(request, buildRequest(request, {}), makeJar(), { ...OPTS, timeoutMs: 300 });
    assert.strictEqual(record.status, 0);
    assert.ok(record.error?.includes('逾時'), record.error);
  });

  test('body 超過上限截斷保存、完整版另回傳', async () => {
    const request = sampleRequest({ method: 'GET', url: `${base}/big`, parameters: [], headers: [], authentication: {} });
    const { record, fullBody } = await sendRequest(request, buildRequest(request, {}), makeJar(), OPTS);
    assert.strictEqual(record.bodyTruncated, true);
    assert.strictEqual(record.body.length, 1024);
    assert.strictEqual(fullBody.length, 5000);
    assert.strictEqual(record.bodySize, 5000);
  });

  test('連線失敗 → error record', async () => {
    const request = sampleRequest({ method: 'GET', url: 'http://127.0.0.1:1/none', parameters: [], headers: [], authentication: {} });
    const { record } = await sendRequest(request, buildRequest(request, {}), makeJar(), OPTS);
    assert.strictEqual(record.status, 0);
    assert.ok(record.error);
  });
});

suite('cookieJarUtil', () => {
  test('domain / path / secure 匹配', () => {
    const jar = makeJar();
    const url = new URL('https://sub.example.com/api/v1');
    storeCookie(jar, parseSetCookie('a=1; Path=/api; Domain=example.com', url)!);
    storeCookie(jar, parseSetCookie('b=2; Path=/other', url)!);
    storeCookie(jar, parseSetCookie('c=3; Secure; Path=/', url)!);
    assert.strictEqual(cookieHeaderFor(jar, new URL('https://sub.example.com/api/v1')), 'a=1; c=3');
    assert.strictEqual(cookieHeaderFor(jar, new URL('http://sub.example.com/api')), 'a=1', 'http 不含 Secure cookie');
    assert.strictEqual(cookieHeaderFor(jar, new URL('https://example.com/api')), 'a=1', 'host-only cookie 不跨主機');
  });

  test('max-age=0 / 過期 cookie 移除', () => {
    const jar = makeJar();
    const url = new URL('https://x.example.com/');
    storeCookie(jar, parseSetCookie('s=1; Path=/', url)!);
    assert.strictEqual(jar.cookies.length, 1);
    storeCookie(jar, parseSetCookie('s=; Path=/; Max-Age=0', url)!);
    assert.strictEqual(jar.cookies.length, 0);
  });
});
