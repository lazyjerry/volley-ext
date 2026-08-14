// webview 進入點：DOM 骨架、host 訊息處理、渲染協調。

import type { HostMessage } from '../shared/protocol';
import { isHostMessage } from '../shared/protocol';
import { emptyUiState } from '../core/model/types';
import {
  el,
  hasPendingEdits,
  insertNode,
  post,
  render,
  selectedRequest,
  setRenderFn,
  state,
  touch,
  touchUi,
  vscode,
} from './store';
import { applyColumnWidths, applyLayoutClass, initLayout, initSplitters } from './layout';
import { renderSidebar } from './render/sidebar';
import { renderRequestPane } from './render/requestPane';
import { renderResponsePane } from './render/responsePane';
import { renderEnvEditor } from './render/envEditor';

function buildSkeleton(): void {
  const app = document.getElementById('app')!;
  app.replaceChildren(
    el('div', { id: 'notice-bar' }),
    el('div', { id: 'tabbar' }),
    el(
      'div',
      { id: 'main' },
      el('div', { id: 'pane-sidebar', class: 'pane' }),
      el('div', { id: 'split-1', class: 'splitter' }),
      el('div', { id: 'pane-request', class: 'pane' }),
      el('div', { id: 'split-2', class: 'splitter' }),
      el('div', { id: 'pane-response', class: 'pane' }),
    ),
  );
}

function renderTabbar(): void {
  const tabbar = document.getElementById('tabbar')!;
  tabbar.replaceChildren();
  const tabs: Array<[typeof state.narrowTab, string]> = [
    ['sidebar', 'Collection'],
    ['request', 'Request'],
    ['response', 'Response'],
  ];
  for (const [id, label] of tabs) {
    tabbar.append(
      el('button', {
        class: `tab${state.narrowTab === id ? ' active' : ''}`,
        onclick: () => {
          state.narrowTab = id;
          render();
        },
      }, label),
    );
  }
  const panes: Array<[string, typeof state.narrowTab]> = [
    ['pane-sidebar', 'sidebar'],
    ['pane-request', 'request'],
    ['pane-response', 'response'],
  ];
  for (const [paneId, tab] of panes) {
    document.getElementById(paneId)?.classList.toggle('narrow-active', state.narrowTab === tab);
  }
}

function renderNotices(): void {
  const bar = document.getElementById('notice-bar')!;
  bar.replaceChildren();
  if (state.config?.isFallbackDataFolder) {
    bar.append(
      el('div', { class: 'notice warn' },
        '未設定同步資料夾（volley.dataFolder）——資料僅存於本機延伸模組空間，不會跨裝置同步。',
      ),
    );
  }
  for (const file of state.conflictedCopies) {
    bar.append(el('div', { class: 'notice warn' }, `偵測到 Dropbox 衝突副本：${file}（請手動整併）`));
  }
  if (state.notice) {
    const current = state.notice;
    bar.append(
      el('div', { class: `notice ${current.level}`, onclick: () => { state.notice = null; render(); }, title: '點擊關閉' }, current.message),
    );
  }
}

function fullRender(): void {
  renderNotices();
  renderTabbar();
  renderSidebar(document.getElementById('pane-sidebar')!);
  renderRequestPane(document.getElementById('pane-request')!);
  renderResponsePane(document.getElementById('pane-response')!);
  document.getElementById('env-editor')?.remove();
  const envOverlay = renderEnvEditor();
  if (envOverlay) {
    document.getElementById('main')!.append(envOverlay);
  }
  applyLayoutClass();
  applyColumnWidths();
  vscode.setState({
    collectionId: state.collection?.id ?? null,
    narrowTab: state.narrowTab,
    requestTab: state.requestTab,
    responseTab: state.responseTab,
  });
}

function notice(level: string, message: string): void {
  state.notice = { level, message };
  render();
  setTimeout(() => {
    if (state.notice?.message === message) {
      state.notice = null;
      render();
    }
  }, 6000);
}

function handleHostMessage(message: HostMessage): void {
  switch (message.type) {
    case 'init': {
      state.collections = message.collections;
      state.collection = message.activeCollection;
      state.ui = message.uiState ?? emptyUiState();
      state.config = message.config;
      state.conflictedCopies = message.conflictedCopies;
      state.historyByRequest.clear();
      if (state.ui.selectedRequestId && state.collection) {
        post({ type: 'loadHistory', collectionId: state.collection.id, requestId: state.ui.selectedRequestId });
      }
      render();
      break;
    }
    case 'collectionLoaded':
      state.collection = message.collection;
      state.ui = message.uiState;
      state.historyByRequest.clear();
      state.envEditor = null;
      if (state.ui.selectedRequestId) {
        post({ type: 'loadHistory', collectionId: message.collection.id, requestId: state.ui.selectedRequestId });
      }
      render();
      break;
    case 'collectionChangedOnDisk':
      // 有未送出的本地編輯時以本地為準（last-writer-wins，稍後覆寫磁碟）
      if (!hasPendingEdits() && state.collection?.id === message.collection.id) {
        state.collection = message.collection;
        notice('info', '已從磁碟載入外部變更');
        render();
      }
      break;
    case 'collectionListChanged':
      state.collections = message.collections;
      render();
      break;
    case 'responseStarted':
      state.sending.add(message.requestId);
      render();
      break;
    case 'responseFinished': {
      state.sending.delete(message.requestId);
      state.historyByRequest.set(message.requestId, message.history);
      state.fullBodyByResponseId.set(message.record.id, message.fullBody);
      if (state.collection) {
        // 同步 host 端更新的 cookie jar，避免下次全量回存把新 cookie 蓋掉
        state.collection.cookieJar = message.cookieJar;
      }
      if (state.ui.activeResponseIds?.[message.requestId]) {
        delete state.ui.activeResponseIds[message.requestId];
        touchUi();
      }
      if (state.isNarrow && state.ui.selectedRequestId === message.requestId) {
        state.narrowTab = 'response';
      }
      render();
      break;
    }
    case 'historyLoaded':
      state.historyByRequest.set(message.requestId, message.records);
      render();
      break;
    case 'requestInserted': {
      insertNode(message.request, message.folderId);
      state.ui.selectedRequestId = message.request.id;
      touchUi();
      touch();
      notice('info', '已從 curl 匯入 request');
      render();
      break;
    }
    case 'curlExported':
      // 已由 extension 端複製到剪貼簿；此處僅提示
      break;
    case 'notice':
      notice(message.level, message.message);
      break;
  }
}

function boot(): void {
  buildSkeleton();
  setRenderFn(fullRender);
  initLayout();
  initSplitters();

  const saved = vscode.getState() as { narrowTab?: typeof state.narrowTab; requestTab?: string; responseTab?: string } | undefined;
  if (saved?.narrowTab) {
    state.narrowTab = saved.narrowTab;
  }
  if (saved?.requestTab) {
    state.requestTab = saved.requestTab;
  }
  if (saved?.responseTab) {
    state.responseTab = saved.responseTab;
  }

  window.addEventListener('message', (ev: MessageEvent) => {
    if (isHostMessage(ev.data)) {
      handleHostMessage(ev.data as HostMessage);
    }
  });

  // Send 快捷鍵：Cmd/Ctrl+Enter
  window.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      const request = selectedRequest();
      if (request && state.collection && !state.sending.has(request.id)) {
        post({ type: 'sendRequest', collectionId: state.collection.id, requestId: request.id });
      }
    }
  });

  render();
  post({ type: 'ready' });
}

boot();
