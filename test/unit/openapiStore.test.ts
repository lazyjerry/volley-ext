import * as assert from 'node:assert';
import * as YAML from 'yaml';
import { parseCollection, serializeCleanOpenApi, serializeCollection } from '../../src/core/formats/openapiStore';
import { sampleCollection, sampleRequest } from './helpers';

suite('openapiStore', () => {
  test('round-trip：parse(serialize(c)) 與原始深度相等', () => {
    const original = sampleCollection();
    const restored = parseCollection(serializeCollection(original));
    assert.deepStrictEqual(restored, original);
  });

  test('環境變數註解 round-trip（env descriptions 與 folder environmentDescriptions）', () => {
    const c = sampleCollection();
    c.environments.base.descriptions = { base_url: 'API 進入點' };
    c.environments.subEnvironments[0].descriptions = { token: '正式站權杖' };
    const folder = c.children[0];
    if (folder.kind === 'folder') {
      folder.environmentDescriptions = { region: '機房區域' };
    }
    assert.deepStrictEqual(parseCollection(serializeCollection(c)), c);
  });

  test('paths 投影：base_url 變數字首轉為 OpenAPI path', () => {
    const doc = YAML.parse(serializeCollection(sampleCollection())) as Record<string, unknown>;
    const paths = doc.paths as Record<string, unknown>;
    assert.ok(paths['/users'], '/users 應投影進 paths');
    assert.ok(paths['/health'], '絕對 URL 匹配 server 也應投影');
  });

  test('同 path+method 撞位 → 第二筆進 extraRequests', () => {
    const c = sampleCollection();
    c.children.push(
      sampleRequest({
        id: 'req_00000000000000000000000000000009',
        name: 'List users (variant)',
        sortKey: 5,
        url: '{{ _.base_url }}/users',
      }),
    );
    const text = serializeCollection(c);
    const doc = YAML.parse(text) as Record<string, unknown>;
    const ext = doc['x-volley'] as { extraRequests: Array<{ id: string }> };
    assert.strictEqual(ext.extraRequests.length, 1);
    assert.strictEqual(ext.extraRequests[0].id, 'req_00000000000000000000000000000009');
    // round-trip 仍需保真
    const restored = parseCollection(text);
    assert.deepStrictEqual(restored, c);
  });

  test('無法投影的 URL（無 server 字首的相對主機）→ extraRequests', () => {
    const c = sampleCollection();
    c.children.push(
      sampleRequest({
        id: 'req_0000000000000000000000000000000a',
        name: 'Odd',
        sortKey: 6,
        url: '{{ _.host_only }}',
      }),
    );
    const doc = YAML.parse(serializeCollection(c)) as Record<string, unknown>;
    const ext = doc['x-volley'] as { extraRequests: Array<{ id: string }> };
    assert.ok(ext.extraRequests.some((r) => r.id === 'req_0000000000000000000000000000000a'));
    assert.deepStrictEqual(parseCollection(serializeCollection(c)), c);
  });

  test('巢狀資料夾與排序 round-trip', () => {
    const c = sampleCollection();
    const folder = c.children[0];
    if (folder.kind === 'folder') {
      folder.children.push({
        kind: 'folder',
        id: 'fld_00000000000000000000000000000002',
        name: 'Nested',
        sortKey: 2,
        children: [
          sampleRequest({ id: 'req_0000000000000000000000000000000b', name: 'Deep', sortKey: 0, url: '{{ _.base_url }}/deep' }),
        ],
      });
    }
    assert.deepStrictEqual(parseCollection(serializeCollection(c)), c);
  });

  test('外部一般 OpenAPI（無 x-volley）可匯入', () => {
    const external = YAML.stringify({
      openapi: '3.1.0',
      info: { title: 'Petstore', version: '1.0.0' },
      servers: [{ url: 'https://petstore.example.com/v1' }],
      paths: {
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            summary: 'Get a pet',
            tags: ['pets'],
            parameters: [{ name: 'verbose', in: 'query' }, { name: 'petId', in: 'path', required: true }],
          },
        },
      },
    });
    const c = parseCollection(external);
    assert.strictEqual(c.name, 'Petstore');
    assert.strictEqual(c.servers[0], 'https://petstore.example.com/v1');
    const folder = c.children[0];
    assert.strictEqual(folder.kind, 'folder');
    if (folder.kind === 'folder') {
      const req = folder.children[0];
      assert.strictEqual(req.kind, 'request');
      if (req.kind === 'request') {
        assert.strictEqual(req.url, '{{ _.base_url }}/pets/{{ _.petId }}');
        assert.ok(req.parameters.some((p) => p.name === 'verbose'));
        assert.ok(req.pathParameters.some((p) => p.name === 'petId'));
      }
    }
  });

  test('serializeCleanOpenApi 去除所有 x-volley', () => {
    const text = serializeCleanOpenApi(sampleCollection());
    assert.ok(!text.includes('x-volley'));
    const doc = YAML.parse(text) as Record<string, unknown>;
    assert.ok(doc.paths);
  });
});
