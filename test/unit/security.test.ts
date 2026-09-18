import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import * as YAML from 'yaml';
import type { CookieJar, ResponseRecord } from '../../src/core/model/types';
import { genId, isSafeIdSegment, safeIdOr } from '../../src/core/model/ids';
import { StateStore } from '../../src/storage/stateStore';
import { parseCollection, serializeCollection } from '../../src/core/formats/openapiStore';
import { importInsomniaV5 } from '../../src/core/formats/insomniaV5';
import { importInsomniaV4 } from '../../src/core/formats/insomniaV4';
import { buildRequest } from '../../src/core/http/buildRequest';
import { MASKED_HEADER_VALUE, sendRequest } from '../../src/core/http/httpClient';
import { parseSetCookie } from '../../src/core/http/cookieJarUtil';
import { exportCurl } from '../../src/core/formats/curlExport';
import { importCurl } from '../../src/core/formats/curlImport';
import { isClientMessage } from '../../src/shared/protocol';
import { sampleCollection, sampleRequest } from './helpers';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'volley-sec-'));
}

function record(requestId: string): ResponseRecord {
  return {
    id: 'res_1', requestId, at: 1, durationMs: 1, method: 'GET', url: 'http://x',
    status: 200, statusText: 'OK', requestHeaders: [], responseHeaders: [],
    bodyEncoding: 'utf8', body: '', bodySize: 0, bodyTruncated: false,
  };
}

const UNSAFE_IDS = ['', '.', '..', '../x', '../../etc', 'a/b', 'a\\b', 'x\0y'];

suite('security/ids', () => {
  test('isSafeIdSegment：擋路徑片段，接受既有各種 id 形式', () => {
    for (const id of UNSAFE_IDS) {
      assert.strictEqual(isSafeIdSegment(id), false, JSON.stringify(id));
    }
    assert.strictEqual(isSafeIdSegment(undefined), false);
    assert.strictEqual(isSafeIdSegment(123), false);
    for (const id of [genId('wrk'), genId('req'), 'wrk_x', 'req_1', 'jar_t', 'req_abc-DEF.1', '__WORKSPACE_ID__', 'wrk_中文']) {
      assert.strictEqual(isSafeIdSegment(id), true, id);
    }
  });

  test('safeIdOr：安全 id 原樣保留、不安全就重新產生', () => {
    assert.strictEqual(safeIdOr('req_1', 'req'), 'req_1');
    assert.match(safeIdOr('../../x', 'req'), /^req_[0-9a-f]{32}$/);
    assert.match(safeIdOr('', 'wrk'), /^wrk_[0-9a-f]{32}$/);
  });
});

