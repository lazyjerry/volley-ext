import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { genId } from './core/model/ids';
import type { Collection } from './core/model/types';
import { parseCollection, serializeCleanOpenApi } from './core/formats/openapiStore';
import { exportInsomniaV5, importInsomniaV5, isInsomniaV5 } from './core/formats/insomniaV5';
import { importInsomniaV4, isInsomniaV4 } from './core/formats/insomniaV4';
import { importOpenApi } from './core/formats/openapiImport';
import { downloadText, parseImportedText } from './core/formats/urlImport';
import * as YAML from 'yaml';
import type { CollectionSource } from './core/model/types';
import { CollectionStore } from './storage/collectionStore';
import { StateStore } from './storage/stateStore';
import { DualCollectionStore, DualStateStore } from './storage/dualStore';
import { countCollectionFiles, expandHome, findConflictedCopies, resolveDataFolder } from './storage/dataFolder';
import type { DataFolderLayout } from './storage/dataFolder';
import { ClientViewProvider } from './views/clientViewProvider';

let collectionStore: DualCollectionStore | undefined;
let stateStore: DualStateStore | undefined;

const SOURCE_LABELS: Record<CollectionSource, string> = { shared: '共用', private: '私人' };

function emptyCollection(name: string): Collection {
  const now = Date.now();
  return {
    id: genId('wrk'),
    name,
    created: now,
    modified: now,
    servers: [],
    children: [],
    environments: {
      base: { id: genId('env'), name: 'Base Environment', data: {} },
      subEnvironments: [],
    },
    cookieJar: { id: genId('jar'), name: 'Default Jar', cookies: [] },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  // 共用（volley.dataFolder）與私人（volley.privateDataFolder）雙資料根目錄，嚴格隔離不混用
  const layouts = {} as Record<CollectionSource, DataFolderLayout>;

  const resolveWithFallback = (configured: string, fallbackDir: string): DataFolderLayout => {
    try {
      return resolveDataFolder(configured, fallbackDir);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Volley：資料夾初始化失敗（${err instanceof Error ? err.message : String(err)}），改用預設儲存空間`,
      );
      return resolveDataFolder('', fallbackDir);
    }
  };

  const initStores = (): void => {
    const config = vscode.workspace.getConfiguration('volley');
    const sharedConfigured = config.get<string>('dataFolder', '');
    let privateConfigured = config.get<string>('privateDataFolder', '');
    layouts.shared = resolveWithFallback(sharedConfigured, context.globalStorageUri.fsPath);
    // 兩個根目錄不可指向同一路徑，否則同一批檔案會被兩個 store 重複載入
    const privateTrimmed = privateConfigured.trim();
    if (privateTrimmed !== '' && path.resolve(expandHome(privateTrimmed)) === layouts.shared.root) {
      void vscode.window.showErrorMessage(
        'Volley：私人資料夾（volley.privateDataFolder）與共用資料夾為同一路徑，私人資料夾改用預設儲存空間。',
      );
      privateConfigured = '';
    }
    layouts.private = resolveWithFallback(
      privateConfigured,
      path.join(context.globalStorageUri.fsPath, 'private'),
    );
    collectionStore?.dispose();
    const dual = new DualCollectionStore(
      new CollectionStore(layouts.shared.collectionsDir),
      new CollectionStore(layouts.private.collectionsDir),
    );
    dual.loadAll();
    collectionStore = dual;
    stateStore = new DualStateStore(
      new StateStore(layouts.shared.stateDir, layouts.shared.responsesDir),
      new StateStore(layouts.private.stateDir, layouts.private.responsesDir),
      (id) => dual.sourceOf(id),
    );
  };
  initStores();

  const provider = new ClientViewProvider(context.extensionUri, {
    get collectionStore() {
      return collectionStore!;
    },
    get stateStore() {
      return stateStore!;
    },
    getDataFolderInfo: () => ({
      shared: { path: layouts.shared.root, isFallback: layouts.shared.isFallback },
      private: { path: layouts.private.root, isFallback: layouts.private.isFallback },
      conflictedCopies: [
        ...findConflictedCopies(layouts.shared.collectionsDir).map((f) => `共用/${f}`),
        ...findConflictedCopies(layouts.private.collectionsDir).map((f) => `私人/${f}`),
      ],
    }),
  });
  provider.attachStoreEvents();

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(ClientViewProvider.viewType, provider),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('volley.dataFolder') || e.affectsConfiguration('volley.privateDataFolder')) {
        initStores();
        provider.attachStoreEvents();
        provider.sendInit();
      }
    }),
  );

  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  register('volley.open', () =>
    vscode.commands.executeCommand('volley.client.focus'),
  );

  const pickSource = async (): Promise<CollectionSource | undefined> => {
    const picked = await vscode.window.showQuickPick(
      (['shared', 'private'] as const).map((source) => ({
        label: `${SOURCE_LABELS[source]}資料夾`,
        description: layouts[source].root,
        source,
      })),
      { title: '選擇存放位置' },
    );
    return picked?.source;
  };

  register('volley.newCollection', async (presetName, presetSource) => {
    const source =
      presetSource === 'shared' || presetSource === 'private' ? presetSource : await pickSource();
    if (!source) {
      return;
    }
    const name =
      typeof presetName === 'string' && presetName.trim() !== ''
        ? presetName.trim()
        : await vscode.window.showInputBox({ prompt: `新 collection 名稱（${SOURCE_LABELS[source]}）`, value: 'New Collection' });
    if (!name) {
      return;
    }
    const collection = emptyCollection(name);
    collectionStore!.create(collection, source);
    provider.openCollection(collection.id);
  });

  register('volley.reload', () => {
    collectionStore!.loadAll();
    provider.sendInit();
    void vscode.window.setStatusBarMessage('Volley：已從磁碟重新載入', 3000);
  });

  register('volley.chooseDataFolder', async (presetSource) => {
    const source =
      presetSource === 'shared' || presetSource === 'private' ? presetSource : await pickSource();
    if (!source) {
      return;
    }
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: `設為${SOURCE_LABELS[source]}資料夾`,
      title: `選擇 Volley ${SOURCE_LABELS[source]}資料夾`,
      defaultUri: layouts[source].isFallback ? undefined : vscode.Uri.file(layouts[source].root),
    });
    if (!uris?.[0]) {
      return;
    }
    const picked = path.resolve(uris[0].fsPath);
    const other = source === 'shared' ? 'private' : 'shared';
    if (picked === layouts[other].root) {
      void vscode.window.showErrorMessage(
        `Volley：該路徑已是${SOURCE_LABELS[other]}資料夾，兩個資料夾不可相同。`,
      );
      return;
    }
    const existing = countCollectionFiles(picked);
    if (existing > 0) {
      const confirm = await vscode.window.showWarningMessage(
        `該資料夾已包含 ${existing} 個 collection，設為${SOURCE_LABELS[source]}資料夾後將一併載入。要繼續嗎？`,
        { modal: true },
        '繼續',
      );
      if (confirm !== '繼續') {
        return;
      }
    }
    const key = source === 'shared' ? 'dataFolder' : 'privateDataFolder';
    // 寫入設定後由 onDidChangeConfiguration 重建 stores 並刷新畫面
    await vscode.workspace
      .getConfiguration('volley')
      .update(key, picked, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`Volley：${SOURCE_LABELS[source]}資料夾已設為 ${picked}`);
  });

  register('volley.openDataFolder', async (presetSource) => {
    const source =
      presetSource === 'shared' || presetSource === 'private' ? presetSource : await pickSource();
    if (!source) {
      return;
    }
    void vscode.env.openExternal(vscode.Uri.file(layouts[source].root));
  });

  const importCollection = (collection: Collection): void => {
    // id 撞現有 collection 時重新產生，避免覆蓋
    if (collectionStore!.get(collection.id)) {
      collection.id = genId('wrk');
    }
    // 匯入落在目前作用中 collection 的同一個資料夾；沒有作用中時進共用
    const active = provider.activeCollection;
    const source = (active && collectionStore!.sourceOf(active.id)) || 'shared';
    collectionStore!.create(collection, source);
    provider.openCollection(collection.id);
    void vscode.window.showInformationMessage(
      `已匯入 collection「${collection.name}」（${SOURCE_LABELS[source]}資料夾）`,
    );
  };

  register('volley.importInsomnia', async () => {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'Insomnia 匯出檔': ['yaml', 'yml', 'json'] },
      title: '選擇 Insomnia v5 YAML 或 v4 JSON 匯出檔',
    });
    if (!uris?.[0]) {
      return;
    }
    try {
      const text = fs.readFileSync(uris[0].fsPath, 'utf8');
      const doc = YAML.parse(text) as unknown;
      let collection: Collection;
      if (isInsomniaV4(doc)) {
        collection = importInsomniaV4(text);
      } else if (isInsomniaV5(doc)) {
        collection = importInsomniaV5(text);
      } else {
        throw new Error('無法辨識為 Insomnia v5 或 v4 匯出檔');
      }
      importCollection(collection);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `匯入失敗：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  register('volley.importOpenApi', async () => {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'OpenAPI 文件': ['yaml', 'yml', 'json'] },
      title: '選擇 OpenAPI 3.x 文件',
    });
    if (!uris?.[0]) {
      return;
    }
    try {
      const text = fs.readFileSync(uris[0].fsPath, 'utf8');
      // 本延伸模組產生的檔（含 x-volley）走原生解析，保留完整資訊
      const doc = YAML.parse(text) as Record<string, unknown>;
      const info = doc?.info as Record<string, unknown> | undefined;
      const collection = info?.['x-volley'] ? parseCollection(text) : importOpenApi(text);
      importCollection(collection);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `匯入失敗：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  register('volley.importFromUrl', async () => {
    const url = await vscode.window.showInputBox({
      title: '從網址匯入',
      prompt: '輸入 Insomnia v5/v4、OpenAPI 3.x 或 Volley 匯出檔的網址',
      placeHolder: 'https://example.com/collection.yaml',
      ignoreFocusOut: true,
    });
    if (!url?.trim()) {
      return;
    }
    try {
      const text = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Volley：正在下載匯入檔…' },
        () => downloadText(url.trim()),
      );
      importCollection(parseImportedText(text));
    } catch (err) {
      void vscode.window.showErrorMessage(
        `匯入失敗：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  register('volley.importCurl', async () => {
    const text = await vscode.env.clipboard.readText();
    if (!text.trim().toLowerCase().startsWith('curl')) {
      void vscode.window.showWarningMessage('剪貼簿內容不是 curl 指令');
      return;
    }
    const active = provider.activeCollection;
    if (!active) {
      void vscode.window.showWarningMessage('請先建立或選擇一個 collection');
      return;
    }
    provider.importCurlInto(active.id, null, text);
    await vscode.commands.executeCommand('volley.client.focus');
  });

  const pickCollection = async (): Promise<Collection | undefined> => {
    const active = provider.activeCollection;
    if (active) {
      return active;
    }
    const items = collectionStore!.list().map((c) => ({ label: c.name, id: c.id }));
    if (items.length === 0) {
      void vscode.window.showWarningMessage('目前沒有任何 collection');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(items, { title: '選擇要匯出的 collection' });
    return picked ? collectionStore!.get(picked.id) : undefined;
  };

  register('volley.exportInsomniaYaml', async () => {
    const collection = await pickCollection();
    if (!collection) {
      return;
    }
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `${collection.name}.insomnia.yaml`)),
      filters: { 'Insomnia v5 YAML': ['yaml'] },
    });
    if (!uri) {
      return;
    }
    fs.writeFileSync(uri.fsPath, exportInsomniaV5(collection), 'utf8');
    void vscode.window.showInformationMessage(`已匯出 Insomnia v5 YAML：${uri.fsPath}`);
  });

  register('volley.exportOpenApi', async () => {
    const collection = await pickCollection();
    if (!collection) {
      return;
    }
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `${collection.name}.openapi.yaml`)),
      filters: { 'OpenAPI YAML': ['yaml'] },
    });
    if (!uri) {
      return;
    }
    fs.writeFileSync(uri.fsPath, serializeCleanOpenApi(collection), 'utf8');
    void vscode.window.showInformationMessage(`已匯出 OpenAPI：${uri.fsPath}`);
  });
}

export async function deactivate(): Promise<void> {
  stateStore?.flush();
  await collectionStore?.flush();
  collectionStore?.dispose();
}
