// Request pane：URL bar（method/URL/Send）+ Params|Body|Auth|Headers|Docs 分頁。
// 所有欄位支援 {{ _.x }} 片段變數；focus 時顯示解析預覽，未定義變數警告。

import type { BodyParam, Header, QueryParam, RequestItem } from '../../core/model/types';
import { walkRequests } from '../../core/model/types';
import { containsTemplate, interpolate, parseVarPath } from '../../core/vars/template';
import { resolveEnvironment } from '../../core/vars/environment';
import { prettyJson, prettyXml, prettyYaml } from '../../core/formats/prettyPrint';
import { el, notice, post, render, selectedRequest, state, touch } from '../store';
import { renderResponsePane } from './responsePane';
import { createFindBar } from './findBar';

// varField 的 overlay 每次 paint() 都整個重建，會把搜尋標示一起清掉；重畫後補標一次。
// 補標不能捲動畫面——paint() 也發生在 hover，捲動會把使用者正在看的位置甩掉。
let refreshRequestFind: ((reveal?: boolean) => void) | null = null;
let remarking = false;

function remarkAfterPaint(): void {
  if (!refreshRequestFind || remarking || state.find.request.query === '') {
    return;
  }
  remarking = true;
  try {
    refreshRequestFind(false);
  } finally {
    remarking = false;
  }
}

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
): HTMLElement {
  return varField('input', value, onInput, props);
}

function varTextarea(
  value: string,
  onInput: (value: string) => void,
  props: Record<string, unknown> = {},
): HTMLElement {
  return varField('textarea', value, onInput, props);
}

const VAR_TOKEN_RE = /\{\{\s*[^{}]+?\s*\}\}/g;

function environmentPaths(data: Record<string, unknown>): Array<{ path: string; value: string }> {
  const result: Array<{ path: string; value: string }> = [];
  const visit = (value: unknown, parts: string[]): void => {
    if (parts.length > 0) {
      result.push({
        path: parts.join('.'),
        value: value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''),
      });
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, [...parts, key]);
      }
    }
  };
  visit(data, []);
  return result;
}

