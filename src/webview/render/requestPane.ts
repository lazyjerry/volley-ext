// Request pane：URL bar（method/URL/Send）+ Params|Body|Auth|Headers|Docs 分頁。
// 所有欄位支援 {{ _.x }} 片段變數；focus 時顯示解析預覽，未定義變數警告。

import type { BodyParam, Header, QueryParam, RequestItem } from '../../core/model/types';
import { walkRequests } from '../../core/model/types';
import { containsTemplate, interpolate } from '../../core/vars/template';
import { resolveEnvironment } from '../../core/vars/environment';
import { el, post, render, selectedRequest, state, touch } from '../store';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

const MIME_OPTIONS: Array<[string, string]> = [
  ['', 'No Body'],
  ['application/json', 'JSON'],
  ['text/plain', 'Plain Text'],
  ['application/xml', 'XML'],
  ['application/yaml', 'YAML'],
  ['application/graphql', 'GraphQL'],
  ['application/x-www-form-urlencoded', 'Form URL Encoded'],
  ['multipart/form-data', 'Multipart Form'],
  ['application/octet-stream', 'Binary File'],
];

export function currentEnv(): Record<string, unknown> {
  const collection = state.collection;
  if (!collection) {
    return {};
  }
  const id = state.ui.selectedRequestId;
  const chain = id
    ? (walkRequests(collection.children).find((e) => e.request.id === id)?.folderChain ?? [])
    : [];
  return resolveEnvironment(collection, state.ui.activeEnvironmentId, chain);
}

/** 帶變數標示與解析預覽的 input。 */
function varInput(
  value: string,
  onInput: (value: string) => void,
  props: Record<string, unknown> = {},
): HTMLInputElement {
  const input = el('input', { type: 'text', value, spellcheck: false, ...props });
  const applyClass = (): void => {
    const has = containsTemplate(input.value);
    input.classList.toggle('has-var', has);
    if (has) {
      const { missing } = interpolate(input.value, currentEnv());
      input.classList.toggle('has-missing-var', missing.length > 0);
    } else {
      input.classList.remove('has-missing-var');
    }
  };
  applyClass();
  let preview: HTMLElement | null = null;
  const showPreview = (): void => {
    hidePreview();
    if (!containsTemplate(input.value)) {
      return;
    }
    const { result, missing } = interpolate(input.value, currentEnv());
    preview = el('div', { class: 'var-preview' }, '→ ', result);
    if (missing.length > 0) {
      preview.append(el('span', { class: 'missing' }, ` （未定義：${missing.join(', ')}）`));
    }
    input.insertAdjacentElement('afterend', preview);
  };
  const hidePreview = (): void => {
    preview?.remove();
    preview = null;
  };
  input.addEventListener('input', () => {
    onInput(input.value);
    applyClass();
    if (preview) {
      showPreview();
    }
  });
  input.addEventListener('focus', showPreview);
  input.addEventListener('blur', hidePreview);
  return input;
}

// ---- KV 表格（params / headers / form body 共用） ----

interface KvRow {
  name: string;
  value: string;
  disabled?: boolean;
}

function kvTable<T extends KvRow>(
  rows: T[],
  makeRow: () => T,
  onChange: () => void,
  options: { valuePlaceholder?: string } = {},
): HTMLElement {
  const box = el('div', { class: 'kv-table' });
  const renderRows = (): void => {
    box.replaceChildren();
    rows.forEach((row, idx) => {
      const rowEl = el(
        'div',
        { class: `kv-row${row.disabled ? ' disabled' : ''}` },
        el('input', {
          type: 'checkbox',
          checked: !row.disabled,
          title: '啟用/停用',
          onchange: (ev: Event) => {
            row.disabled = !(ev.target as HTMLInputElement).checked;
            onChange();
            renderRows();
          },
        }),
        varInput(row.name, (v) => {
          row.name = v;
          onChange();
        }, { class: 'k', placeholder: 'name' }),
        varInput(row.value, (v) => {
          row.value = v;
          onChange();
        }, { class: 'v', placeholder: options.valuePlaceholder ?? 'value' }),
        el('button', {
          class: 'icon',
          title: '刪除',
          onclick: () => {
            rows.splice(idx, 1);
            onChange();
            renderRows();
          },
        }, '✕'),
      );
      box.append(rowEl);
    });
    box.append(
      el('div', {}, el('button', {
        class: 'secondary',
        onclick: () => {
          rows.push(makeRow());
          onChange();
          renderRows();
        },
      }, '＋ 新增')),
    );
  };
  renderRows();
  return box;
}

// ---- 各分頁 ----

