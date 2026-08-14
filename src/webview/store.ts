// webview 端單一 state + 與 extension 的通訊。
// 編輯直接改 state.collection，透過 debounce 的 updateCollection 全量回存。

import type {
  Collection,
  CollectionSummary,
  Folder,
  RequestItem,
  ResponseRecord,
  TreeNode,
  UiState,
} from '../core/model/types';
import { emptyUiState, isFolder, walkRequests } from '../core/model/types';
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

export interface AppState {
  collections: CollectionSummary[];
  collection: Collection | null;
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
  envEditor: null | { target: 'collection' | { folderId: string }; selectedEnvId: string | 'base'; rawMode: boolean; dirty: boolean };
  renamingNodeId: string | null;
  notice: { level: string; message: string } | null;
}

export const state: AppState = {
  collections: [],
  collection: null,
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
  notice: null,
};

let renderFn: () => void = () => undefined;

export function setRenderFn(fn: () => void): void {
  renderFn = fn;
}

export function render(): void {
  renderFn();
}

export function notice(level: string, message: string): void {
  state.notice = { level, message };
  render();
  setTimeout(() => {
    if (state.notice?.message === message) {
      state.notice = null;
      render();
    }
  }, 6000);
}

// ---- 持久化 ----

let persistTimer: ReturnType<typeof setTimeout> | undefined;
let pendingCollection: Collection | undefined;
let uiTimer: ReturnType<typeof setTimeout> | undefined;
let pendingUi: { collectionId: string; state: UiState } | undefined;
let editRevision = 0;

export function hasPendingEdits(): boolean {
  return persistTimer !== undefined;
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

/** webview 離開前立即送出 debounce 中的編輯。 */
export function flushPendingEdits(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  persistPendingEdits();
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
