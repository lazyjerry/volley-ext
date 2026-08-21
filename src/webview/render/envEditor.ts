// 環境變數獨立管理畫面（覆蓋主區域）。
// 左列：Base + sub-environments（新增/刪除/改名/設色）；右側：變數表格或原始 JSON。
// 資料夾層級變數由資料夾右鍵進入，編輯該資料夾的 environment 物件。

import { isFolder } from '../../core/model/types';
import { el, findNode, flushPendingEdits, post, render, state, touch, touchUi } from '../store';

export function openEnvEditor(target: 'collection' | { folderId: string }): void {
  state.envEditor = { target, selectedEnvId: 'base', rawMode: 'off', dirty: false };
  render();
}

export function closeEnvEditor(): void {
  if (state.envEditor?.dirty) {
    flushPendingEdits();
  }
  state.envEditor = null;
  render();
}

/**
 * 編輯器內任何變動時呼叫：關閉鈕由 x 換成儲存圖示。
 * 輸入中不做全量 render（避免失焦），直接就地改圖示。
 */
function markDirty(): void {
  const editor = state.envEditor;
  if (!editor || editor.dirty) {
    return;
  }
  editor.dirty = true;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#env-editor .env-close')) {
    btn.title = '儲存並關閉';
    btn.querySelector('.codicon')?.classList.replace('codicon-close', 'codicon-save');
  }
}

/** 關閉鈕：有變動 = 儲存圖示、無變動 = x 圖示。 */
function closeButton(): HTMLElement {
  const dirty = state.envEditor?.dirty ?? false;
  return el('button', {
    class: 'icon env-close',
    title: dirty ? '儲存並關閉' : '關閉（無變更）',
    onclick: closeEnvEditor,
  }, el('span', { class: `codicon codicon-${dirty ? 'save' : 'close'}` }));
}

interface EnvTarget {
  data: Record<string, unknown>;
  setData: (d: Record<string, unknown>) => void;
  descriptions: Record<string, string>;
  setDescriptions: (d: Record<string, string>) => void;
}

function targetData(): EnvTarget | null {
  const editor = state.envEditor;
  const collection = state.collection;
  if (!editor || !collection) {
    return null;
  }
  if (editor.target !== 'collection') {
    const folder = findNode(collection.children, editor.target.folderId);
    if (!folder || !isFolder(folder)) {
      return null;
    }
    folder.environment = folder.environment ?? {};
    return {
      data: folder.environment,
      setData: (d) => {
        folder.environment = d;
      },
      descriptions: folder.environmentDescriptions ?? {},
      setDescriptions: (d) => {
        folder.environmentDescriptions = Object.keys(d).length > 0 ? d : undefined;
      },
    };
  }
  const env = editor.selectedEnvId === 'base'
    ? collection.environments.base
    : collection.environments.subEnvironments.find((s) => s.id === editor.selectedEnvId);
  if (!env) {
    return null;
  }
  return {
    data: env.data,
    setData: (d) => {
      env.data = d;
    },
    descriptions: env.descriptions ?? {},
    setDescriptions: (d) => {
      env.descriptions = Object.keys(d).length > 0 ? d : undefined;
    },
  };
}

function envList(): HTMLElement {
  const editor = state.envEditor!;
  const collection = state.collection!;
  const removeSelected = (): void => {
    if (editor.selectedEnvId === 'base') {
      return;
    }
    const idx = collection.environments.subEnvironments.findIndex((s) => s.id === editor.selectedEnvId);
    if (idx < 0) {
      return;
    }
    collection.environments.subEnvironments.splice(idx, 1);
    if (state.ui.activeEnvironmentId === editor.selectedEnvId) {
      state.ui.activeEnvironmentId = null;
      touchUi();
    }
    editor.selectedEnvId = 'base';
    touch();
    markDirty();
    render();
  };
  const box = el('div', { class: 'env-list' });
  // 新增環境改由 sidebar 的環境選擇器（輸入名稱後選「＋ 新增環境」）
  box.append(
    el('div', { class: 'pane-toolbar' },
      el('span', { style: 'font-weight:600' }, '環境'),
      el('button', {
        class: 'icon',
        title: editor.selectedEnvId === 'base' ? 'Base Environment 不可移除' : '移除選取的環境',
        disabled: editor.selectedEnvId === 'base',
        style: 'margin-left:auto',
        onclick: removeSelected,
      }, '−'),
      closeButton(),
    ),
  );
  const items = el('div', { class: 'items' });
  const baseItem = el(
    'div',
    {
      class: `env-item${editor.selectedEnvId === 'base' ? ' selected' : ''}`,
      onclick: () => {
        editor.selectedEnvId = 'base';
        render();
      },
    },
    el('span', { class: 'env-dot' }),
    el('span', {}, collection.environments.base.name || 'Base Environment'),
  );
  items.append(baseItem);
  for (const sub of collection.environments.subEnvironments) {
    items.append(
      el(
        'div',
        {
          class: `env-item${editor.selectedEnvId === sub.id ? ' selected' : ''}`,
          onclick: () => {
            editor.selectedEnvId = sub.id;
            render();
          },
        },
        el('span', { class: 'env-dot', style: sub.color ? `background:${sub.color}` : '' }),
        el('span', {}, sub.name),
      ),
    );
  }
  box.append(items);
  return box;
}