function paramsTab(request: RequestItem): HTMLElement {
  const box = el('div', {});
  box.append(el('div', { class: 'hint' }, 'Query 參數'));
  box.append(kvTable<QueryParam>(request.parameters, () => ({ name: '', value: '' }), touch));
  box.append(el('div', { class: 'hint', style: 'margin-top:12px' }, 'Path 參數（URL 中的 {{ _.x }} 片段）'));
  box.append(
    kvTable(
      request.pathParameters as Array<{ name: string; value: string }>,
      () => ({ name: '', value: '' }),
      touch,
    ),
  );
  return box;
}

function bodyTab(request: RequestItem): HTMLElement {
  const box = el('div', { class: 'body-editor' });
  const select = el('select', {
    onchange: (ev: Event) => {
      const value = (ev.target as HTMLSelectElement).value;
      request.body.mimeType = value === '' ? null : value;
      if (value === 'application/x-www-form-urlencoded' || value === 'multipart/form-data') {
        request.body.params = request.body.params ?? [];
      }
      touch();
      render();
    },
  });
  for (const [value, label] of MIME_OPTIONS) {
    select.append(
      el('option', { value, ...((request.body.mimeType ?? '') === value ? { selected: 'selected' } : {}) }, label),
    );
  }
  box.append(el('div', {}, select));

  const mime = request.body.mimeType ?? '';
  if (mime === 'application/x-www-form-urlencoded' || mime === 'multipart/form-data') {
    request.body.params = request.body.params ?? [];
    box.append(kvTable<BodyParam>(request.body.params, () => ({ name: '', value: '' }), touch));
    if (mime === 'multipart/form-data') {
      box.append(el('div', { class: 'hint' }, '檔案欄位：value 留空並於匯出的 YAML 設 type: file 與 fileName（v1 UI 僅支援文字欄位）'));
    }
  } else if (mime === 'application/octet-stream') {
    box.append(
      el('div', { class: 'form-grid' },
        el('span', {}, '檔案路徑'),
        varInput(request.body.fileName ?? '', (v) => {
          request.body.fileName = v;
          touch();
        }, { placeholder: '/path/to/file' }),
      ),
    );
  } else if (mime !== '') {
    const textarea = el('textarea', { spellcheck: false, placeholder: mime === 'application/graphql' ? '{"query": "...", "variables": {}}' : '' });
    textarea.value = request.body.text ?? '';
    textarea.addEventListener('input', () => {
      request.body.text = textarea.value;
      touch();
    });
    box.append(textarea);
  } else {
    box.append(el('div', { class: 'hint' }, '此 request 不帶 body。'));
  }
  return box;
}

const AUTH_TYPES: Array<[string, string]> = [
  ['none', 'None'],
  ['basic', 'Basic Auth'],
  ['bearer', 'Bearer Token'],
  ['apikey', 'API Key'],
  ['other', '其他（原始編輯）'],
];

function authField(
  request: RequestItem,
  key: string,
  label: string,
  placeholder = '',
): HTMLElement[] {
  return [
    el('span', {}, label),
    varInput(String(request.authentication[key] ?? ''), (v) => {
      request.authentication[key] = v;
      touch();
    }, { placeholder }),
  ];
}

function authTab(request: RequestItem): HTMLElement {
  const box = el('div', {});
  const type = request.authentication.type ?? 'none';
  const known = ['none', 'basic', 'bearer', 'apikey'];
  const selectValue = known.includes(String(type)) ? String(type) : 'other';
  const select = el('select', {
    onchange: (ev: Event) => {
      const value = (ev.target as HTMLSelectElement).value;
      if (value === 'other') {
        request.authentication = { type: 'oauth2' };
      } else if (value === 'none') {
        request.authentication = {};
      } else {
        request.authentication = { type: value, disabled: false };
      }
      touch();
      render();
    },
  });
  for (const [value, label] of AUTH_TYPES) {
    select.append(el('option', { value, ...(selectValue === value ? { selected: 'selected' } : {}) }, label));
  }
  box.append(el('div', { style: 'margin-bottom:10px' }, select));

  const grid = el('div', { class: 'form-grid' });
  if (type === 'basic') {
    grid.append(...authField(request, 'username', 'Username'), ...authField(request, 'password', 'Password'));
  } else if (type === 'bearer') {
    grid.append(...authField(request, 'token', 'Token'), ...authField(request, 'prefix', 'Prefix', 'Bearer'));
  } else if (type === 'apikey') {
    grid.append(...authField(request, 'key', 'Key'), ...authField(request, 'value', 'Value'));
    const addToSelect = el('select', {
      onchange: (ev: Event) => {
        request.authentication.addTo = (ev.target as HTMLSelectElement).value;
        touch();
      },
    });
    for (const [value, label] of [['header', 'Header'], ['queryParams', 'Query']] as const) {
      addToSelect.append(
        el('option', { value, ...((request.authentication.addTo ?? 'header') === value ? { selected: 'selected' } : {}) }, label),
      );
    }
    grid.append(el('span', {}, '加在'), addToSelect);
  } else if (selectValue === 'other') {
    const textarea = el('textarea', { spellcheck: false, style: 'width:100%;min-height:160px' });
    textarea.value = JSON.stringify(request.authentication, null, 2);
    textarea.addEventListener('change', () => {
      try {
        request.authentication = JSON.parse(textarea.value) as RequestItem['authentication'];
        touch();
      } catch {
        // JSON 未完成時不套用
      }
    });
    box.append(
      el('div', { class: 'hint' }, '此類型（oauth2/digest/…）欄位以 JSON 保存、匯入匯出不遺失，但 v1 送出請求時不執行此認證。'),
      textarea,
    );
    return box;
  }
  box.append(grid);
  return box;
}

