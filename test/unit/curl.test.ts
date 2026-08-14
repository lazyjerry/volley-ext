import * as assert from 'node:assert';
import { importCurl, tokenize } from '../../src/core/formats/curlImport';
import { exportCurl } from '../../src/core/formats/curlExport';
import { sampleRequest } from './helpers';

suite('curlImport', () => {
  test('tokenizer：引號、跳脫、行接續', () => {
    assert.deepStrictEqual(
      tokenize(`curl -H 'X-A: b c' \\\n  "https://x/y z"`),
      ['curl', '-H', 'X-A: b c', 'https://x/y z'],
    );
  });

  test('基本 GET + headers + query 拆解', () => {
    const r = importCurl(`curl -H 'Accept: application/json' 'https://api.example.com/users?page=2&size=10'`);
    assert.strictEqual(r.method, 'GET');
    assert.strictEqual(r.url, 'https://api.example.com/users');
    assert.deepStrictEqual(r.parameters.map((p) => [p.name, p.value]), [['page', '2'], ['size', '10']]);
    assert.deepStrictEqual(r.headers[0], { name: 'Accept', value: 'application/json' });
  });

  test('-d 預設 POST + form-urlencoded params', () => {
    const r = importCurl(`curl https://x/login -d 'user=a' -d 'pass=b'`);
    assert.strictEqual(r.method, 'POST');
    assert.strictEqual(r.body.mimeType, 'application/x-www-form-urlencoded');
    assert.deepStrictEqual(r.body.params?.map((p) => [p.name, p.value]), [['user', 'a'], ['pass', 'b']]);
  });

  test('-d + Content-Type: application/json → raw body', () => {
    const r = importCurl(`curl https://x -X PUT -H 'Content-Type: application/json' -d '{"a":1}'`);
    assert.strictEqual(r.method, 'PUT');
    assert.strictEqual(r.body.mimeType, 'application/json');
    assert.strictEqual(r.body.text, '{"a":1}');
  });

  test('-G 將 data 轉為 query', () => {
    const r = importCurl(`curl -G https://x/search -d 'q=hello' --data-urlencode 'lang=zh tw'`);
    assert.strictEqual(r.method, 'GET');
    assert.deepStrictEqual(r.parameters.map((p) => [p.name, p.value]), [['q', 'hello'], ['lang', 'zh tw']]);
    assert.strictEqual(r.body.mimeType, undefined);
  });

  test('-F multipart（含 @檔案）', () => {
    const r = importCurl(`curl https://x/upload -F 'name=jerry' -F 'file=@/tmp/a.png'`);
    assert.strictEqual(r.body.mimeType, 'multipart/form-data');
    assert.deepStrictEqual(r.body.params?.[0], { name: 'name', value: 'jerry' });
    assert.strictEqual(r.body.params?.[1].type, 'file');
    assert.strictEqual(r.body.params?.[1].fileName, '/tmp/a.png');
  });

  test('-u 轉 basic auth', () => {
    const r = importCurl(`curl -u admin:s3cret https://x`);
    assert.deepStrictEqual(r.authentication, { type: 'basic', username: 'admin', password: 's3cret', disabled: false });
  });

  test('IGNORED_VALUE_ARGS：消耗值不誤判為 URL', () => {
    const cases: Array<[string, string]> = [
      [`curl -o out.json https://real/url`, 'https://real/url'],
      [`curl -A 'MyAgent/1.0' https://real/url`, 'https://real/url'],
      [`curl -x http://proxy:8080 https://real/url`, 'https://real/url'],
      [`curl -m 30 https://real/url`, 'https://real/url'],
      [`curl --connect-timeout 5 https://real/url`, 'https://real/url'],
      [`curl --retry 3 https://real/url`, 'https://real/url'],
      [`curl --cacert /etc/ca.pem https://real/url`, 'https://real/url'],
      [`curl -E cert.pem https://real/url`, 'https://real/url'],
      [`curl --key key.pem https://real/url`, 'https://real/url'],
      [`curl -w '%{http_code}' https://real/url`, 'https://real/url'],
      [`curl -c jar.txt -D headers.txt https://real/url`, 'https://real/url'],
    ];
    for (const [cmd, expected] of cases) {
      const r = importCurl(cmd);
      assert.strictEqual(r.url, expected, cmd);
    }
  });

  test('布林旗標不吃掉 URL', () => {
    const r = importCurl(`curl -sSL --compressed -k https://real/url`);
    assert.strictEqual(r.url.includes('real') ? r.url : '', 'https://real/url');
  });

  test('-I → HEAD；-X 優先', () => {
    assert.strictEqual(importCurl('curl -I https://x').method, 'HEAD');
    assert.strictEqual(importCurl('curl -X DELETE https://x').method, 'DELETE');
  });
});

suite('curlExport', () => {
  test('基本輸出含 method/header/auth 且變數已插值', () => {
    const request = sampleRequest({ method: 'POST', body: { mimeType: 'application/json', text: '{"q":"{{ _.token }}"}' } });
    const cmd = exportCurl(request, { base_url: 'https://api.example.com', token: 'tkn' });
    assert.ok(cmd.includes('-X POST'));
    assert.ok(cmd.includes('https://api.example.com/users?page=1'));
    assert.ok(cmd.includes("-H 'Authorization: Bearer tkn'"));
    assert.ok(cmd.includes(`--data-raw '{"q":"tkn"}'`));
  });

  test('單引號跳脫', () => {
    const request = sampleRequest({
      method: 'POST',
      authentication: {},
      body: { mimeType: 'text/plain', text: "it's a test" },
    });
    const cmd = exportCurl(request, { base_url: 'https://x' });
    assert.ok(cmd.includes(`'it'\\''s a test'`), cmd);
  });

  test('round-trip：export → import 保留關鍵欄位', () => {
    const request = sampleRequest({ method: 'POST', body: { mimeType: 'application/json', text: '{"a":1}' } });
    const cmd = exportCurl(request, { base_url: 'https://api.example.com', token: 't' });
    const reimported = importCurl(cmd);
    assert.strictEqual(reimported.method, 'POST');
    assert.strictEqual(reimported.url, 'https://api.example.com/users');
    assert.strictEqual(reimported.body.text, '{"a":1}');
    assert.ok(reimported.headers.some((h) => h.name === 'Authorization'));
  });
});
