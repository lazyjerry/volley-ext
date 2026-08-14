import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { exportInsomniaV5, importInsomniaV5 } from '../../src/core/formats/insomniaV5';
import { importInsomniaV4, isInsomniaV4 } from '../../src/core/formats/insomniaV4';
import { sampleCollection } from './helpers';

const SCHEMA_PATH = path.join(__dirname, '..', '..', '..', 'schemas', 'insomnia.schema.5.1.json');

suite('insomniaV5', () => {
  test('匯出通過官方 JSON Schema 驗證', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as object;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const doc = YAML.parse(exportInsomniaV5(sampleCollection())) as unknown;
    const valid = validate(doc);
    assert.ok(valid, JSON.stringify(validate.errors, null, 2));
  });

  test('匯出 → 匯入 round-trip 保留樹結構與環境', () => {
    const original = sampleCollection();
    const imported = importInsomniaV5(exportInsomniaV5(original));
    assert.strictEqual(imported.id, original.id);
    assert.strictEqual(imported.name, original.name);
    assert.strictEqual(imported.children.length, original.children.length);
    const folder = imported.children[0];
    assert.strictEqual(folder.kind, 'folder');
    if (folder.kind === 'folder') {
      assert.strictEqual(folder.children.length, 2);
      assert.deepStrictEqual(folder.environment, { region: 'tw' });
      const req = folder.children[0];
      if (req.kind === 'request') {
        assert.strictEqual(req.url, '{{ _.base_url }}/users');
        assert.deepStrictEqual(req.authentication, {
          type: 'bearer', token: '{{ _.token }}', prefix: 'Bearer', disabled: false,
        });
        assert.deepStrictEqual(req.settings, original.children[0].kind === 'folder' ? (original.children[0].children[0] as { settings: unknown }).settings : undefined);
      }
    }
    assert.strictEqual(imported.environments.subEnvironments.length, 1);
    assert.strictEqual(imported.environments.subEnvironments[0].name, 'Production');
    assert.deepStrictEqual(imported.environments.base.data, original.environments.base.data);
  });

  test('匯出頂層欄位符合 v5 慣例', () => {
    const doc = YAML.parse(exportInsomniaV5(sampleCollection())) as Record<string, unknown>;
    assert.strictEqual(doc.type, 'collection.insomnia.rest/5.0');
    assert.strictEqual(doc.schema_version, '5.1');
    assert.ok(Array.isArray(doc.collection));
    const folder = (doc.collection as Array<Record<string, unknown>>)[0];
    assert.ok(Array.isArray(folder.children), '資料夾應為巢狀 children');
    const request = (folder.children as Array<Record<string, unknown>>)[0];
    assert.ok(request.settings, 'request 的 settings 必寫');
    assert.ok((request.meta as Record<string, unknown>).id, 'meta.id 必寫');
  });
});

suite('insomniaV4', () => {
  const v4doc = {
    _type: 'export',
    __export_format: 4,
    resources: [
      { _id: 'wrk_a', parentId: null, name: 'V4WS', scope: 'collection', created: 1, modified: 2, _type: 'workspace' },
      { _id: 'fld_a', parentId: 'wrk_a', name: 'folder1', environment: { val: '1' }, metaSortKey: -100, _type: 'request_group' },
      {
        _id: 'req_a', parentId: 'fld_a', url: 'http://localhost:4010/echo', name: 'r1', method: 'POST',
        body: { mimeType: 'application/json', text: '{}' }, parameters: [], headers: [{ name: 'A', value: 'b' }],
        authentication: {}, metaSortKey: -50,
        settingDisableRenderRequestBody: true, settingEncodeUrl: false, settingSendCookies: false,
        settingStoreCookies: true, settingFollowRedirects: 'off', settingRebuildPath: true,
        preRequestScript: 'x();', _type: 'request',
      },
      { _id: 'req_b', parentId: 'wrk_a', url: 'http://x/y', name: 'root-req', method: 'GET', metaSortKey: -10, _type: 'request' },
      { _id: 'env_base', parentId: 'wrk_a', name: 'Base Environment', data: { a: 1 }, _type: 'environment' },
      { _id: 'env_sub', parentId: 'env_base', name: 'Prod', data: { a: 2 }, isPrivate: false, _type: 'environment' },
      { _id: 'jar_a', parentId: 'wrk_a', name: 'Default Jar', cookies: [], _type: 'cookie_jar' },
    ],
  };

  test('判別與樹重建（parentId → 巢狀）', () => {
    assert.ok(isInsomniaV4(v4doc));
    const c = importInsomniaV4(JSON.stringify(v4doc));
    assert.strictEqual(c.id, 'wrk_a');
    assert.strictEqual(c.children.length, 2);
    const folder = c.children.find((n) => n.id === 'fld_a');
    assert.ok(folder && folder.kind === 'folder');
    if (folder && folder.kind === 'folder') {
      assert.strictEqual(folder.children[0].id, 'req_a');
      assert.deepStrictEqual(folder.environment, { val: '1' });
    }
  });

  test('settingDisableRenderRequestBody 布林反轉與 settings 對映', () => {
    const c = importInsomniaV4(JSON.stringify(v4doc));
    const folder = c.children.find((n) => n.id === 'fld_a');
    const req = folder && folder.kind === 'folder' ? folder.children[0] : undefined;
    assert.ok(req && req.kind === 'request');
    if (req && req.kind === 'request') {
      assert.strictEqual(req.settings.renderRequestBody, false, 'disable=true → render=false');
      assert.strictEqual(req.settings.encodeUrl, false);
      assert.strictEqual(req.settings.cookies.send, false);
      assert.strictEqual(req.settings.cookies.store, true);
      assert.strictEqual(req.settings.followRedirects, 'off');
      assert.strictEqual(req.scripts?.preRequest, 'x();');
    }
  });

  test('base / sub environment 依 parentId 判別', () => {
    const c = importInsomniaV4(JSON.stringify(v4doc));
    assert.strictEqual(c.environments.base.id, 'env_base');
    assert.deepStrictEqual(c.environments.base.data, { a: 1 });
    assert.strictEqual(c.environments.subEnvironments.length, 1);
    assert.strictEqual(c.environments.subEnvironments[0].id, 'env_sub');
  });
});
