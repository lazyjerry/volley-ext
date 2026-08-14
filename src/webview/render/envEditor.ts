// 環境變數獨立管理畫面（覆蓋主區域）。
// 左列：Base + sub-environments（新增/刪除/改名/設色）；右側：變數表格或原始 JSON。
// 資料夾層級變數由資料夾右鍵進入，編輯該資料夾的 environment 物件。

import { isFolder } from '../../core/model/types';
import { el, findNode, flushPendingEdits, render, state, touch, touchUi } from '../store';

export function openEnvEditor(target: 'collection' | { folderId: string }): void {
  state.envEditor = { target, selectedEnvId: 'base', rawMode: false, dirty: false };
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

function targetData(): { data: Record<string, unknown>; setData: (d: Record<string, unknown>) => void } | null {
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
    };
  }
  if (editor.selectedEnvId === 'base') {
    return {
      data: collection.environments.base.data,
      setData: (d) => {
        collection.environments.base.data = d;
      },
    };
  }
  const sub = collection.environments.subEnvironments.find((s) => s.id === editor.selectedEnvId);
  if (!sub) {
    return null;
  }
  return {
    data: sub.data,
    setData: (d) => {
      sub.data = d;
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

function kvEditor(data: Record<string, unknown>, setData: (d: Record<string, unknown>) => void): HTMLElement {
  const box = el('div', { class: 'kv-table' });
  const entries = Object.entries(data);
  const rebuild = (updated: Array<[string, unknown]>): void => {
    const next: Record<string, unknown> = {};
    for (const [k, v] of updated) {
      if (k !== '') {
        next[k] = v;
      }
    }
    setData(next);
    touch();
    markDirty();
  };
  entries.forEach(([key, value], idx) => {
    const isComplex = typeof value === 'object' && value !== null;
    const keyInput = el('input', { type: 'text', class: 'k', value: key, spellcheck: false });
    keyInput.addEventListener('input', () => {
      entries[idx] = [keyInput.value, entries[idx][1]];
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
      entries[idx] = [entries[idx][0], parsed];
      rebuild(entries);
    });
    box.append(
      el('div', { class: 'kv-row' },
        keyInput,
        valueInput,
        el('button', {
          class: 'icon',
          title: '刪除',
          onclick: () => {
            entries.splice(idx, 1);
            rebuild(entries);
            render();
          },
        }, '✕'),
      ),
    );
  });
  box.append(
    el('div', {}, el('button', {
      class: 'secondary',
      onclick: () => {
        entries.push([`var${entries.length + 1}`, '']);
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

  toolbar.append(
    el('button', {
      class: 'secondary',
      style: 'margin-left:auto',
      onclick: () => {
        editor.rawMode = !editor.rawMode;
        render();
      },
    }, editor.rawMode ? '表格編輯' : '原始 JSON'),
  );
  if (!isCollectionTarget) {
    // 資料夾變數編輯沒有左側環境清單，關閉鈕放在這裡
    toolbar.append(closeButton());
  }
  detail.append(toolbar);

  const body = el('div', { class: 'pane-body' });
  if (!target) {
    body.append(el('div', { class: 'hint' }, '找不到目標環境。'));
  } else if (editor.rawMode) {
    const textarea = el('textarea', { class: 'raw', spellcheck: false });
    textarea.value = JSON.stringify(target.data, null, 2);
    const hint = el('div', { class: 'hint' }, '直接編輯 JSON；輸入時套用（不合法 JSON 不套用）。');
    textarea.addEventListener('input', () => {
      try {
        const parsed = JSON.parse(textarea.value) as Record<string, unknown>;
        target.setData(parsed);
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
      el('div', { class: 'hint' }, '值支援字串/數字；輸入 { 或 [ 開頭視為 JSON。變數以 {{ _.名稱 }} 於欄位中引用。'),
      kvEditor(target.data, target.setData),
    );
  }
  detail.append(body);
  overlay.append(detail);
  return overlay;
}
