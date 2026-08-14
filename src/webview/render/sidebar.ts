// Sidebar：collection 選擇器、環境選擇器、資料夾/請求樹（增刪改、拖曳、右鍵選單）。

import type { Folder, RequestItem, TreeNode } from '../../core/model/types';
import { defaultSettings, isFolder } from '../../core/model/types';
import { genId } from '../../core/model/ids';
import {
  el,
  findNode,
  insertNode,
  moveNode,
  post,
  removeNode,
  render,
  state,
  touch,
  touchUi,
} from '../store';
import { openEnvEditor } from './envEditor';

export function newRequest(folderId: string | null): void {
  const request: RequestItem = {
    kind: 'request',
    id: genId('req'),
    name: 'New Request',
    sortKey: 0,
    method: 'GET',
    url: '',
    parameters: [],
    pathParameters: [],
    headers: [],
    body: {},
    authentication: {},
    settings: defaultSettings(),
  };
  insertNode(request, folderId);
  state.ui.selectedRequestId = request.id;
  state.renamingNodeId = request.id;
  touchUi();
  render();
}

export function newFolder(folderId: string | null): void {
  const folder: Folder = {
    kind: 'folder',
    id: genId('fld'),
    name: 'New Folder',
    sortKey: 0,
    children: [],
  };
  insertNode(folder, folderId);
  state.renamingNodeId = folder.id;
  render();
}

function selectRequest(id: string): void {
  state.ui.selectedRequestId = id;
  touchUi();
  if (state.collection) {
    post({ type: 'loadHistory', collectionId: state.collection.id, requestId: id });
  }
  if (state.isNarrow) {
    state.narrowTab = 'request';
  }
  render();
}

function deleteNode(id: string): void {
  const collection = state.collection;
  if (!collection) {
    return;
  }
  removeNode(collection.children, id);
  if (state.ui.selectedRequestId === id) {
    state.ui.selectedRequestId = null;
    touchUi();
  }
  touch();
  render();
}

function duplicateRequest(id: string): void {
  const collection = state.collection;
  if (!collection) {
    return;
  }
  const node = findNode(collection.children, id);
  if (!node || isFolder(node)) {
    return;
  }
  const copy = JSON.parse(JSON.stringify(node)) as RequestItem;
  copy.id = genId('req');
  copy.name = `${node.name} (copy)`;
  const list = state.collection ? (findParentListOf(id) ?? collection.children) : collection.children;
  const idx = list.findIndex((n) => n.id === id);
  list.splice(idx + 1, 0, copy);
  list.forEach((n, i) => (n.sortKey = i));
  touch();
  render();
}

