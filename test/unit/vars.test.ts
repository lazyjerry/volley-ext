import * as assert from 'node:assert';
import { containsTemplate, interpolate, parseVarPath } from '../../src/core/vars/template';
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
