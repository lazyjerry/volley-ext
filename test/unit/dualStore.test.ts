// DualCollectionStore / DualStateStore：共用／私人分流與隔離。

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CollectionStore } from '../../src/storage/collectionStore';
import { StateStore } from '../../src/storage/stateStore';
import { DualCollectionStore, DualStateStore } from '../../src/storage/dualStore';
import { resolveDataFolder } from '../../src/storage/dataFolder';
import { genId } from '../../src/core/model/ids';
import type { Collection } from '../../src/core/model/types';
import { emptyUiState } from '../../src/core/model/types';

function makeCollection(name: string): Collection {
  const now = Date.now();
  return {
    id: genId('wrk'),
    name,
    created: now,
    modified: now,
    servers: [],
    children: [],
    environments: { base: { id: genId('env'), name: 'Base Environment', data: {} }, subEnvironments: [] },
    cookieJar: { id: genId('jar'), name: 'Default Jar', cookies: [] },
  };
}

suite('DualCollectionStore', () => {
  let rootDir: string;
  let dual: DualCollectionStore;
  let sharedLayout: ReturnType<typeof resolveDataFolder>;
  let privateLayout: ReturnType<typeof resolveDataFolder>;

  setup(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volley-dual-'));
    sharedLayout = resolveDataFolder(path.join(rootDir, 'shared'), rootDir);
    privateLayout = resolveDataFolder(path.join(rootDir, 'private'), rootDir);
    dual = new DualCollectionStore(
      new CollectionStore(sharedLayout.collectionsDir),
      new CollectionStore(privateLayout.collectionsDir),
    );
    dual.loadAll();
  });

  teardown(() => {
    dual.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('create 依 source 落在各自的 collections 目錄，list 標記來源', async () => {
    const a = makeCollection('Shared A');
    const b = makeCollection('Private B');
    dual.create(a, 'shared');
    dual.create(b, 'private');
    await dual.flush();

    assert.strictEqual(fs.readdirSync(sharedLayout.collectionsDir).length, 1);
    assert.strictEqual(fs.readdirSync(privateLayout.collectionsDir).length, 1);

    const list = dual.list();
    assert.strictEqual(list.find((s) => s.id === a.id)?.source, 'shared');
    assert.strictEqual(list.find((s) => s.id === b.id)?.source, 'private');
    assert.strictEqual(dual.sourceOf(a.id), 'shared');
    assert.strictEqual(dual.sourceOf(b.id), 'private');
  });

  test('update 依既有歸屬分流，不會寫進另一個資料夾', async () => {
    const b = makeCollection('Private B');
    dual.create(b, 'private');
    await dual.flush();

    const updated = structuredClone(b);
    updated.name = 'Private B2';
    dual.update(updated);
    await dual.flush();

    assert.strictEqual(fs.readdirSync(sharedLayout.collectionsDir).length, 0);
    assert.strictEqual(dual.get(b.id)?.name, 'Private B2');
  });

  test('delete 後 sourceOf 仍記得最後歸屬（供 state 清理分流）', async () => {
    const b = makeCollection('Private B');
    dual.create(b, 'private');
    await dual.flush();
    dual.delete(b.id);
    await dual.flush();
    assert.strictEqual(dual.get(b.id), undefined);
    assert.strictEqual(dual.sourceOf(b.id), 'private');
  });

  test('DualStateStore 依 collection 來源把 ui state 寫進對應 state 目錄', async () => {
    const a = makeCollection('Shared A');
    const b = makeCollection('Private B');
    dual.create(a, 'shared');
    dual.create(b, 'private');
    await dual.flush();

    const states = new DualStateStore(
      new StateStore(sharedLayout.stateDir, sharedLayout.responsesDir),
      new StateStore(privateLayout.stateDir, privateLayout.responsesDir),
      (id) => dual.sourceOf(id),
    );
    states.saveUiState(a.id, { ...emptyUiState(), selectedRequestId: 'req_a' });
    states.saveUiState(b.id, { ...emptyUiState(), selectedRequestId: 'req_b' });
    states.flush();

    assert.ok(fs.existsSync(path.join(sharedLayout.stateDir, `${a.id}.ui.json`)));
    assert.ok(!fs.existsSync(path.join(sharedLayout.stateDir, `${b.id}.ui.json`)));
    assert.ok(fs.existsSync(path.join(privateLayout.stateDir, `${b.id}.ui.json`)));
    assert.strictEqual(states.loadUiState(b.id).selectedRequestId, 'req_b');
  });
});
