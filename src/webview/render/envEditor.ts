// 環境變數獨立管理畫面（覆蓋主區域）。
// 左列：Base + sub-environments（新增/刪除/改名/設色）；右側：變數表格或原始 JSON。
// 資料夾層級變數由資料夾右鍵進入，編輯該資料夾的 environment 物件。

import type { SubEnvironment } from '../../core/model/types';
import { isFolder } from '../../core/model/types';
import { genId } from '../../core/model/ids';
import { el, findNode, render, state, touch } from '../store';

export function openEnvEditor(target: 'collection' | { folderId: string }): void {
  state.envEditor = { target, selectedEnvId: 'base', rawMode: false };
  render();
}

export function closeEnvEditor(): void {
  state.envEditor = null;
  render();
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
  const box = el('div', { class: 'env-list' });
  box.append(
    el('div', { class: 'pane-toolbar' },
      el('span', { style: 'font-weight:600' }, '環境'),
      el('button', {
        class: 'icon',
        title: '新增 sub-environment',
        style: 'margin-left:auto',
        onclick: () => {
          const sub: SubEnvironment = {
            id: genId('env'),
            name: `Environment ${collection.environments.subEnvironments.length + 1}`,
            color: null,
            data: {},
          };
          collection.environments.subEnvironments.push(sub);
          editor.selectedEnvId = sub.id;
          touch();
          render();
        },
      }, '＋'),
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
  };
  entries.forEach(([key, value], idx) => {
    const isComplex = typeof value === 'object' && value !== null;
    const keyInput = el('input', { type: 'text', class: 'k', value: key, spellcheck: false });
    keyInput.addEventListener('change', () => {
      entries[idx] = [keyInput.value, entries[idx][1]];
      rebuild(entries);
      render();
    });
    const valueInput = el('input', {
      type: 'text',
      class: 'v',
      spellcheck: false,
      value: isComplex ? JSON.stringify(value) : String(value ?? ''),
      title: isComplex ? '巢狀值：以 JSON 編輯' : '',
    });
    valueInput.addEventListener('change', () => {
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
      nameInput.addEventListener('change', () => {
        sub.name = nameInput.value;
        touch();
        render();
      });
      const colorInput = el('input', { type: 'text', value: sub.color ?? '', placeholder: '#8abc39', style: 'width:90px', spellcheck: false });
      colorInput.addEventListener('change', () => {
        sub.color = colorInput.value || null;
        touch();
        render();
      });
      toolbar.append(
        nameInput,
        colorInput,
        el('button', {
          class: 'secondary',
          onclick: () => {
            const idx = collection.environments.subEnvironments.findIndex((s) => s.id === sub.id);
            if (idx >= 0) {
              collection.environments.subEnvironments.splice(idx, 1);
            }
            if (state.ui.activeEnvironmentId === sub.id) {
              state.ui.activeEnvironmentId = null;
            }
            editor.selectedEnvId = 'base';
            touch();
            render();
          },
        }, '刪除此環境'),
      );
    }
  } else if (isCollectionTarget) {
    const base = collection.environments.base;
    const nameInput = el('input', { type: 'text', value: base.name, spellcheck: false });
    nameInput.addEventListener('change', () => {
      base.name = nameInput.value;
      touch();
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
    el('button', { onclick: closeEnvEditor }, '完成'),
  );
  detail.append(toolbar);

  const body = el('div', { class: 'pane-body' });
  if (!target) {
    body.append(el('div', { class: 'hint' }, '找不到目標環境。'));
  } else if (editor.rawMode) {
    const textarea = el('textarea', { class: 'raw', spellcheck: false });
    textarea.value = JSON.stringify(target.data, null, 2);
    const hint = el('div', { class: 'hint' }, '直接編輯 JSON；離開欄位時套用（不合法 JSON 不套用）。');
    textarea.addEventListener('change', () => {
      try {
        const parsed = JSON.parse(textarea.value) as Record<string, unknown>;
        target.setData(parsed);
        touch();
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
