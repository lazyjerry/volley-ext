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
import * as YAML from 'yaml';
import { CollectionStore } from './storage/collectionStore';
import { StateStore } from './storage/stateStore';
import { findConflictedCopies, resolveDataFolder } from './storage/dataFolder';
import type { DataFolderLayout } from './storage/dataFolder';
import { ClientViewProvider } from './views/clientViewProvider';

let collectionStore: CollectionStore | undefined;
let stateStore: StateStore | undefined;

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
  let layout: DataFolderLayout;

  const initStores = (): void => {
    const configured = vscode.workspace
      .getConfiguration('volley')
      .get<string>('dataFolder', '');
    try {
      layout = resolveDataFolder(configured, context.globalStorageUri.fsPath);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Volley：資料夾初始化失敗（${err instanceof Error ? err.message : String(err)}），改用預設儲存空間`,
      );
      layout = resolveDataFolder('', context.globalStorageUri.fsPath);
    }
    collectionStore?.dispose();
    collectionStore = new CollectionStore(layout.collectionsDir);
    collectionStore.loadAll();
    stateStore = new StateStore(layout.stateDir, layout.responsesDir);
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
      path: layout.root,
      isFallback: layout.isFallback,
      conflictedCopies: findConflictedCopies(layout.collectionsDir),
    }),
  });
  provider.attachStoreEvents();

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(ClientViewProvider.viewType, provider),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('volley.dataFolder')) {
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

  register('volley.newCollection', async (presetName) => {
    const name =
      typeof presetName === 'string' && presetName.trim() !== ''
        ? presetName.trim()
        : await vscode.window.showInputBox({ prompt: '新 collection 名稱', value: 'New Collection' });
    if (!name) {
      return;
    }
    const collection = emptyCollection(name);
    collectionStore!.create(collection);
    provider.openCollection(collection.id);
  });

  register('volley.reload', () => {
    collectionStore!.loadAll();
    provider.sendInit();
    void vscode.window.setStatusBarMessage('Volley：已從磁碟重新載入', 3000);
  });

  register('volley.openDataFolder', () => {
    void vscode.env.openExternal(vscode.Uri.file(layout.root));
  });

  const importCollection = (collection: Collection): void => {
    // id 撞現有 collection 時重新產生，避免覆蓋
    if (collectionStore!.get(collection.id)) {
      collection.id = genId('wrk');
    }
    collectionStore!.create(collection);
    provider.openCollection(collection.id);
    void vscode.window.showInformationMessage(`已匯入 collection「${collection.name}」`);
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
