// Response pane：狀態列（status/time/size）+ Preview|Headers|Cookies|Console 分頁
// + response history 下拉與清除。

import type { ResponseRecord } from '../../core/model/types';
import {
  activeHistory,
  activeResponse,
  el,
  post,
  render,
  selectedRequest,
  state,
  touchUi,
} from '../store';
import { createFindBar } from './findBar';

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function bodyText(record: ResponseRecord): { text: string; isBinary: boolean } {
  const full = state.fullBodyByResponseId.get(record.id);
  const text = full ?? record.body;
  return { text, isBinary: record.bodyEncoding === 'base64' };
}

function previewTab(record: ResponseRecord): HTMLElement {
  const box = el('div', {});
  const { text, isBinary } = bodyText(record);
  if (record.error) {
    box.append(el('div', { class: 'console-line error' }, record.error));
    return box;
  }
  if (isBinary) {
    box.append(el('div', { class: 'hint' }, `二進位內容（${formatSize(record.bodySize)}，base64 保存）`));
    return box;
  }
  const modeBtn = el('button', {
    class: 'secondary',
    style: 'margin-bottom:6px',
    onclick: () => {
      state.responseViewMode = state.responseViewMode === 'pretty' ? 'raw' : 'pretty';
      render();
    },
  }, state.responseViewMode === 'pretty' ? '檢視原始' : '格式化檢視');

  let display = text;
  if (
    state.responseViewMode === 'pretty' &&
    (record.contentType ?? '').includes('json')
  ) {
    try {
      display = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // 非合法 JSON（可能被截斷）→ 原樣
    }
  }
  if (record.bodyTruncated && !state.fullBodyByResponseId.has(record.id)) {
    box.append(el('div', { class: 'console-line warn' }, `body 已截斷保存（原始大小 ${formatSize(record.bodySize)}）`));
  }
  box.append(modeBtn, el('pre', { class: 'resp-body' }, display));
  return box;
}

