import * as assert from 'node:assert';
import { buildUrl } from '../../src/core/http/buildUrl';
import { buildRequest } from '../../src/core/http/buildRequest';
import { interpolate } from '../../src/core/vars/template';
import { sampleRequest } from './helpers';

suite('http/buildUrl', () => {
  const env = { base_url: 'https://api.example.com', key: 'K' };
  const render = (s: string): string => interpolate(s, env).result;

  test('變數展開 + query 參數；停用與空名稱的參數略過', () => {
    const request = sampleRequest({
      url: '{{ _.base_url }}/users',
      parameters: [
        { name: 'page', value: '1' },
        { name: 'off', value: 'x', disabled: true },
        { name: '', value: 'ignored' },
        { name: 'q', value: 'a b' },
      ],
    });
    assert.strictEqual(buildUrl(request, render), 'https://api.example.com/users?page=1&q=a%20b');
  });

  test('沒有 scheme 補 http://；URL 已有 ? 時用 & 接', () => {
    const request = sampleRequest({ url: 'localhost:3000/x?a=1', parameters: [{ name: 'b', value: '2' }] });
    assert.strictEqual(buildUrl(request, render), 'http://localhost:3000/x?a=1&b=2');
  });

  test('apikey 放 query 時接在網址上；放 header 或停用時不接', () => {
    const base = { url: '{{ _.base_url }}/x', parameters: [] as Array<{ name: string; value: string }> };
    const inQuery = sampleRequest({ ...base, authentication: { type: 'apikey', key: 'api_key', value: '{{ _.key }}', addTo: 'queryParams' } });
    assert.strictEqual(buildUrl(inQuery, render), 'https://api.example.com/x?api_key=K');
    const inHeader = sampleRequest({ ...base, authentication: { type: 'apikey', key: 'api_key', value: '{{ _.key }}' } });
    assert.strictEqual(buildUrl(inHeader, render), 'https://api.example.com/x');
    const disabled = sampleRequest({ ...base, authentication: { type: 'apikey', key: 'api_key', value: 'v', addTo: 'queryParams', disabled: true } });
    assert.strictEqual(buildUrl(disabled, render), 'https://api.example.com/x');
  });

  test('未定義的變數原樣保留，交由呼叫端的 render 蒐集', () => {
    const missing: string[] = [];
    const request = sampleRequest({ url: '{{ _.base_url }}/{{ _.nope }}', parameters: [] });
    const url = buildUrl(request, (s) => {
      const res = interpolate(s, env);
      missing.push(...res.missing);
      return res.result;
    });
    assert.strictEqual(url, 'https://api.example.com/{{ _.nope }}');
    assert.deepStrictEqual(missing, ['nope']);
  });

  test('buildRequest 的網址與 buildUrl 一致（送出端與顯示端共用）', () => {
    const request = sampleRequest({
      url: '{{ _.base_url }}/x',
      parameters: [{ name: 'p', value: '1' }],
      authentication: { type: 'apikey', key: 'k', value: '{{ _.key }}', addTo: 'queryParams' },
    });
    const built = buildRequest(request, env);
    assert.strictEqual(built.url, buildUrl(request, render));
    assert.strictEqual(built.url, 'https://api.example.com/x?p=1&k=K');
    assert.strictEqual(built.apiKeyHeader, undefined);
  });
});
