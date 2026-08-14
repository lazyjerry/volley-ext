import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  downloadText,
  parseImportedText,
  rewriteGitHubBlobUrl,
} from '../../src/core/formats/urlImport';
import { serializeCollection } from '../../src/core/formats/openapiStore';
import { sampleCollection } from './helpers';

const SAMPLE_V5_PATH = path.join(__dirname, '..', '..', '..', 'samples', 'volley-sample.insomnia.yaml');

suite('urlImport / parseImportedText', () => {
  test('辨識 Insomnia v5 YAML（samples 範例檔）', () => {
    const text = fs.readFileSync(SAMPLE_V5_PATH, 'utf8');
    const c = parseImportedText(text);
    assert.strictEqual(c.name, 'Volley 範例 Collection');
    assert.ok(c.children.length > 0);
  });

  test('辨識 Insomnia v4 JSON', () => {
    const v4doc = {
      _type: 'export',
      __export_format: 4,
      resources: [
        { _id: 'wrk_1', _type: 'workspace', parentId: null, name: 'V4 集合' },
        { _id: 'req_1', _type: 'request', parentId: 'wrk_1', name: 'Ping', method: 'GET', url: 'https://example.com', metaSortKey: 0 },
      ],
    };
    const c = parseImportedText(JSON.stringify(v4doc));
    assert.strictEqual(c.name, 'V4 集合');
    assert.strictEqual(c.children.length, 1);
  });

  test('辨識外部 OpenAPI 3.x YAML', () => {
    const text = [
      'openapi: 3.1.0',
      'info:',
      '  title: Demo API',
      'servers:',
      '  - url: https://api.example.com',
      'paths:',
      '  /users:',
      '    get:',
      '      summary: List users',
    ].join('\n');
    const c = parseImportedText(text);
    assert.strictEqual(c.name, 'Demo API');
    assert.strictEqual(c.children.length, 1);
  });

  test('辨識本延伸模組原生檔（含 x-volley）並保留 id', () => {
    const original = sampleCollection();
    const c = parseImportedText(serializeCollection(original));
    assert.strictEqual(c.id, original.id);
    assert.strictEqual(c.name, original.name);
  });

  test('無法辨識的資料格式 → 丟出錯誤', () => {
    assert.throws(() => parseImportedText('只是一段純文字'), /資料格式不符/);
    assert.throws(() => parseImportedText('<html><body>Not Found</body></html>'), /資料格式不符/);
    assert.throws(() => parseImportedText('{"foo": "bar"}'), /資料格式不符/);
  });

  test('不是有效 YAML / JSON → 丟出錯誤', () => {
    assert.throws(() => parseImportedText('{invalid: ['), /資料格式不符/);
  });
});

suite('urlImport / rewriteGitHubBlobUrl', () => {
  test('github.com blob 網址 → raw 網址', () => {
    assert.strictEqual(
      rewriteGitHubBlobUrl(
        new URL('https://github.com/lazyjerry/volley-ext/blob/main/samples/volley-sample.insomnia.yaml'),
      ).href,
      'https://raw.githubusercontent.com/lazyjerry/volley-ext/main/samples/volley-sample.insomnia.yaml',
    );
  });

  test('www.github.com 與多層路徑、分支含斜線以外字元皆可改寫', () => {
    assert.strictEqual(
      rewriteGitHubBlobUrl(new URL('https://www.github.com/o/r/blob/v1.2.3/a/b/c.json')).href,
      'https://raw.githubusercontent.com/o/r/v1.2.3/a/b/c.json',
    );
  });

  test('非 github.com 網址不改寫', () => {
    const url = new URL('https://example.com/o/r/blob/main/a.yaml');
    assert.strictEqual(rewriteGitHubBlobUrl(url), url);
  });

  test('github.com 非 blob 路徑不改寫（releases、raw、過短路徑）', () => {
    for (const href of [
      'https://github.com/o/r/releases/download/v1/a.yaml',
      'https://github.com/o/r/raw/main/a.yaml',
      'https://github.com/o/r/blob/main',
    ]) {
      const url = new URL(href);
      assert.strictEqual(rewriteGitHubBlobUrl(url), url);
    }
  });
});

suite('urlImport / downloadText', () => {
  let server: http.Server;
  let baseUrl: string;

  suiteSetup(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'text/yaml' });
        res.end('openapi: 3.1.0');
      } else if (req.url === '/slow') {
        // 不回應，讓 timeout 生效
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  suiteTeardown(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('下載成功回傳內容', async () => {
    assert.strictEqual(await downloadText(`${baseUrl}/ok`), 'openapi: 3.1.0');
  });

  test('HTTP 非 2xx → 下載失敗錯誤含狀態碼', async () => {
    await assert.rejects(downloadText(`${baseUrl}/missing`), /下載失敗：HTTP 404/);
  });

  test('連線被拒 → 下載失敗錯誤', async () => {
    // port 1 幾乎必然沒有服務在監聽
    await assert.rejects(downloadText('http://127.0.0.1:1/x'), /下載失敗/);
  });

  test('逾時 → 下載失敗錯誤', async () => {
    await assert.rejects(downloadText(`${baseUrl}/slow`, 200), /下載失敗/);
  });

  test('非 http/https 協定 → 錯誤', async () => {
    await assert.rejects(downloadText('ftp://example.com/a.yaml'), /僅支援 http \/ https/);
  });

  test('無效網址 → 錯誤', async () => {
    await assert.rejects(downloadText('不是網址'), /無效的網址/);
  });
});
