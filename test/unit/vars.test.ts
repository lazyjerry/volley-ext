import * as assert from 'node:assert';
import { containsTemplate, interpolate, parseVarPath, tokenOrigin } from '../../src/core/vars/template';
import { deepMerge, resolveEnvironment } from '../../src/core/vars/environment';
import { sampleCollection, sampleFolder } from './helpers';

suite('vars/template', () => {
  const data = {
    base_url: 'https://api.example.com',
    num: 42,
    obj: { inner: 'x', deep: { z: 1 } },
    'test-value': 'dashed',
  };

  test('標準 {{ _.x }} 與巢狀取值', () => {
    assert.strictEqual(interpolate('{{ _.base_url }}/users', data).result, 'https://api.example.com/users');
    assert.strictEqual(interpolate('v={{ _.obj.inner }}', data).result, 'v=x');
    assert.strictEqual(interpolate('n={{ _.num }}', data).result, 'n=42');
  });

  test("特殊字元 key：{{ _['test-value'] }}", () => {
    assert.strictEqual(interpolate("{{ _['test-value'] }}", data).result, 'dashed');
    assert.strictEqual(interpolate('{{ _["test-value"] }}', data).result, 'dashed');
  });

  test('舊式 {{ varName }} 視為 _.varName', () => {
    assert.strictEqual(interpolate('{{ base_url }}/x', data).result, 'https://api.example.com/x');
    assert.strictEqual(interpolate('{{ obj.inner }}', data).result, 'x');
  });

  test('未定義變數：原樣保留並回報 missing', () => {
    const r = interpolate('{{ _.nope }}/{{ _.base_url }}', data);
    assert.strictEqual(r.result, '{{ _.nope }}/https://api.example.com');
    assert.deepStrictEqual(r.missing, ['nope']);
  });

  test('{% %} template tag 原樣保留並標記', () => {
    const r = interpolate("{% response 'body' %}/{{ _.num }}", data);
    assert.strictEqual(r.result, "{% response 'body' %}/42");
    assert.ok(r.hasTemplateTags);
  });

  test('物件值序列化為 JSON', () => {
    assert.strictEqual(interpolate('{{ _.obj.deep }}', data).result, '{"z":1}');
  });

  test('parseVarPath / containsTemplate', () => {
    assert.deepStrictEqual(parseVarPath('_.a.b'), ['a', 'b']);
    assert.deepStrictEqual(parseVarPath("_['x-y']"), ['x-y']);
    assert.deepStrictEqual(parseVarPath('plain'), ['plain']);
    assert.strictEqual(parseVarPath('_'), null);
    assert.ok(containsTemplate('a {{ _.b }} c'));
    assert.ok(!containsTemplate('plain text'));
  });
});

suite('vars/environment', () => {
  test('deepMerge 遞迴合併物件、其餘型別取代', () => {
    assert.deepStrictEqual(
      deepMerge({ a: 1, o: { x: 1, y: 2 } }, { o: { y: 3, z: 4 }, b: 5 }),
      { a: 1, o: { x: 1, y: 3, z: 4 }, b: 5 },
    );
  });

  test('三層覆蓋順序：base ← sub-env ← folder（越近 request 優先）', () => {
    const c = sampleCollection();
    c.environments.base.data = { v: 'base', keep: 'b' };
    c.environments.subEnvironments[0].data = { v: 'sub' };
    const outer = sampleFolder({ id: 'fld_o0000000000000000000000000000001', environment: { v: 'outer' } });
    const inner = sampleFolder({ id: 'fld_i0000000000000000000000000000001', environment: { v: 'inner' } });

    assert.strictEqual(resolveEnvironment(c, null, []).v, 'base');
    assert.strictEqual(resolveEnvironment(c, c.environments.subEnvironments[0].id, []).v, 'sub');
    assert.strictEqual(
      resolveEnvironment(c, c.environments.subEnvironments[0].id, [outer]).v,
      'outer',
    );
    assert.strictEqual(
      resolveEnvironment(c, c.environments.subEnvironments[0].id, [outer, inner]).v,
      'inner',
    );
    assert.strictEqual(resolveEnvironment(c, null, [outer, inner]).keep, 'b', '未覆蓋的 key 保留');
  });
});

suite('vars/共用環境', () => {
  test('共用環境優先權最低：base、sub-env、資料夾同名都蓋過它，未覆蓋的 key 保留', () => {
    const c = sampleCollection();
    const subId = c.environments.subEnvironments[0].id;
    c.environments.base.data = { v: 'base' };
    c.environments.subEnvironments[0].data = { s: 'sub' };
    const folder = sampleFolder({ id: 'fld_f0000000000000000000000000000001', environment: { f: 'folder' } });
    const global = { v: 'global', s: 'global', f: 'global', token: 'g-token' };

    const env = resolveEnvironment(c, subId, [folder], global);
    assert.strictEqual(env.v, 'base');
    assert.strictEqual(env.s, 'sub');
    assert.strictEqual(env.f, 'folder');
    assert.strictEqual(env.token, 'g-token');
    assert.strictEqual(resolveEnvironment(c, null, [], global).token, 'g-token', '選 Base 時也套用共用環境');
    assert.strictEqual(resolveEnvironment(c, null, []).token, undefined, '未給共用環境時行為不變');
  });

  test('共用環境與 collection 環境的巢狀物件深合併', () => {
    const c = sampleCollection();
    c.environments.base.data = { o: { b: 2 } };
    assert.deepStrictEqual(resolveEnvironment(c, null, [], { o: { a: 1, b: 1 } }).o, { a: 1, b: 2 });
  });

  test('tokenOrigin 區分 local／global／missing，同名以 local 為準', () => {
    const local = { base_url: 'https://local', o: { b: 2 } };
    const merged = { ...local, base_url: 'https://local', bearerToken: 't', o: { a: 1, b: 2 } };
    assert.strictEqual(tokenOrigin('{{ _.base_url }}', merged, local), 'local');
    assert.strictEqual(tokenOrigin('{{ _.bearerToken }}', merged, local), 'global');
    assert.strictEqual(tokenOrigin('{{ _.o.a }}', merged, local), 'global', '巢狀 key 只在共用環境');
    assert.strictEqual(tokenOrigin('{{ _.o.b }}', merged, local), 'local');
    assert.strictEqual(tokenOrigin('{{ _.nope }}', merged, local), 'missing');
  });
});
