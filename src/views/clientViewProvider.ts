import * as vscode from 'vscode';
import type { Collection } from '../core/model/types';
import { findFolderChain, findRequest } from '../core/model/types';
import { resolveEnvironment } from '../core/vars/environment';
import { buildRequest } from '../core/http/buildRequest';
import { sendRequest } from '../core/http/httpClient';
import { importCurl } from '../core/formats/curlImport';
import { exportCurl } from '../core/formats/curlExport';
import type { DualCollectionStore, DualStateStore } from '../storage/dualStore';
import type { ClientConfig, ClientMessage, DataFolderInfo, HostMessage } from '../shared/protocol';
import { isClientMessage } from '../shared/protocol';

export interface ProviderDeps {
  collectionStore: DualCollectionStore;
  stateStore: DualStateStore;
  getDataFolderInfo: () => { shared: DataFolderInfo; private: DataFolderInfo; conflictedCopies: string[] };
}

export class ClientViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'volley.client';

  private view: vscode.WebviewView | undefined;
  private activeCollectionId: string | null = null;
  private readonly inFlight = new Map<string, AbortController>();
  private storeDisposables: Array<{ dispose(): void }> = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: ProviderDeps,
  ) {}

  /** 訂閱目前 collectionStore 的事件；dataFolder 變更重建 store 後需再次呼叫。 */
  attachStoreEvents(): void {
    for (const d of this.storeDisposables) {
      d.dispose();
    }
    const store = this.deps.collectionStore;
    this.storeDisposables = [
      store.onExternalChange((collection) => {
        if (collection.id === this.activeCollectionId) {
          this.post({ type: 'collectionChangedOnDisk', collection });
        }
      }),
      store.onListChange(() => {
        this.post({ type: 'collectionListChanged', collections: store.list() });
      }),
      store.onError((message) => {
        this.post({ type: 'notice', level: 'error', message });
      }),
    ];
  }

  get activeCollection(): Collection | undefined {
    return this.activeCollectionId
      ? this.deps.collectionStore.get(this.activeCollectionId)
      : undefined;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (isClientMessage(message)) {
        void this.handleMessage(message);
      }
    });
    // 沒有檔案輪詢：面板重新可見時才比對磁碟，補上不在前景時發生的外部變更
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.deps.collectionStore.checkDisk();
      }
    });
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  /** 匯入完成後開啟指定 collection。 */
  openCollection(collectionId: string): void {
    this.activeCollectionId = collectionId;
    const collection = this.deps.collectionStore.get(collectionId);
    if (collection) {
      this.post({
        type: 'collectionLoaded',
        collection,
        uiState: this.deps.stateStore.loadUiState(collectionId),
      });
    }
  }

  notice(level: 'info' | 'warn' | 'error', message: string): void {
    this.post({ type: 'notice', level, message });
  }

  sendInit(): void {
    const info = this.deps.getDataFolderInfo();
    const config: ClientConfig = {
      dataFolders: { shared: info.shared, private: info.private },
      requestTimeoutMs: this.getConfig<number>('requestTimeoutMs', 30000),
      responseHistoryLimit: this.getConfig<number>('responseHistoryLimit', 20),
    };
    const collections = this.deps.collectionStore.list();
    if (!this.activeCollectionId && collections.length > 0) {
      this.activeCollectionId = collections[0].id;
    }
    const active = this.activeCollection ?? null;
    this.post({
      type: 'init',
      collections,
      activeCollection: active,
      uiState: active ? this.deps.stateStore.loadUiState(active.id) : null,
      config,
      conflictedCopies: info.conflictedCopies,
    });
  }

  private getConfig<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('volley').get<T>(key, fallback);
  }

  private async handleMessage(message: ClientMessage): Promise<void> {
    const { collectionStore, stateStore } = this.deps;
    switch (message.type) {
      case 'ready':
        this.sendInit();
        break;
      case 'selectCollection':
        this.openCollection(message.collectionId);
        break;
      case 'createCollection':
        await vscode.commands.executeCommand('volley.newCollection', message.name, message.source);
        break;
      case 'openDataFolder':
        await vscode.commands.executeCommand('volley.openDataFolder', message.source);
        break;
      case 'chooseDataFolder':
        await vscode.commands.executeCommand('volley.chooseDataFolder', message.source);
        break;
      case 'renameCollection': {
        const target = collectionStore.get(message.collectionId);
        if (!target) {
          break;
        }
        const name = await vscode.window.showInputBox({
          prompt: 'Collection 名稱',
          value: target.name,
          validateInput: (value) => value.trim() === '' ? '名稱不能為空' : undefined,
        });
        const trimmedName = name?.trim();
        if (!trimmedName || trimmedName === target.name) {
          break;
        }
        const renamed = JSON.parse(JSON.stringify(target)) as Collection;
        renamed.name = trimmedName;
        renamed.modified = Date.now();
        collectionStore.update(renamed);
        this.openCollection(renamed.id);
        break;
      }
      case 'confirmDeleteFolder': {
        const total = message.requestCount + message.folderCount;
        const detail = message.folderCount > 0
          ? `內含 ${message.requestCount} 個 request、${message.folderCount} 個子資料夾。`
          : `內含 ${message.requestCount} 個 request。`;
        const deleteAll = `連同內容一起刪除（${total} 項）`;
        const keepChildren = '只刪資料夾，內容移到上一層';
        const choice = await vscode.window.showWarningMessage(
          `刪除資料夾「${message.name}」？`,
          { modal: true, detail },
          deleteAll,
          keepChildren,
        );
        if (choice === deleteAll || choice === keepChildren) {
          this.post({
            type: 'folderDeleteConfirmed',
            folderId: message.folderId,
            mode: choice === deleteAll ? 'all' : 'folderOnly',
          });
        }
        break;
      }
      case 'showNotice': {
        if (message.level === 'error') {
          void vscode.window.showErrorMessage(message.message);
        } else if (message.level === 'warn') {
          void vscode.window.showWarningMessage(message.message);
        } else {
          void vscode.window.showInformationMessage(message.message);
        }
        break;
      }
      case 'deleteCollection': {
        const target = collectionStore.get(message.collectionId);
        const choice = await vscode.window.showWarningMessage(
          `刪除 collection「${target?.name ?? message.collectionId}」？檔案將自資料夾移除。`,
          { modal: true },
          '刪除',
        );
        if (choice === '刪除') {
          collectionStore.delete(message.collectionId);
          stateStore.deleteCollectionState(message.collectionId);
          if (this.activeCollectionId === message.collectionId) {
            this.activeCollectionId = null;
          }
          this.sendInit();
        }
        break;
      }
      case 'updateCollection':
        collectionStore.update(message.collection);
        break;
      case 'updateUiState':
        stateStore.saveUiState(message.collectionId, message.state);
        break;
      case 'sendRequest':
        await this.executeRequest(message.collectionId, message.requestId);
        break;
      case 'cancelRequest':
        this.inFlight.get(message.requestId)?.abort();
        break;
      case 'loadHistory':
        this.post({
          type: 'historyLoaded',
          requestId: message.requestId,
          records: stateStore.loadHistory(message.collectionId, message.requestId),
        });
        break;
      case 'clearHistory':
        stateStore.clearHistory(message.collectionId, message.requestId);
        this.post({ type: 'historyLoaded', requestId: message.requestId, records: [] });
        break;
      case 'importCurlText':
        this.importCurlInto(message.collectionId, message.folderId, message.text);
        break;
      case 'exportCurl': {
        const collection = collectionStore.get(message.collectionId);
        const request = collection ? findRequest(collection.children, message.requestId) : undefined;
        if (!collection || !request) {
          break;
        }
        const uiState = stateStore.loadUiState(collection.id);
        const env = resolveEnvironment(
          collection,
          uiState.activeEnvironmentId,
          findFolderChain(collection.children, request.id),
        );
        const text = exportCurl(request, env);
        if (message.copyToClipboard) {
          await vscode.env.clipboard.writeText(text);
          this.notice('info', '已複製 curl 指令到剪貼簿');
        }
        this.post({ type: 'curlExported', requestId: request.id, text });
        break;
      }
      case 'runCommand':
        await vscode.commands.executeCommand(`volley.${message.command}`);
        break;
    }
  }

  importCurlInto(_collectionId: string, folderId: string | null, text: string): void {
    try {
      const request = importCurl(text);
      this.post({ type: 'requestInserted', request, folderId });
    } catch (err) {
      this.notice('error', `curl 解析失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async executeRequest(collectionId: string, requestId: string): Promise<void> {
    const { collectionStore, stateStore } = this.deps;
    const collection = collectionStore.get(collectionId);
    const request = collection ? findRequest(collection.children, requestId) : undefined;
    if (!collection || !request) {
      this.notice('error', '找不到 request');
      return;
    }
    const controller = new AbortController();
    this.inFlight.set(requestId, controller);
    this.post({ type: 'responseStarted', requestId });
    try {
      const uiState = stateStore.loadUiState(collectionId);
      const folderChain = findFolderChain(collection.children, requestId);
      const env = resolveEnvironment(collection, uiState.activeEnvironmentId, folderChain);
      const built = buildRequest(request, env, folderChain);
      const { record, fullBody } = await sendRequest(
        request,
        built,
        collection.cookieJar,
        {
          timeoutMs: this.getConfig<number>('requestTimeoutMs', 30000),
          followRedirectsGlobal: this.getConfig<boolean>('followRedirects', true),
          maxRedirects: this.getConfig<number>('maxRedirects', 10),
          maxStoredBodyBytes: this.getConfig<number>('maxStoredBodyBytes', 262144),
        },
        controller.signal,
      );
      // cookie jar 可能已被更新 → 合併回「目前」collection（避免蓋掉送出期間的編輯）再落檔
      const current = collectionStore.get(collectionId) ?? collection;
      current.cookieJar = collection.cookieJar;
      collectionStore.update(current);
      const history = stateStore.appendResponse(
        collectionId,
        record,
        this.getConfig<number>('responseHistoryLimit', 20),
      );
      // fullBody 供當次 Preview 顯示；過大時退回截斷版，避免 postMessage 拖垮 webview
      const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
      this.post({
        type: 'responseFinished',
        requestId,
        record,
        fullBody: fullBody.length > MAX_PREVIEW_BYTES ? record.body : fullBody,
        history,
        cookieJar: current.cookieJar,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const record = {
        id: `res_${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16)}`,
        requestId,
        at: Date.now(),
        durationMs: 0,
        method: request.method,
        url: request.url,
        status: 0,
        statusText: '',
        requestHeaders: [],
        responseHeaders: [],
        bodyEncoding: 'utf8' as const,
        body: '',
        bodySize: 0,
        bodyTruncated: false,
        error: message,
      };
      const history = stateStore.appendResponse(
        collectionId,
        record,
        this.getConfig<number>('responseHistoryLimit', 20),
      );
      this.post({
        type: 'responseFinished',
        requestId,
        record,
        fullBody: '',
        history,
        cookieJar: collection.cookieJar,
      });
    } finally {
      this.inFlight.delete(requestId);
    }
  }

  dispose(): void {
    for (const d of this.storeDisposables) {
      d.dispose();
    }
    for (const controller of this.inFlight.values()) {
      controller.abort();
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon', 'codicon.css'));
    const nonce = createNonce();
    return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${codiconUri}" rel="stylesheet">
  <link href="${styleUri}" rel="stylesheet">
  <title>Volley</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