/** 複製列時的 key 去重：base_url → base_url_copy → base_url_copy2 … */
function uniqueKey(key: string, taken: Set<string>): string {
  const base = `${key}_copy`;
  if (!taken.has(base)) {
    return base;
  }
  let n = 2;
  while (taken.has(`${base}${n}`)) {
    n++;
  }
  return `${base}${n}`;
}

/** 新列一定要有 key：空 key 的列會被 rebuild 丟掉，重繪後就消失了。 */
function nextVarKey(taken: Set<string>): string {
  let n = taken.size + 1;
  while (taken.has(`var${n}`)) {
    n++;
  }
  return `var${n}`;
}

/** host modal 確認刪除後回來：以當下環境為準重查，避免 modal 期間切了環境。 */
export function applyEnvVarDelete(key: string): void {
  const target = targetData();
  if (!target || !(key in target.data)) {
    return;
  }
  delete target.data[key];
  const descriptions = { ...target.descriptions };
  delete descriptions[key];
  target.setDescriptions(descriptions);
  touch();
  markDirty();
  render();
}

type KvEntry = [key: string, value: unknown, comment: string];

function kvEditor(target: EnvTarget): HTMLElement {
  const box = el('div', { class: 'kv-table' });
  const entries: KvEntry[] = Object.entries(target.data).map(
    ([k, v]) => [k, v, target.descriptions[k] ?? ''],
  );
  const rebuild = (updated: KvEntry[]): void => {
    const next: Record<string, unknown> = {};
    const nextDescriptions: Record<string, string> = {};
    for (const [k, v, comment] of updated) {
      if (k === '') {
        continue;
      }
      next[k] = v;
      if (comment !== '') {
        nextDescriptions[k] = comment;
      }
    }
    target.setData(next);
    target.setDescriptions(nextDescriptions);
    touch();
    markDirty();
  };
  entries.forEach(([key, value, comment], idx) => {
    const isComplex = typeof value === 'object' && value !== null;
    const keyInput = el('input', { type: 'text', class: 'k', value: key, spellcheck: false, placeholder: '名稱' });
    keyInput.addEventListener('input', () => {
      entries[idx] = [keyInput.value, entries[idx][1], entries[idx][2]];
      rebuild(entries);
    });
    const valueInput = el('input', {
      type: 'text',
      class: 'v',
      spellcheck: false,
      value: isComplex ? JSON.stringify(value) : String(value ?? ''),
      title: isComplex ? '巢狀值：以 JSON 編輯' : '',
    });
    valueInput.addEventListener('input', () => {
      let parsed: unknown = valueInput.value;
      if (isComplex || /^[[{]/.test(valueInput.value.trim())) {
        try {
          parsed = JSON.parse(valueInput.value);
        } catch {
          parsed = valueInput.value;
        }
      } else if (/^-?\d+(\.\d+)?$/.test(valueInput.value.trim())) {
        parsed = Number(valueInput.value);
      }
      entries[idx] = [entries[idx][0], parsed, entries[idx][2]];
      rebuild(entries);
    });
    const commentInput = el('input', {
      type: 'text',
      class: 'c',
      spellcheck: false,
      value: comment,
      placeholder: '註解',
      title: '此變數的用途說明（不會送出、不會匯出到 Insomnia）',
    });
    commentInput.addEventListener('input', () => {
      entries[idx] = [entries[idx][0], entries[idx][1], commentInput.value];
      rebuild(entries);
    });
    box.append(
      el('div', { class: 'kv-row' },
        keyInput,
        valueInput,
        commentInput,
        el('button', {
          class: 'icon',
          title: '在下方新增一列',
          onclick: () => {
            entries.splice(idx + 1, 0, [nextVarKey(new Set(entries.map((e) => e[0]))), '', '']);
            rebuild(entries);
            render();
          },
        }, '＋'),
        el('button', {
          class: 'icon',
          title: '複製此列',
          onclick: () => {
            const taken = new Set(entries.map((e) => e[0]));
            entries.splice(idx + 1, 0, [uniqueKey(entries[idx][0], taken), entries[idx][1], entries[idx][2]]);
            rebuild(entries);
            render();
          },
        }, '⧉'),
        el('button', {
          class: 'icon',
          title: '刪除',
          onclick: () => {
            // 尚未命名的空白列不值得跳確認，就地刪掉
            if (entries[idx][0] === '') {
              entries.splice(idx, 1);
              rebuild(entries);
              render();
              return;
            }
            post({ type: 'confirmDeleteEnvVar', key: entries[idx][0] });
          },
        }, '✕'),
      ),
    );
  });
  box.append(
    el('div', {}, el('button', {
      class: 'secondary',
      onclick: () => {
        entries.push([nextVarKey(new Set(entries.map((e) => e[0]))), '', '']);
        rebuild(entries);
        render();
      },
    }, '＋ 新增變數')),
  );
  return box;
}

export function renderEnvEditor(): HTMLElement | null {
  const editor = state.envEditor;
  const collection = state.collection;
  if (!editor || !collection) {
    return null;
  }
  const isCollectionTarget = editor.target === 'collection';
  const overlay = el('div', { id: 'env-editor' });

  if (isCollectionTarget) {
    overlay.append(envList());
  }

  const detail = el('div', { class: 'env-detail' });
  const target = targetData();
  const toolbar = el('div', { class: 'pane-toolbar' });

  if (isCollectionTarget && editor.selectedEnvId !== 'base') {
    const sub = collection.environments.subEnvironments.find((s) => s.id === editor.selectedEnvId);
    if (sub) {
      const nameInput = el('input', { type: 'text', value: sub.name, spellcheck: false });
      nameInput.addEventListener('input', () => {
        sub.name = nameInput.value;
        touch();
        markDirty();
      });
      const colorInput = el('input', { type: 'text', value: sub.color ?? '', placeholder: '#8abc39', style: 'width:90px', spellcheck: false });
      colorInput.addEventListener('input', () => {
        sub.color = colorInput.value || null;
        touch();
        markDirty();
      });
      toolbar.append(nameInput, colorInput);
    }
  } else if (isCollectionTarget) {
    const base = collection.environments.base;
    const nameInput = el('input', { type: 'text', value: base.name, spellcheck: false });
    nameInput.addEventListener('input', () => {
      base.name = nameInput.value;
      touch();
      markDirty();
    });
    toolbar.append(nameInput);
  } else {
    const folder = findNode(collection.children, (editor.target as { folderId: string }).folderId);
    toolbar.append(el('span', { style: 'font-weight:600' }, `資料夾變數：${folder && isFolder(folder) ? folder.name : ''}`));
  }

  const rawToggle = (mode: 'full' | 'dataOnly', label: string, style?: string): HTMLElement =>
    el('button', {
      class: 'secondary',
      style,
      onclick: () => {
        editor.rawMode = editor.rawMode === mode ? 'off' : mode;
        render();
      },
    }, editor.rawMode === mode ? '表格編輯' : label);

  toolbar.append(
    rawToggle('full', '原始 JSON', 'margin-left:auto'),
    rawToggle('dataOnly', '不含註解 JSON'),
  );
  if (!isCollectionTarget) {
    // 資料夾變數編輯沒有左側環境清單，關閉鈕放在這裡
    toolbar.append(closeButton());
  }
  detail.append(toolbar);

  const body = el('div', { class: 'pane-body' });
  if (!target) {
    body.append(el('div', { class: 'hint' }, '找不到目標環境。'));
  } else if (editor.rawMode !== 'off') {
    const withComments = editor.rawMode === 'full';
    const textarea = el('textarea', { class: 'raw', spellcheck: false });
    textarea.value = withComments
      ? JSON.stringify(
        Object.keys(target.descriptions).length > 0
          ? { data: target.data, descriptions: target.descriptions }
          : { data: target.data },
        null,
        2,
      )
      : JSON.stringify(target.data, null, 2);
    const hint = el('div', { class: 'hint' }, withComments
      ? '直接編輯 JSON；輸入時套用（不合法 JSON 不套用）。data = 變數、descriptions = 各變數的註解。'
      : '直接編輯 JSON；輸入時套用（不合法 JSON 不套用）。此模式只有變數值，註解不在其中；移除的變數其註解會一併清掉。');
    textarea.addEventListener('input', () => {
      try {
        const parsed = JSON.parse(textarea.value) as Record<string, unknown>;
        const data = withComments
          ? ((parsed.data ?? {}) as Record<string, unknown>)
          : parsed;
        target.setData(data);
        const descriptions = withComments
          ? ((parsed.descriptions ?? {}) as Record<string, string>)
          : target.descriptions;
        // 只留仍存在的變數的註解
        target.setDescriptions(
          Object.fromEntries(Object.entries(descriptions).filter(([k]) => k in data)),
        );
        touch();
        markDirty();
        hint.textContent = '已套用。';
      } catch (err) {
        hint.textContent = `JSON 不合法：${err instanceof Error ? err.message : String(err)}`;
      }
    });
    body.append(hint, textarea);
  } else {
    body.append(
      el('div', { class: 'hint' }, '值支援字串/數字；輸入 { 或 [ 開頭視為 JSON。變數以 {{ _.名稱 }} 於欄位中引用。註解僅供閱讀，不會送出。'),
      kvEditor(target),
    );
  }
  detail.append(body);
  overlay.append(detail);
  return overlay;
}