function headersTab(request: RequestItem): HTMLElement {
  return kvTable<Header>(request.headers, () => ({ name: '', value: '' }), touch);
}

function docsTab(request: RequestItem): HTMLElement {
  const textarea = el('textarea', { placeholder: '此 request 的描述（匯出為 OpenAPI description）', style: 'width:100%;height:100%;min-height:180px' });
  textarea.value = request.description ?? '';
  textarea.addEventListener('input', () => {
    if (textarea.value === '') {
      delete request.description;
    } else {
      request.description = textarea.value;
    }
    touch();
  });
  return textarea;
}

// ---- 主渲染 ----

export function renderRequestPane(root: HTMLElement): void {
  root.replaceChildren();
  const request = selectedRequest();
  if (!request || !state.collection) {
    root.append(
      el('div', { class: 'empty-state' },
        el('div', {}, '選擇左側的 request，或建立新的 request。'),
      ),
    );
    return;
  }

  const methodSelect = el('select', {
    class: `method method-${request.method}`,
    onchange: (ev: Event) => {
      request.method = (ev.target as HTMLSelectElement).value;
      touch();
      render();
    },
  });
  for (const m of METHODS) {
    methodSelect.append(el('option', { value: m, ...(request.method === m ? { selected: 'selected' } : {}) }, m));
  }
  if (!METHODS.includes(request.method)) {
    methodSelect.append(el('option', { value: request.method, selected: 'selected' }, request.method));
  }

  const urlInput = varInput(request.url, (v) => {
    request.url = v;
    touch();
  }, { class: 'url', placeholder: '{{ _.base_url }}/path 或 https://…' });

  const sending = state.sending.has(request.id);
  const sendBtn = el('button', {
    class: 'send-btn',
    onclick: () => {
      if (sending) {
        post({ type: 'cancelRequest', requestId: request.id });
      } else {
        post({ type: 'sendRequest', collectionId: state.collection!.id, requestId: request.id });
      }
    },
  }, sending ? '取消' : 'Send');

  const toolbar = el('div', { class: 'pane-toolbar' }, methodSelect, urlInput, sendBtn);
  root.append(toolbar);

  const tabs: Array<[string, string, number]> = [
    ['params', 'Params', request.parameters.length + request.pathParameters.length],
    ['body', 'Body', request.body.mimeType ? 1 : 0],
    ['auth', 'Auth', request.authentication.type && request.authentication.type !== 'none' ? 1 : 0],
    ['headers', 'Headers', request.headers.length],
    ['docs', 'Docs', request.description ? 1 : 0],
  ];
  const subtabs = el('div', { class: 'subtabs' });
  for (const [id, label, badge] of tabs) {
    subtabs.append(
      el('button', {
        class: `tab${state.requestTab === id ? ' active' : ''}`,
        onclick: () => {
          state.requestTab = id;
          render();
        },
      }, label, badge > 0 ? el('span', { class: 'subtab-badge' }, String(badge)) : null),
    );
  }
  root.append(subtabs);

  const body = el('div', { class: 'pane-body' });
  switch (state.requestTab) {
    case 'body':
      body.append(bodyTab(request));
      break;
    case 'auth':
      body.append(authTab(request));
      break;
    case 'headers':
      body.append(headersTab(request));
      break;
    case 'docs':
      body.append(docsTab(request));
      break;
    default:
      body.append(paramsTab(request));
  }
  root.append(body);
}
