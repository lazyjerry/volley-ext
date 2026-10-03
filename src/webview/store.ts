// webview 端單一 state + 與 extension 的通訊。
// 編輯直接改 state.collection，透過 debounce 的 updateCollection 全量回存。

import type {
  Collection,
  CollectionSummary,
  Folder,
  GlobalEnvironment,
  RequestItem,
  ResponseRecord,
  TreeNode,
  UiState,
} from '../core/model/types';
import { emptyGlobalEnvironment, emptyUiState, isFolder, walkRequests } from '../core/model/types';
import type { ClientConfig, ClientMessage } from '../shared/protocol';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

export const vscode = acquireVsCodeApi();

export function post(message: ClientMessage): void {
  vscode.postMessage(message);
}

export type NarrowTab = 'sidebar' | 'request' | 'response';

export type FindKey = 'sidebar' | 'request' | 'response' | 'env';

/** 面板內搜尋的暫時狀態；不進 UiState，不落磁碟。 */
export interface FindState {
  open: boolean;
  query: string;
  /** 目前停在第幾個命中（0-based），巡覽時由 applyFind 夾回範圍內 */
  index: number;
  matchCase: boolean;
  /** 面板重繪前搜尋框是否有焦點；重繪後據此把焦點與 caret 還回去 */
  focused: boolean;
  caret: number;
  /** 再按一次 Cmd/Ctrl+F：重繪後把既有查詢字串全選，直接打字即可換字 */
  selectAll: boolean;
}

export function emptyFindState(): FindState {
  return { open: false, query: '', index: 0, matchCase: false, focused: false, caret: 0, selectAll: false };
}

export interface AppState {
  collections: CollectionSummary[];
  collection: Collection | null;
  /** 作用中 collection 所屬資料根的共用環境（跨 collection 共用，另存一檔） */
  globalEnv: GlobalEnvironment;
  ui: UiState;
  config: ClientConfig | null;
  conflictedCopies: string[];
  isNarrow: boolean;
  narrowTab: NarrowTab;
  requestTab: string;
  responseTab: string;
  responseViewMode: 'pretty' | 'raw';
  sending: Set<string>;
  historyByRequest: Map<string, ResponseRecord[]>;
  fullBodyByResponseId: Map<string, string>;
  variablePreview: { result: string; missing: string[] } | null;
  /** rawMode：off = 表格；full = 含註解的包裝 JSON；dataOnly = 純變數 map */
  envEditor: null | { target: 'collection' | { folderId: string }; selectedEnvId: string | 'base' | 'global'; rawMode: 'off' | 'full' | 'dataOnly'; dirty: boolean };
  renamingNodeId: string | null;
  find: Record<FindKey, FindState>;
}

export const state: AppState = {
  collections: [],
  collection: null,
  globalEnv: emptyGlobalEnvironment(),
  ui: emptyUiState(),
  config: null,
  conflictedCopies: [],
  isNarrow: false,
  narrowTab: 'sidebar',
  requestTab: 'params',
  responseTab: 'preview',
  responseViewMode: 'pretty',
  sending: new Set(),
  historyByRequest: new Map(),
  fullBodyByResponseId: new Map(),
  variablePreview: null,
  envEditor: null,
  renamingNodeId: null,
  find: {
    sidebar: emptyFindState(),
    request: emptyFindState(),
    response: emptyFindState(),
    env: emptyFindState(),
  },
};

let renderFn: () => void = () => undefined;

export function setRenderFn(fn: () => void): void {
  renderFn = fn;
}

export function render(): void {
  renderFn();
}

/** 通知一律交給 host 以 VS Code 右下角 toast 顯示；面板內不放通知列，避免版面上下晃動。 */
export function notice(level: 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'showNotice', level, message });
}

/** 使用者是否正停在可編輯欄位裡（全量 render 會把它連同 caret 一起換掉）。 */
export function editableField(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (target instanceof HTMLTextAreaElement) {
    return target.readOnly || target.disabled ? null : target;
  }
  if (target instanceof HTMLInputElement && target.type === 'text') {
    return target.readOnly || target.disabled ? null : target;
  }
  return null;
}

export function isEditing(): boolean {
  return editableField(document.activeElement) !== null;
}

// ---- 持久化 ----

let persistTimer: ReturnType<typeof setTimeout> | undefined;
let pendingCollection: Collection | undefined;
let globalEnvTimer: ReturnType<typeof setTimeout> | undefined;
let pendingGlobalEnv: { collectionId: string; environment: GlobalEnvironment } | undefined;
let uiTimer: ReturnType<typeof setTimeout> | undefined;
let pendingUi: { collectionId: string; state: UiState } | undefined;
let editRevision = 0;

export function hasPendingEdits(): boolean {
  return persistTimer !== undefined;
}

export function hasPendingGlobalEnvEdits(): boolean {
  return globalEnvTimer !== undefined;
}

export function getEditRevision(): number {
  return editRevision;
}

/** 模型變更後呼叫：更新 modified 並 debounce 回存。 */
export function touch(): void {
  const collection = state.collection;
  if (!collection) {
    return;
  }
  collection.modified = Date.now();
  editRevision++;
  pendingCollection = collection;
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    persistPendingEdits();
  }, 300);
}

function persistPendingEdits(): void {
  const collection = pendingCollection;
  pendingCollection = undefined;
  if (collection) {
    post({ type: 'updateCollection', collection: JSON.parse(JSON.stringify(collection)) as Collection });
  }
}