suite('security/stateStore 路徑防線', () => {
  test('惡意 collection／request id 不寫出、不刪出基底目錄', () => {
    const root = tmpDir();
    const stateDir = path.join(root, 'data', 'state');
    const responsesDir = path.join(stateDir, 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });
    const outside = path.join(root, 'victim');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    const store = new StateStore(stateDir, responsesDir);

    // 相對於 responsesDir：../../../victim 指向 root/victim
    store.deleteCollectionState('../../../victim');
    assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), '不可遞迴刪除基底外目錄');

    store.appendResponse('wrk_ok', record('../../../../victim/pwn'), 5);
    store.appendResponse('../../../victim', record('req_1'), 5);
    assert.deepStrictEqual(fs.readdirSync(outside), ['keep.txt'], '不可寫到基底外');

    store.saveUiState('../../victim/evil', { activeEnvironmentId: null, selectedRequestId: null, expandedFolders: [] });
    store.flush();
    assert.deepStrictEqual(fs.readdirSync(outside), ['keep.txt']);

    fs.writeFileSync(path.join(outside, 'req_x.json'), '[]');
    store.clearHistory('../../../victim', 'req_x');
    assert.ok(fs.existsSync(path.join(outside, 'req_x.json')), '不可刪除基底外檔案');
    assert.deepStrictEqual(store.loadHistory('..', 'x'), []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('空 id 刪除不會清掉整個 responses 目錄', () => {
    const root = tmpDir();
    const responsesDir = path.join(root, 'responses');
    const store = new StateStore(root, responsesDir);
    store.appendResponse('wrk_a', record('req_1'), 5);
    store.appendResponse('wrk_b', record('req_1'), 5);
    store.deleteCollectionState('');
    store.deleteCollectionState('.');
    assert.deepStrictEqual(fs.readdirSync(responsesDir).sort(), ['wrk_a', 'wrk_b']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('正常 id：刪除只清自己的 state，其他 collection 不受影響', () => {
    const root = tmpDir();
    const responsesDir = path.join(root, 'responses');
    const store = new StateStore(root, responsesDir);
    store.saveUiState('wrk_a', { activeEnvironmentId: null, selectedRequestId: null, expandedFolders: ['fld_1'] });
    store.flush();
    store.appendResponse('wrk_a', record('req_1'), 5);
    store.appendResponse('wrk_b', record('req_1'), 5);
    assert.strictEqual(store.loadHistory('wrk_a', 'req_1').length, 1);
    store.deleteCollectionState('wrk_a');
    assert.deepStrictEqual(fs.readdirSync(responsesDir), ['wrk_b']);
    assert.strictEqual(fs.existsSync(path.join(root, 'wrk_a.ui.json')), false);
    assert.strictEqual(store.loadHistory('wrk_b', 'req_1').length, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

suite('security/匯入 id 重新產生', () => {
  test('原生 YAML：缺 info.x-volley.id 與惡意 operationId → 重新產生', () => {
    type Doc = { info: { 'x-volley': { id?: string } }; paths: Record<string, Record<string, { operationId?: string }>> };
    const doc = YAML.parse(serializeCollection(sampleCollection())) as Doc;
    delete doc.info['x-volley'].id;
    for (const ops of Object.values(doc.paths)) {
      for (const op of Object.values(ops)) {
        op.operationId = '../../../evil';
      }
    }
    const parsed = parseCollection(YAML.stringify(doc));
    assert.match(parsed.id, /^wrk_[0-9a-f]{32}$/);
    const ids: string[] = [];
    const walk = (nodes: typeof parsed.children): void => {
      for (const n of nodes) {
        if (n.kind === 'folder') {
          walk(n.children);
        } else {
          ids.push(n.id);
        }
      }
    };
    walk(parsed.children);
    assert.ok(ids.length > 0);
    for (const id of ids) {
      assert.ok(isSafeIdSegment(id), id);
    }
  });

  test('原生 YAML：正常 id 原樣保留（round-trip 不變）', () => {
    const c = sampleCollection();
    assert.deepStrictEqual(parseCollection(serializeCollection(c)), c);
  });

  test('Insomnia v5：惡意 meta.id 重新產生，正常 id 保留', () => {
    const text = YAML.stringify({
      type: 'collection.insomnia.rest/5.0',
      name: 'x',
      meta: { id: '../../..' },
      collection: [
        { name: 'bad', method: 'GET', url: 'http://x', meta: { id: '../../../etc/passwd' } },
        { name: 'good', method: 'GET', url: 'http://x', meta: { id: 'req_keep' } },
      ],
    });
    const c = importInsomniaV5(text);
    assert.match(c.id, /^wrk_[0-9a-f]{32}$/);
    const [bad, good] = c.children;
    assert.match(bad.id, /^req_[0-9a-f]{32}$/);
    assert.strictEqual(good.id, 'req_keep');
  });

  test('Insomnia v4：惡意 _id 重新產生，資料夾結構（parentId）仍正確', () => {
    const text = JSON.stringify({
      __export_format: 4,
      resources: [
        { _id: '../wrk', _type: 'workspace', parentId: null, name: 'W' },
        { _id: 'fld_1', _type: 'request_group', parentId: '../wrk', name: 'F' },
        { _id: '../../req', _type: 'request', parentId: 'fld_1', name: 'bad', method: 'GET', url: 'http://x' },
        { _id: 'req_ok', _type: 'request', parentId: '../wrk', name: 'ok', method: 'GET', url: 'http://x' },
      ],
    });
    const c = importInsomniaV4(text);
    assert.match(c.id, /^wrk_[0-9a-f]{32}$/);
    const folder = c.children.find((n) => n.kind === 'folder');
    assert.ok(folder && folder.kind === 'folder');
    assert.strictEqual(folder.children.length, 1);
    assert.match(folder.children[0].id, /^req_[0-9a-f]{32}$/);
    assert.ok(c.children.some((n) => n.id === 'req_ok'));
  });
});

suite('security/request body 檔案', () => {
  test('非 Binary File 模式夾帶 fileName 不讀檔', () => {
    const request = sampleRequest({
      method: 'POST',
      body: { mimeType: 'application/json', text: '{"a":1}', fileName: '~/.ssh/id_rsa' },
    });
    const built = buildRequest(request, {});
    assert.strictEqual(built.bodyFile, undefined);
    assert.strictEqual(built.bodyText, '{"a":1}');

    const noText = buildRequest(sampleRequest({ method: 'POST', body: { mimeType: 'text/plain', fileName: '/etc/passwd' } }), {});
    assert.strictEqual(noText.bodyFile, undefined);
    assert.strictEqual(noText.bodyText, undefined);
  });

  test('Binary File 模式照常送檔；multipart file 欄位照常帶 fileName', () => {
    const bin = buildRequest(sampleRequest({ method: 'POST', body: { mimeType: 'application/octet-stream', fileName: '/tmp/a.bin' } }), {});
    assert.strictEqual(bin.bodyFile, '/tmp/a.bin');
    const form = buildRequest(sampleRequest({
      method: 'POST',
      body: { mimeType: 'multipart/form-data', params: [{ name: 'f', value: '', type: 'file', fileName: '/tmp/a.txt' }] },
    }), {});
    assert.deepStrictEqual(form.formParams, [{ name: 'f', value: '', type: 'file', fileName: '/tmp/a.txt' }]);
  });
});

suite('security/redirect 與歷史遮罩', () => {
  let serverA: http.Server;
  let serverB: http.Server;
  let baseA: string;
  let baseB: string;

  const echo = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ headers: req.headers }));
  };

  suiteSetup(async () => {
    serverB = http.createServer(echo);
    await new Promise<void>((resolve) => serverB.listen(0, '127.0.0.1', resolve));
    baseB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`;
    serverA = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/to-b') {
        res.statusCode = 302;
        res.setHeader('location', `${baseB}/echo`);
        res.end();
      } else if (url.pathname === '/same') {
        res.statusCode = 302;
        res.setHeader('location', '/echo');
        res.end();
      } else {
        echo(req, res);
      }
    });
    await new Promise<void>((resolve) => serverA.listen(0, '127.0.0.1', resolve));
    baseA = `http://127.0.0.1:${(serverA.address() as AddressInfo).port}`;
  });

  suiteTeardown(async () => {
    await new Promise<void>((resolve) => serverA.close(() => resolve()));
    await new Promise<void>((resolve) => serverB.close(() => resolve()));
  });

  const jar = (): CookieJar => ({ id: 'jar_t', name: 'J', cookies: [] });
  const OPTS = { timeoutMs: 3000, followRedirectsGlobal: true, maxRedirects: 5, maxStoredBodyBytes: 4096 };
  const withCreds = (url: string) => sampleRequest({
    url,
    parameters: [],
    headers: [
      { name: 'Cookie', value: 'sid=1' },
      { name: 'Proxy-Authorization', value: 'Basic cHJveHk=' },
      { name: 'X-Trace', value: 'keep' },
    ],
    authentication: { type: 'bearer', token: 'secret-token', prefix: 'Bearer' },
  });

  test('跨 origin 轉址移除 Authorization／Proxy-Authorization／Cookie／apikey header', async () => {
    // 兩台 server 同 host 不同 port → 不同 origin
    const request = withCreds(`${baseA}/to-b`);
    const { record } = await sendRequest(request, buildRequest(request, {}), jar(), OPTS);
    const h = (JSON.parse(record.body) as { headers: Record<string, string> }).headers;
    assert.strictEqual(h.authorization, undefined);
    assert.strictEqual(h['proxy-authorization'], undefined);
    assert.strictEqual(h.cookie, undefined);
    assert.strictEqual(h['x-trace'], 'keep', '一般 header 照常帶');

    const apikey = sampleRequest({
      url: `${baseA}/to-b`, parameters: [], headers: [],
      authentication: { type: 'apikey', key: 'X-Api-Key', value: 'k123', addTo: 'header' },
    });
    const r2 = await sendRequest(apikey, buildRequest(apikey, {}), jar(), OPTS);
    const h2 = (JSON.parse(r2.record.body) as { headers: Record<string, string> }).headers;
    assert.strictEqual(h2['x-api-key'], undefined);
  });

  test('同 origin 轉址行為不變：憑證照帶', async () => {
    const request = withCreds(`${baseA}/same`);
    const { record } = await sendRequest(request, buildRequest(request, {}), jar(), OPTS);
    const h = (JSON.parse(record.body) as { headers: Record<string, string> }).headers;
    assert.strictEqual(h.authorization, 'Bearer secret-token');
    assert.strictEqual(h['proxy-authorization'], 'Basic cHJveHk=');
    assert.strictEqual(h.cookie, 'sid=1');
  });

  test('jar cookie 依轉址目標網域重算', async () => {
    const j = jar();
    j.cookies.push({ id: 'c1', key: 'a', value: '1', domain: '127.0.0.1', path: '/', hostOnly: true, secure: false, httpOnly: false, expires: null });
    const request = sampleRequest({ url: `${baseA}/to-b`, parameters: [], headers: [], authentication: {} });
    const { record } = await sendRequest(request, buildRequest(request, {}), j, OPTS);
    const h = (JSON.parse(record.body) as { headers: Record<string, string> }).headers;
    assert.strictEqual(h.cookie, 'a=1', 'cookie 不分 port，目標網域符合就由 jar 帶上');
  });

  test('歷史紀錄的 requestHeaders 遮罩憑證、其他 header 保留', async () => {
    const request = withCreds(`${baseA}/echo`);
    request.headers.push({ name: 'X-Api-Key', value: 'nope' });
    request.authentication = { type: 'apikey', key: 'X-Api-Key', value: 'k123', addTo: 'header' };
    request.headers.push({ name: 'Authorization', value: 'Token abc' });
    const { record } = await sendRequest(request, buildRequest(request, {}), jar(), OPTS);
    const byName = new Map(record.requestHeaders.map((h) => [h.name.toLowerCase(), h.value]));
    assert.strictEqual(byName.get('authorization'), MASKED_HEADER_VALUE);
    assert.strictEqual(byName.get('proxy-authorization'), MASKED_HEADER_VALUE);
    assert.strictEqual(byName.get('cookie'), MASKED_HEADER_VALUE);
    assert.strictEqual(byName.get('x-api-key'), MASKED_HEADER_VALUE);
    assert.strictEqual(byName.get('x-trace'), 'keep');
    // 實際送出的仍是明文
    const h = (JSON.parse(record.body) as { headers: Record<string, string> }).headers;
    assert.ok(h.authorization.includes('Token abc'));
    assert.ok(h['x-api-key'].includes('k123'));
  });
});

suite('security/cookie Domain', () => {
  test('Domain 不涵蓋請求主機 → 捨棄', () => {
    const url = new URL('https://evil.example.net/');
    assert.strictEqual(parseSetCookie('sid=x; Domain=bank.example.com', url), null);
    assert.strictEqual(parseSetCookie('sid=x; Domain=sub.evil.example.net', url), null, '子網域不可由父主機種');
  });

  test('Domain 為請求主機本身或其上層 → 照常接受', () => {
    const url = new URL('https://api.Example.com/');
    const parent = parseSetCookie('a=1; Domain=.example.com', url);
    assert.ok(parent);
    assert.strictEqual(parent.domain, 'example.com');
    assert.strictEqual(parent.hostOnly, false);
    const self = parseSetCookie('b=2; Domain=API.example.com', url);
    assert.ok(self);
    assert.strictEqual(self.domain, 'API.example.com');
    const hostOnly = parseSetCookie('c=3', url);
    assert.strictEqual(hostOnly?.hostOnly, true);
  });
});

suite('security/curl method', () => {
  test('匯出時 method 經 shellQuote', () => {
    const text = exportCurl(sampleRequest({ method: 'GET;touch /tmp/pwn', url: 'http://x', parameters: [], headers: [], authentication: {} }));
    assert.ok(text.includes("-X 'GET;touch /tmp/pwn'"), text);
    const normal = exportCurl(sampleRequest({ method: 'DELETE', url: 'http://x', parameters: [], headers: [], authentication: {} }));
    assert.ok(normal.includes('-X DELETE'), normal);
  });

  test('匯入時不合法 method 捨棄，改用推斷值', () => {
    assert.strictEqual(importCurl(`curl -X 'GET;id' https://x`).method, 'GET');
    assert.strictEqual(importCurl(`curl -X 'P$(id)' https://x -d a=1`).method, 'POST');
    assert.strictEqual(importCurl('curl -X patch https://x').method, 'PATCH');
  });
});

suite('security/webview 訊息驗證', () => {
  test('runCommand 只收白名單', () => {
    assert.strictEqual(isClientMessage({ type: 'runCommand', command: 'reload' }), true);
    assert.strictEqual(isClientMessage({ type: 'runCommand', command: 'importCurl' }), true);
    assert.strictEqual(isClientMessage({ type: 'runCommand', command: 'chooseDataFolder' }), false);
    assert.strictEqual(isClientMessage({ type: 'runCommand', command: 'open/../x' }), false);
    assert.strictEqual(isClientMessage({ type: 'runCommand' }), false);
  });

  test('id 欄位必須是字串（folderId 可為 null）', () => {
    assert.strictEqual(isClientMessage({ type: 'loadHistory', collectionId: 'wrk_1', requestId: 'req_1' }), true);
    assert.strictEqual(isClientMessage({ type: 'loadHistory', collectionId: { a: 1 }, requestId: 'req_1' }), false);
    assert.strictEqual(isClientMessage({ type: 'clearHistory', collectionId: 'wrk_1', requestId: ['x'] }), false);
    assert.strictEqual(isClientMessage({ type: 'importCurlText', collectionId: 'wrk_1', folderId: null, text: 'curl x' }), true);
    assert.strictEqual(isClientMessage({ type: 'importCurlText', collectionId: 'wrk_1', folderId: 5, text: 'curl x' }), false);
    assert.strictEqual(isClientMessage({ type: 'ready' }), true);
    assert.strictEqual(isClientMessage(null), false);
    assert.strictEqual(isClientMessage({ type: 1 }), false);
  });
});