function headersTab(record: ResponseRecord): HTMLElement {
  const table = el('table', { class: 'plain' });
  table.append(el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Value')));
  for (const h of record.responseHeaders) {
    table.append(el('tr', {}, el('td', {}, h.name), el('td', {}, h.value)));
  }
  const reqTable = el('table', { class: 'plain', style: 'margin-top:14px' });
  reqTable.append(el('tr', {}, el('th', {}, '（送出的 Request Headers）'), el('th', {}, '')));
  for (const h of record.requestHeaders) {
    reqTable.append(el('tr', {}, el('td', {}, h.name), el('td', {}, h.value)));
  }
  return el('div', {}, table, reqTable);
}

function cookiesTab(record: ResponseRecord): HTMLElement {
  const setCookies = record.responseHeaders.filter((h) => h.name.toLowerCase() === 'set-cookie');
  if (setCookies.length === 0) {
    return el('div', { class: 'hint' }, '此回應沒有 Set-Cookie。');
  }
  const table = el('table', { class: 'plain' });
  table.append(el('tr', {}, el('th', {}, 'Set-Cookie')));
  for (const h of setCookies) {
    table.append(el('tr', {}, el('td', {}, h.value)));
  }
  return table;
}

function consoleTab(record: ResponseRecord): HTMLElement {
  const box = el('div', {});
  box.append(el('div', { class: 'console-line' }, `${record.method} ${record.url}`));
  for (const hop of record.redirectChain ?? []) {
    box.append(el('div', { class: 'console-line' }, `↪ ${hop}`));
  }
  box.append(
    el('div', { class: 'console-line' }, `完成於 ${record.durationMs}ms，${formatSize(record.bodySize)}`),
  );
  for (const w of record.warnings ?? []) {
    box.append(el('div', { class: 'console-line warn' }, `⚠ ${w}`));
  }
  if (record.error) {
    box.append(el('div', { class: 'console-line error' }, `✕ ${record.error}`));
  }
  return box;
}

export function renderResponsePane(root: HTMLElement): void {
  root.replaceChildren();
  if (state.variablePreview) {
    const preview = el('div', { class: 'var-preview response-var-preview' }, '→ ', state.variablePreview.result);
    if (state.variablePreview.missing.length > 0) {
      preview.append(
        el('span', { class: 'missing' }, ` （未定義：${state.variablePreview.missing.join(', ')}）`),
      );
    }
    root.append(preview);
  }
  const request = selectedRequest();
  if (!request || !state.collection) {
    root.append(el('div', { class: 'empty-state' }, el('div', {}, '送出 request 後在此顯示回應。')));
    return;
  }
  if (state.sending.has(request.id)) {
    root.append(
      el('div', { class: 'empty-state' },
        el('div', {}, el('span', { class: 'spin' }, '◌'), ' 傳送中…'),
        el('button', { class: 'secondary', onclick: () => post({ type: 'cancelRequest', requestId: request.id }) }, '取消'),
      ),
    );
    return;
  }
  const history = activeHistory();
  const record = activeResponse();
  if (!record) {
    root.append(el('div', { class: 'empty-state' }, el('div', {}, '尚無回應紀錄。按 Send 送出請求。')));
    return;
  }

  const statusClass =
    record.status === 0
      ? 'status-0'
      : `status-${Math.floor(record.status / 100)}xx`;

  const historySelect = el('select', {
    title: '回應歷史',
    onchange: (ev: Event) => {
      const id = (ev.target as HTMLSelectElement).value;
      state.ui.activeResponseIds = state.ui.activeResponseIds ?? {};
      state.ui.activeResponseIds[request.id] = id;
      touchUi();
      render();
    },
  });
  for (const r of history) {
    historySelect.append(
      el(
        'option',
        { value: r.id, ...(r.id === record.id ? { selected: 'selected' } : {}) },
        `${formatTime(r.at)} · ${r.status === 0 ? 'ERR' : r.status} · ${r.durationMs}ms`,
      ),
    );
  }

  const statusBar = el(
    'div',
    { class: 'resp-status' },
    el('span', { class: `status-pill ${statusClass}` }, record.status === 0 ? 'ERROR' : `${record.status} ${record.statusText}`.trim()),
    el('span', { class: 'resp-meta' }, `${record.durationMs} ms`),
    el('span', { class: 'resp-meta' }, formatSize(record.bodySize)),
    el(
      'span',
      { class: 'resp-history' },
      historySelect,
      el('button', {
        class: 'icon',
        title: '清除歷史',
        onclick: () => {
          post({ type: 'clearHistory', collectionId: state.collection!.id, requestId: request.id });
        },
      }, '🗑'),
    ),
  );
  root.append(statusBar);

  const tabs: Array<[string, string]> = [
    ['preview', 'Preview'],
    ['headers', 'Headers'],
    ['cookies', 'Cookies'],
    ['console', 'Console'],
  ];
  const subtabs = el('div', { class: 'subtabs' });
  for (const [id, label] of tabs) {
    subtabs.append(
      el('button', {
        class: `tab${state.responseTab === id ? ' active' : ''}`,
        onclick: () => {
          state.responseTab = id;
          render();
        },
      }, label),
    );
  }
  root.append(subtabs);

  const body = el('div', { class: 'pane-body' });
  // 搜尋列吃的是目前分頁已渲染出來的內容，切分頁後由 refresh() 重新標示
  const findBar = createFindBar({
    findState: state.find.response,
    target: () => body,
    placeholder: '搜尋回應內容…',
    onClose: () => render(),
  });
  if (findBar) {
    root.append(findBar.element);
  }
  switch (state.responseTab) {
    case 'headers':
      body.append(headersTab(record));
      break;
    case 'cookies':
      body.append(cookiesTab(record));
      break;
    case 'console':
      body.append(consoleTab(record));
      break;
    default:
      body.append(previewTab(record));
  }
  root.append(body);
  findBar?.refresh();
}