function findParentListOf(id: string): TreeNode[] | undefined {
  const collection = state.collection;
  if (!collection) {
    return undefined;
  }
  const walk = (children: TreeNode[]): TreeNode[] | undefined => {
    for (const n of children) {
      if (n.id === id) {
        return children;
      }
      if (isFolder(n)) {
        const found = walk(n.children);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };
  return walk(collection.children);
}

// ---- 右鍵選單 ----

function closeCtxMenu(): void {
  document.getElementById('ctx-menu')?.remove();
}

interface MenuItem {
  label: string;
  danger?: boolean;
  sep?: boolean;
  action?: () => void;
}

function showCtxMenu(x: number, y: number, items: MenuItem[]): void {
  closeCtxMenu();
  const menu = el('div', { id: 'ctx-menu' });
  for (const item of items) {
    if (item.sep) {
      menu.append(el('div', { class: 'sep' }));
      continue;
    }
    menu.append(
      el(
        'div',
        {
          class: `item${item.danger ? ' danger' : ''}`,
          onclick: () => {
            closeCtxMenu();
            item.action?.();
          },
        },
        item.label,
      ),
    );
  }
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
  setTimeout(() => {
    window.addEventListener('click', closeCtxMenu, { once: true });
    window.addEventListener('contextmenu', closeCtxMenu, { once: true });
  }, 0);
}

function nodeMenu(node: TreeNode, ev: MouseEvent): void {
  ev.preventDefault();
  ev.stopPropagation();
  const items: MenuItem[] = [];
  if (isFolder(node)) {
    items.push(
      { label: '新增 Request', action: () => newRequest(node.id) },
      { label: '新增資料夾', action: () => newFolder(node.id) },
      { sep: true, label: '' },
      { label: '重新命名', action: () => { state.renamingNodeId = node.id; render(); } },
      { label: '編輯資料夾變數', action: () => openEnvEditor({ folderId: node.id }) },
      { sep: true, label: '' },
      { label: '刪除', danger: true, action: () => deleteNode(node.id) },
    );
  } else {
    items.push(
      { label: '重新命名', action: () => { state.renamingNodeId = node.id; render(); } },
      { label: '複製一份', action: () => duplicateRequest(node.id) },
      {
        label: '複製為 curl',
        action: () => {
          if (state.collection) {
            post({ type: 'exportCurl', collectionId: state.collection.id, requestId: node.id, copyToClipboard: true });
          }
        },
      },
      { sep: true, label: '' },
      { label: '刪除', danger: true, action: () => deleteNode(node.id) },
    );
  }
  showCtxMenu(ev.clientX, ev.clientY, items);
}

// ---- 樹渲染 ----

function renameInput(node: TreeNode): HTMLElement {
  const input = el('input', { type: 'text', value: node.name, class: 'tree-label' });
  const commit = (): void => {
    const value = input.value.trim();
    if (value !== '' && value !== node.name) {
      node.name = value;
      touch();
    }
    state.renamingNodeId = null;
    render();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      commit();
    } else if (ev.key === 'Escape') {
      state.renamingNodeId = null;
      render();
    }
  });
  input.addEventListener('blur', commit);
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  return input;
}

function setupDrag(row: HTMLElement, node: TreeNode): void {
  row.draggable = true;
  row.addEventListener('dragstart', (ev) => {
    ev.dataTransfer?.setData('text/node-id', node.id);
    ev.dataTransfer!.effectAllowed = 'move';
  });
  row.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    row.classList.remove('drop-target');
    const sourceId = ev.dataTransfer?.getData('text/node-id');
    if (sourceId) {
      moveNode(sourceId, node.id, isFolder(node) ? 'into' : 'before');
      render();
    }
  });
}

function renderNode(node: TreeNode): HTMLElement {
  const container = el('div', { class: 'tree-node' });
  if (isFolder(node)) {
    const expanded = state.ui.expandedFolders.includes(node.id);
    const row = el(
      'div',
      {
        class: 'tree-row',
        oncontextmenu: (ev: MouseEvent) => nodeMenu(node, ev),
        onclick: () => {
          const idx = state.ui.expandedFolders.indexOf(node.id);
          if (idx >= 0) {
            state.ui.expandedFolders.splice(idx, 1);
          } else {
            state.ui.expandedFolders.push(node.id);
          }
          touchUi();
          render();
        },
      },
      el('span', { class: 'twisty' }, expanded ? '▾' : '▸'),
      el('span', { class: 'twisty' }, '🗀'),
      state.renamingNodeId === node.id ? renameInput(node) : el('span', { class: 'tree-label' }, node.name),
    );
    setupDrag(row, node);
    container.append(row);
    if (expanded) {
      const childrenBox = el('div', { class: 'tree-children' });
      for (const child of node.children) {
        childrenBox.append(renderNode(child));
      }
      container.append(childrenBox);
    }
  } else {
    const row = el(
      'div',
      {
        class: `tree-row${state.ui.selectedRequestId === node.id ? ' selected' : ''}`,
        oncontextmenu: (ev: MouseEvent) => nodeMenu(node, ev),
        onclick: () => selectRequest(node.id),
      },
      el('span', { class: `method-tag method-${node.method}` }, node.method),
      state.renamingNodeId === node.id ? renameInput(node) : el('span', { class: 'tree-label', title: node.url }, node.name || node.url || '(未命名)'),
    );
    setupDrag(row, node);
    container.append(row);
  }
  return container;
}