function varField(
  kind: 'input' | 'textarea',
  value: string,
  onInput: (value: string) => void,
  props: Record<string, unknown>,
): HTMLElement {
  const fieldClass = String(props.class ?? '');
  const fieldProps = { ...props };
  delete fieldProps.class;
  const input = kind === 'input'
    ? el('input', { type: 'text', value, spellcheck: false, ...fieldProps }) as HTMLInputElement
    : el('textarea', { spellcheck: false, ...fieldProps }) as HTMLTextAreaElement;
  input.value = value;
  const overlay = el('div', { class: 'template-overlay', 'aria-hidden': 'true' });
  const suggestions = el('div', { class: 'var-suggestions', role: 'listbox' });
  const wrapper = el('div', { class: `template-field ${kind === 'textarea' ? 'multiline' : ''} ${fieldClass}` }, overlay, input, suggestions);
  let suggestionIndex = 0;
  let triggerStart = -1;
  // overlay 與 input 逐字元等寬才對得齊 caret，所以只在「沒有 caret 也沒有滑鼠」時才收合成 chip。
  // textarea 排除：收合會改變換行數，scrollTop 同步後會指向錯誤的內容。
  const collapsible = kind === 'input';
  let focused = false;
  let hovered = false;

  const syncScroll = (): void => {
    overlay.scrollLeft = input.scrollLeft;
    overlay.scrollTop = input.scrollTop;
  };
  /** chip 收合時的顯示文字：`{{ _.a.b }}` → `a.b`；無法解析則去掉大括號後原樣顯示。 */
  const tokenLabel = (token: string): string => {
    const expr = token.slice(2, -2);
    return parseVarPath(expr)?.join('.') ?? expr.trim();
  };
  const paint = (): void => {
    overlay.replaceChildren();
    if (input.value === '') {
      overlay.append(el('span', { class: 'template-placeholder' }, String(fieldProps.placeholder ?? '')));
      return;
    }
    const collapsed = collapsible && !focused && !hovered;
    let offset = 0;
    for (const match of input.value.matchAll(VAR_TOKEN_RE)) {
      const start = match.index ?? 0;
      if (start > offset) {
        overlay.append(document.createTextNode(input.value.slice(offset, start)));
      }
      const missing = interpolate(match[0], currentEnv()).missing.length > 0;
      overlay.append(el(
        'span',
        { class: `template-token${missing ? ' missing' : ''}${collapsed ? ' collapsed' : ''}` },
        collapsed ? tokenLabel(match[0]) : match[0],
      ));
      offset = start + match[0].length;
    }
    overlay.append(document.createTextNode(input.value.slice(offset)));
    remarkAfterPaint();
    if (collapsed) {
      // 收合後 overlay 比 input 窄，照抄 scrollLeft 會捲過內容尾端
      overlay.scrollLeft = Math.min(input.scrollLeft, Math.max(0, overlay.scrollWidth - overlay.clientWidth));
      overlay.scrollTop = 0;
    } else {
      syncScroll();
    }
  };
  const closeSuggestions = (): void => {
    suggestions.classList.remove('open');
    suggestions.replaceChildren();
    triggerStart = -1;
  };
  const chooseSuggestion = (path: string): void => {
    const end = input.selectionStart ?? input.value.length;
    input.setRangeText(`{{ _.${path} }}`, triggerStart, end, 'end');
    closeSuggestions();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  const updateSuggestions = (): void => {
    const caret = input.selectionStart;
    if (caret === null || input.selectionEnd !== caret) {
      closeSuggestions();
      return;
    }
    const before = input.value.slice(0, caret);
    const match = /(?:^|[\s=:/;,(])\._([\w$.-]*)$/.exec(before);
    if (!match) {
      closeSuggestions();
      return;
    }
    triggerStart = caret - match[1].length - 2;
    const query = match[1].toLowerCase();
    const matches = environmentPaths(currentEnv())
      .filter((item) => item.path.toLowerCase().includes(query))
      .slice(0, 12);
    suggestions.replaceChildren();
    suggestionIndex = Math.min(suggestionIndex, Math.max(0, matches.length - 1));
    matches.forEach((item, index) => {
      suggestions.append(el('button', {
        type: 'button',
        class: `var-suggestion${index === suggestionIndex ? ' selected' : ''}`,
        role: 'option',
        onmousedown: (ev: MouseEvent) => ev.preventDefault(),
        onclick: () => chooseSuggestion(item.path),
      }, el('span', { class: 'path' }, `_.${item.path}`), el('span', { class: 'value' }, item.value)));
    });
    suggestions.classList.toggle('open', matches.length > 0);
  };
  const applyClass = (): void => {
    const has = containsTemplate(input.value);
    wrapper.classList.toggle('has-var', has);
    if (has) {
      const { missing } = interpolate(input.value, currentEnv());
      wrapper.classList.toggle('has-missing-var', missing.length > 0);
    } else {
      wrapper.classList.remove('has-missing-var');
    }
    paint();
  };
  applyClass();
  let showingPreview = false;
  const refreshResponsePane = (): void => {
    const responsePane = document.getElementById('pane-response');
    if (responsePane) {
      renderResponsePane(responsePane);
    }
  };
  const showPreview = (): void => {
    hidePreview();
    if (!containsTemplate(input.value)) {
      return;
    }
    const { result, missing } = interpolate(input.value, currentEnv());
    state.variablePreview = { result, missing };
    showingPreview = true;
    refreshResponsePane();
  };
  const hidePreview = (): void => {
    if (!showingPreview) {
      return;
    }
    state.variablePreview = null;
    showingPreview = false;
    refreshResponsePane();
  };
  input.addEventListener('input', () => {
    onInput(input.value);
    applyClass();
    updateSuggestions();
    if (showingPreview) {
      showPreview();
    }
  });
  input.addEventListener('focus', () => {
    focused = true;
    paint();
    showPreview();
  });
  input.addEventListener('blur', () => {
    focused = false;
    paint();
    hidePreview();
    closeSuggestions();
  });
  // hover 就展開：mouseenter 必定早於 mousedown，點擊時 overlay 已是原文，
  // 游標落點才會與看到的字元一致。
  wrapper.addEventListener('mouseenter', () => {
    hovered = true;
    paint();
  });
  wrapper.addEventListener('mouseleave', () => {
    hovered = false;
    paint();
  });
  input.addEventListener('scroll', syncScroll);
  input.addEventListener('keydown', (event) => {
    const ev = event as KeyboardEvent;
    if (suggestions.classList.contains('open')) {
      const count = suggestions.childElementCount;
      if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && count > 0) {
        ev.preventDefault();
        suggestionIndex = (suggestionIndex + (ev.key === 'ArrowDown' ? 1 : count - 1)) % count;
        updateSuggestions();
        return;
      }
      if ((ev.key === 'Enter' || ev.key === 'Tab') && count > 0) {
        ev.preventDefault();
        const path = suggestions.children[suggestionIndex]?.querySelector('.path')?.textContent?.slice(2);
        if (path) chooseSuggestion(path);
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeSuggestions();
        return;
      }
    }
    if (ev.key === 'Backspace' && input.selectionStart === input.selectionEnd && input.selectionStart !== null) {
      const caret = input.selectionStart;
      for (const match of input.value.matchAll(VAR_TOKEN_RE)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (caret > start && caret <= end) {
          ev.preventDefault();
          input.setRangeText('', start, end, 'end');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          break;
        }
      }
    }
  });
  return wrapper;
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

const TEXT_FORMATTERS: Record<string, (text: string) => string> = {
  'application/json': prettyJson,
  'application/graphql': prettyJson,
  'application/xml': prettyXml,
  'application/yaml': prettyYaml,
};

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
  const mime = request.body.mimeType ?? '';
  // 美化按鈕要能拿到稍後才建立的 textarea，靠這個變數在 click 當下取值
  let field: HTMLElement | null = null;
  const toolbar = el('div', { class: 'body-toolbar' }, select);
  const isForm = mime === 'application/x-www-form-urlencoded' || mime === 'multipart/form-data';
  const formatter = TEXT_FORMATTERS[mime];
  if (isForm || formatter) {
    toolbar.append(
      el('button', {
        class: 'secondary',
        title: isForm ? '依欄位名稱排序' : '重新排版（內容需合法）',
        onclick: () => {
          if (isForm) {
            request.body.params?.sort((a, b) => a.name.localeCompare(b.name));
            touch();
            render();
            return;
          }
          const textarea = field?.querySelector('textarea');
          if (!textarea) {
            return;
          }
          try {
            textarea.value = formatter(textarea.value);
            // 交給 varField 既有的 input handler 更新 model、變數標示與預覽
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          } catch (err) {
            notice('error', `無法美化：${err instanceof Error ? err.message : String(err)}`);
          }
        },
      }, '美化'),
    );
  }
  box.append(toolbar);

  if (isForm) {
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
    field = varTextarea(request.body.text ?? '', (value) => {
      request.body.text = value;
      touch();
    }, { placeholder: mime === 'application/graphql' ? '{"query": "...", "variables": {}}' : '' });
    box.append(field);
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
  const textarea = el('textarea', { class: 'docs-editor', placeholder: '此 request 的描述（匯出為 OpenAPI description）' });
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
  // 舊的 handle 指向已被換掉的 body，重繪期間 paint() 不該再拿它補標
  refreshRequestFind = null;
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
  const findBar = createFindBar({
    findState: state.find.request,
    target: () => body,
    placeholder: '搜尋此分頁的欄位…',
    onClose: () => render(),
  });
  if (findBar) {
    root.append(findBar.element);
  }
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
  refreshRequestFind = findBar ? findBar.refresh : null;
  findBar?.refresh();
}
