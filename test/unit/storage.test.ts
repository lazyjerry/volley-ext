import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Collection } from '../../src/core/model/types';
import { parseCollection, serializeCollection } from '../../src/core/formats/openapiStore';
import { CollectionStore } from '../../src/storage/collectionStore';
import { StateStore } from '../../src/storage/stateStore';
import { collectionFileName, countCollectionFiles, resolveDataFolder, slugify } from '../../src/storage/dataFolder';
import { sampleCollection } from './helpers';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'volley-test-'));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('storage/dataFolder', () => {
  test('resolveDataFolder 建立目錄結構與版本標記', () => {
    const dir = tmpDir();
    const layout = resolveDataFolder(path.join(dir, 'data'), '/unused');
    assert.ok(fs.existsSync(layout.collectionsDir));
    assert.ok(fs.existsSync(layout.responsesDir));
    const marker = JSON.parse(fs.readFileSync(path.join(layout.root, '.volley.json'), 'utf8')) as { formatVersion: number };
    assert.strictEqual(marker.formatVersion, 1);
    assert.strictEqual(layout.isFallback, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('空值 → fallback', () => {
    const dir = tmpDir();
    const layout = resolveDataFolder('', path.join(dir, 'fb'));
    assert.strictEqual(layout.isFallback, true);
    assert.ok(layout.root.endsWith('fb'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('countCollectionFiles 只計 collections 下的 yaml/yml', () => {
    const dir = tmpDir();
    assert.strictEqual(countCollectionFiles(dir), 0); // 沒有 collections 子目錄
    const collectionsDir = path.join(dir, 'collections');
    fs.mkdirSync(collectionsDir);
    assert.strictEqual(countCollectionFiles(dir), 0); // 空目錄
    fs.writeFileSync(path.join(collectionsDir, 'a.openapi.yaml'), 'x');
    fs.writeFileSync(path.join(collectionsDir, 'b.YML'), 'x');
    fs.writeFileSync(path.join(collectionsDir, 'note.txt'), 'x');
    assert.strictEqual(countCollectionFiles(dir), 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('slugify / collectionFileName', () => {
    assert.strictEqual(slugify('My API 測試!'), 'my-api-測試');
    assert.ok(collectionFileName('My API', 'wrk_abcdef123456').endsWith('-123456.openapi.yaml'));
  });
});

suite('storage/collectionStore', () => {
  test('create 落檔、loadAll 讀回', async () => {
    const dir = tmpDir();
    const store = new CollectionStore(dir);
    const c = sampleCollection();
    store.create(c);
    await store.flush();
    const store2 = new CollectionStore(dir);
    const loaded = store2.loadAll();
    assert.strictEqual(loaded.length, 1);
    assert.deepStrictEqual(loaded[0], c);
    store.dispose();
    store2.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('update debounce：連續更新只寫最終版', async () => {
    const dir = tmpDir();
    const store = new CollectionStore(dir);
    const c = sampleCollection();
    store.create(c);
    await store.flush();
    for (let i = 0; i < 5; i++) {
      const copy = JSON.parse(JSON.stringify(c)) as Collection;
      copy.name = `Name ${i}`;
      store.update(copy);
    }
    await wait(700);
    await store.flush();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.ok(text.includes('Name 4'));
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'tmp 檔應已 rename');
    store.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('更新 collection 名稱會同步 list 並持久化', async () => {
    const dir = tmpDir();
    const store = new CollectionStore(dir);
    const original = sampleCollection();
    store.create(original);
    await store.flush();

    const renamed = JSON.parse(JSON.stringify(original)) as Collection;
    renamed.name = 'Renamed Collection';
    store.update(renamed);

    assert.strictEqual(store.list()[0].name, 'Renamed Collection');
    await store.flush();
    const reloadedStore = new CollectionStore(dir);
    assert.strictEqual(reloadedStore.loadAll()[0].name, 'Renamed Collection');

    store.dispose();
    reloadedStore.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('環境變數 update + flush 後可由新 store 讀回', async () => {
    const dir = tmpDir();
    const store = new CollectionStore(dir);
    const c = sampleCollection();
    store.create(c);
    await store.flush();

    const updated = JSON.parse(JSON.stringify(c)) as Collection;
    updated.environments.base.data = { base_url: 'https://reload.example.com', token: 'saved' };
    updated.environments.subEnvironments[0].data = { token: 'production-saved' };
    store.update(updated);
    await store.flush();

    const reloadedStore = new CollectionStore(dir);
    const [reloaded] = reloadedStore.loadAll();
    assert.deepStrictEqual(reloaded.environments, updated.environments);
    store.dispose();
    reloadedStore.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('外部變更觸發 onExternalChange；自寫不觸發', async () => {
    const dir = tmpDir();
    const store = new CollectionStore(dir);
    const c = sampleCollection();
    store.create(c);
    await store.flush();
    const events: Collection[] = [];
    store.onExternalChange((col) => events.push(col));

    // 自寫：不應觸發
    const copy = JSON.parse(JSON.stringify(c)) as Collection;
    copy.name = 'self-write';
    store.update(copy);
    await wait(1300);
    await store.flush();
    assert.strictEqual(events.length, 0, '自寫不應觸發外部變更事件');

    // 模擬外部（Dropbox）改寫
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    const filePath = path.join(dir, files[0]);
    const external = JSON.parse(JSON.stringify(copy)) as Collection;
    external.name = 'external-edit';
    await wait(50);
    fs.writeFileSync(filePath, serializeCollection(external), 'utf8');
    const changedTime = new Date();
    fs.utimesSync(filePath, changedTime, changedTime);
    await wait(1500);
    assert.strictEqual(events.length, 1, '外部變更應觸發一次');
    assert.strictEqual(events[0].name, 'external-edit');
    store.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('delete 移除檔案', async () => {
    const dir = tmpDir();
    const store = new CollectionStore(dir);
    const c = sampleCollection();
    store.create(c);
    await store.flush();
    store.delete(c.id);
    await store.flush();
    assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).length, 0);
    store.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('落檔內容可被 parseCollection 直接讀取（格式即 OpenAPI）', async () => {
    const dir = tmpDir();
    const store = new CollectionStore(dir);
    const c = sampleCollection();
    store.create(c);
    await store.flush();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.ok(text.startsWith('openapi:'), 'OpenAPI 檔頭');
    assert.deepStrictEqual(parseCollection(text), c);
    store.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

suite('storage/stateStore', () => {
  test('ui state 讀寫與 flush', async () => {
    const dir = tmpDir();
    const store = new StateStore(dir, path.join(dir, 'responses'));
    store.saveUiState('wrk_x', { activeEnvironmentId: 'env_1', selectedRequestId: 'req_1', expandedFolders: ['fld_1'] });
    store.flush();
    const loaded = store.loadUiState('wrk_x');
    assert.strictEqual(loaded.activeEnvironmentId, 'env_1');
    assert.deepStrictEqual(loaded.expandedFolders, ['fld_1']);
    assert.deepStrictEqual(store.loadUiState('wrk_none').expandedFolders, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('response history：新在前、上限輪替、清除', () => {
    const dir = tmpDir();
    const store = new StateStore(dir, path.join(dir, 'responses'));
    const mk = (i: number) => ({
      id: `res_${i}`, requestId: 'req_1', at: i, durationMs: 1, method: 'GET', url: 'http://x',
      status: 200, statusText: 'OK', requestHeaders: [], responseHeaders: [],
      bodyEncoding: 'utf8' as const, body: '', bodySize: 0, bodyTruncated: false,
    });
    for (let i = 0; i < 5; i++) {
      store.appendResponse('wrk_x', mk(i), 3);
    }
    const history = store.loadHistory('wrk_x', 'req_1');
    assert.strictEqual(history.length, 3);
    assert.strictEqual(history[0].id, 'res_4', '最新在前');
    store.clearHistory('wrk_x', 'req_1');
    assert.strictEqual(store.loadHistory('wrk_x', 'req_1').length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