export function renderSidebar(root: HTMLElement): void {
  root.replaceChildren();
  const collection = state.collection;

  // collection 選擇列
  const collectionSelect = el('select', {
    onchange: (ev: Event) => {
      const id = (ev.target as HTMLSelectElement).value;
      if (id === '__new__') {
        post({ type: 'runCommand', command: 'newCollection' });
      } else if (id) {
        post({ type: 'selectCollection', collectionId: id });
      }
    },
  });
  for (const c of state.collections) {
    collectionSelect.append(
      el('option', { value: c.id, ...(collection?.id === c.id ? { selected: 'selected' } : {}) }, c.name),
    );
  }
  collectionSelect.append(el('option', { value: '__new__' }, '＋ 新增 collection…'));
  if (!collection) {
    collectionSelect.prepend(el('option', { value: '', selected: 'selected' }, '（無 collection）'));
  }

  // 環境選擇列
  const envSelect = el('select', {
    title: '作用中環境',
    onchange: (ev: Event) => {
      const value = (ev.target as HTMLSelectElement).value;
      state.ui.activeEnvironmentId = value === '' ? null : value;
      touchUi();
      render();
    },
  });
  if (collection) {
    envSelect.append(
      el('option', { value: '', ...(state.ui.activeEnvironmentId ? {} : { selected: 'selected' }) }, collection.environments.base.name || 'Base Environment'),
    );
    for (const sub of collection.environments.subEnvironments) {
      envSelect.append(
        el(
          'option',
          { value: sub.id, ...(state.ui.activeEnvironmentId === sub.id ? { selected: 'selected' } : {}) },
          sub.name,
        ),
      );
    }
  }

  const header = el(
    'div',
    { class: 'sidebar-header' },
    el(
      'div',
      { class: 'row' },
      collectionSelect,
      el('button', { class: 'icon', title: '新增 Request', onclick: () => newRequest(null) }, '＋'),
    ),
    collection
      ? el(
          'div',
          { class: 'row' },
          envSelect,
          el('button', { class: 'icon', title: '管理環境變數', onclick: () => openEnvEditor('collection') }, '⚙'),
        )
      : null,
  );
  root.append(header);

  const tree = el('div', {
    class: 'tree',
    oncontextmenu: (ev: MouseEvent) => {
      if ((ev.target as HTMLElement).closest('.tree-row')) {
        return;
      }
      ev.preventDefault();
      showCtxMenu(ev.clientX, ev.clientY, [
        { label: '新增 Request', action: () => newRequest(null) },
        { label: '新增資料夾', action: () => newFolder(null) },
        { label: '從剪貼簿匯入 curl', action: () => post({ type: 'runCommand', command: 'importCurl' }) },
      ]);
    },
    ondragover: (ev: DragEvent) => ev.preventDefault(),
    ondrop: (ev: DragEvent) => {
      const sourceId = ev.dataTransfer?.getData('text/node-id');
      if (sourceId && collection && !(ev.target as HTMLElement).closest('.tree-row')) {
        // 拖到空白處 → 移到根層末端
        const node = removeNode(collection.children, sourceId);
        if (node) {
          node.sortKey = collection.children.length;
          collection.children.push(node);
          touch();
          render();
        }
      }
    },
  });

  if (!collection) {
    tree.append(
      el(
        'div',
        { class: 'tree-empty' },
        '尚無 collection。',
        el('br'),
        el('button', { onclick: () => post({ type: 'runCommand', command: 'newCollection' }) }, '建立 collection'),
      ),
    );
  } else if (collection.children.length === 0) {
    tree.append(
      el(
        'div',
        { class: 'tree-empty' },
        '空 collection。右鍵或 ＋ 新增 request，或用指令匯入 OpenAPI / curl / Insomnia 格式。',
      ),
    );
  } else {
    for (const node of collection.children) {
      tree.append(renderNode(node));
    }
  }
  root.append(tree);
}