/** 共用環境變更後呼叫：debounce 回存到作用中 collection 所屬資料根。 */
export function touchGlobalEnv(): void {
  const collection = state.collection;
  if (!collection) {
    return;
  }
  editRevision++;
  pendingGlobalEnv = { collectionId: collection.id, environment: state.globalEnv };
  if (globalEnvTimer) {
    clearTimeout(globalEnvTimer);
  }
  globalEnvTimer = setTimeout(() => {
    globalEnvTimer = undefined;
    persistPendingGlobalEnv();
  }, 300);
}

function persistPendingGlobalEnv(): void {
  const update = pendingGlobalEnv;
  pendingGlobalEnv = undefined;
  if (update) {
    post({
      type: 'updateGlobalEnvironment',
      collectionId: update.collectionId,
      environment: JSON.parse(JSON.stringify(update.environment)) as GlobalEnvironment,
    });
  }
}

/** webview 離開前立即送出 debounce 中的編輯。 */
export function flushPendingEdits(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  persistPendingEdits();
  if (globalEnvTimer) {
    clearTimeout(globalEnvTimer);
    globalEnvTimer = undefined;
  }
  persistPendingGlobalEnv();
  if (uiTimer) {
    clearTimeout(uiTimer);
    uiTimer = undefined;
  }
  persistPendingUi();
}

export function touchUi(): void {
  const collection = state.collection;
  if (!collection) {
    return;
  }
  if (uiTimer) {
    clearTimeout(uiTimer);
  }
  pendingUi = { collectionId: collection.id, state: JSON.parse(JSON.stringify(state.ui)) as UiState };
  uiTimer = setTimeout(() => {
    uiTimer = undefined;
    persistPendingUi();
  }, 300);
}

function persistPendingUi(): void {
  const update = pendingUi;
  pendingUi = undefined;
  if (update) {
    post({ type: 'updateUiState', ...update });
  }
}

// ---- 樹操作 ----

export function findNode(children: TreeNode[], id: string): TreeNode | undefined {
  for (const node of children) {
    if (node.id === id) {
      return node;
    }
    if (isFolder(node)) {
      const found = findNode(node.children, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

export function findParentList(children: TreeNode[], id: string): TreeNode[] | undefined {
  for (const node of children) {
    if (node.id === id) {
      return children;
    }
    if (isFolder(node)) {
      const found = findParentList(node.children, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

export function removeNode(children: TreeNode[], id: string): TreeNode | undefined {
  const list = findParentList(children, id);
  if (!list) {
    return undefined;
  }
  const idx = list.findIndex((n) => n.id === id);
  return idx >= 0 ? list.splice(idx, 1)[0] : undefined;
}

function renumber(list: TreeNode[]): void {
  list.forEach((n, i) => {
    n.sortKey = i;
  });
}

/** 移動節點：position 'into' = 進資料夾末端；'before' / 'after' = 目標的前／後。 */
export function moveNode(sourceId: string, targetId: string, position: 'into' | 'before' | 'after'): boolean {
  const collection = state.collection;
  if (!collection || sourceId === targetId) {
    return false;
  }
  const source = findNode(collection.children, sourceId);
  const target = findNode(collection.children, targetId);
  if (!source || !target) {
    return false;
  }
  // 防止把資料夾移進自己的子孫
  if (isFolder(source) && findNode(source.children, targetId)) {
    return false;
  }
  removeNode(collection.children, sourceId);
  if (position === 'into' && isFolder(target)) {
    target.children.push(source);
    renumber(target.children);
  } else {
    const list = findParentList(collection.children, targetId) ?? collection.children;
    const idx = list.findIndex((n) => n.id === targetId);
    const at = idx < 0 ? list.length : position === 'after' ? idx + 1 : idx;
    list.splice(at, 0, source);
    renumber(list);
  }
  touch();
  return true;
}

export function insertNode(node: TreeNode, folderId: string | null): void {
  const collection = state.collection;
  if (!collection) {
    return;
  }
  let list = collection.children;
  if (folderId) {
    const folder = findNode(collection.children, folderId);
    if (folder && isFolder(folder)) {
      list = folder.children;
      if (!state.ui.expandedFolders.includes(folderId)) {
        state.ui.expandedFolders.push(folderId);
        touchUi();
      }
    }
  }
  node.sortKey = list.length;
  list.push(node);
  touch();
}

export function selectedRequest(): RequestItem | undefined {
  const collection = state.collection;
  const id = state.ui.selectedRequestId;
  if (!collection || !id) {
    return undefined;
  }
  const node = findNode(collection.children, id);
  return node && !isFolder(node) ? node : undefined;
}

export function activeHistory(): ResponseRecord[] {
  const id = state.ui.selectedRequestId;
  return id ? (state.historyByRequest.get(id) ?? []) : [];
}

export function activeResponse(): ResponseRecord | undefined {
  const history = activeHistory();
  const requestId = state.ui.selectedRequestId;
  if (!requestId || history.length === 0) {
    return undefined;
  }
  const chosen = state.ui.activeResponseIds?.[requestId];
  return history.find((r) => r.id === chosen) ?? history[0];
}

/** 新增 request 的預設落點：選中 request 的父資料夾。 */
export function currentFolder(): Folder | null {
  const collection = state.collection;
  const id = state.ui.selectedRequestId;
  if (!collection || !id) {
    return null;
  }
  const entry = walkRequests(collection.children).find((e) => e.request.id === id);
  const chain = entry?.folderChain ?? [];
  return chain.length > 0 ? chain[chain.length - 1] : null;
}

// ---- DOM helper ----

type Prop = Record<string, unknown>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Prop = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (key === 'class') {
      node.className = String(value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value as EventListener);
    } else if (key === 'checked' || key === 'disabled' || key === 'value' || key === 'draggable' || key === 'title' || key === 'placeholder' || key === 'type' || key === 'spellcheck') {
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child !== null && child !== undefined) {
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
  }
  return node;
}
