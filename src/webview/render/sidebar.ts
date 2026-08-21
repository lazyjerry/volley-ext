// Sidebar：collection 選擇器、環境選擇器、資料夾/請求樹（增刪改、拖曳、右鍵選單）。

import type { Folder, RequestItem, SubEnvironment, TreeNode } from '../../core/model/types';
import type { ClientMessage } from '../../shared/protocol';
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
import { combobox } from './combobox';
import { createFindBar } from './findBar';

function codicon(name: string): HTMLElement {
  return el('span', { class: `codicon codicon-${name}` });
}

// 無 collection 時按鈕保持可見，點擊改以警告視窗提示
function requireCollection(action: () => void): void {
  if (!state.collection) {
    post({ type: 'showNotice', level: 'warn', message: '尚無 collection，請先建立 collection 再使用此功能。' });
    return;
  }
  action();
}

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

function countDescendants(folder: Folder): { requestCount: number; folderCount: number } {
  let requestCount = 0;
  let folderCount = 0;
  const walk = (nodes: TreeNode[]): void => {
    for (const n of nodes) {
      if (isFolder(n)) {
        folderCount++;
        walk(n.children);
      } else {
        requestCount++;
      }
    }
  };
  walk(folder.children);
  return { requestCount, folderCount };
}

/** 資料夾刪除：空資料夾直接刪，有內容則交由 host 端 modal 確認要不要連內容一起刪。 */
function deleteFolder(folder: Folder): void {
  if (folder.children.length === 0) {
    deleteNode(folder.id);
    return;
  }
  const { requestCount, folderCount } = countDescendants(folder);
  post({ type: 'confirmDeleteFolder', folderId: folder.id, name: folder.name, requestCount, folderCount });
}

export function applyFolderDelete(folderId: string, mode: 'all' | 'folderOnly'): void {
  const collection = state.collection;
  if (!collection) {
    return;
  }
  const node = findNode(collection.children, folderId);
  if (!node || !isFolder(node)) {
    return;
  }
  if (mode === 'folderOnly') {
    const list = findParentListOf(folderId) ?? collection.children;
    const idx = list.findIndex((n) => n.id === folderId);
    list.splice(idx, 1, ...node.children);
    list.forEach((n, i) => (n.sortKey = i));
    touch();
    render();
    return;
  }
  const removedIds = new Set<string>();
  const collect = (nodes: TreeNode[]): void => {
    for (const n of nodes) {
      removedIds.add(n.id);
      if (isFolder(n)) {
        collect(n.children);
      }
    }
  };
  collect([node]);
  removeNode(collection.children, folderId);
  if (state.ui.selectedRequestId && removedIds.has(state.ui.selectedRequestId)) {
    state.ui.selectedRequestId = null;
    touchUi();
  }
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
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
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
      { label: '刪除資料夾', danger: true, action: () => deleteFolder(node) },
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

// 搜尋期間要暫時展開命中節點的祖先資料夾；不寫進 ui.expandedFolders，關掉搜尋就恢復原樣。
let searchExpand = new Set<string>();
// URL 平常只放在 title 屬性，搜尋時得把它渲染出來，否則命中了卻標不出來也看不到
let searchQuery = '';

function nodeMatches(node: TreeNode, query: string): boolean {
  const haystack = isFolder(node)
    ? node.name
    : `${node.method} ${node.name} ${node.url}`;
  return haystack.toLowerCase().includes(query);
}

/** 回傳「子孫中有命中」的資料夾 id 集合。 */
function collectSearchExpand(nodes: TreeNode[], query: string, acc: Set<string>): boolean {
  let hit = false;
  for (const node of nodes) {
    if (isFolder(node)) {
      const childHit = collectSearchExpand(node.children, query, acc);
      if (childHit) {
        acc.add(node.id);
      }
      hit = hit || childHit || nodeMatches(node, query);
    } else if (nodeMatches(node, query)) {
      hit = true;
    }
  }
  return hit;
}

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
  // 不讓點擊冒泡到 tree-row，避免改名時誤觸資料夾展開／收合
  input.addEventListener('click', (ev) => ev.stopPropagation());
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

type DropPosition = 'before' | 'into' | 'after';

/** 拖放落點：request 以中線分上下；資料夾上下各 1/4 為排序、中間為放入。 */
function dropPosition(row: HTMLElement, node: TreeNode, ev: DragEvent): DropPosition {
  const rect = row.getBoundingClientRect();
  const ratio = rect.height > 0 ? (ev.clientY - rect.top) / rect.height : 0.5;
  if (isFolder(node)) {
    if (ratio < 0.25) {
      return 'before';
    }
    return ratio > 0.75 ? 'after' : 'into';
  }
  return ratio < 0.5 ? 'before' : 'after';
}

function clearDropHint(row: HTMLElement): void {
  row.classList.remove('drop-before', 'drop-after', 'drop-into');
}

// 拖曳中的來源 id：dataTransfer 在 dragover 階段讀不到值，另外記一份用來擋自我拖放
let draggingNodeId: string | null = null;

function setupDrag(row: HTMLElement, node: TreeNode): void {
  let expandTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelExpand = (): void => {
    if (expandTimer) {
      clearTimeout(expandTimer);
      expandTimer = undefined;
    }
  };

  row.draggable = true;
  row.addEventListener('dragstart', (ev) => {
    draggingNodeId = node.id;
    ev.dataTransfer?.setData('text/node-id', node.id);
    ev.dataTransfer!.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    draggingNodeId = null;
    row.classList.remove('dragging');
    clearDropHint(row);
    cancelExpand();
  });
  row.addEventListener('dragover', (ev) => {
    if (draggingNodeId === node.id) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer!.dropEffect = 'move';
    const position = dropPosition(row, node, ev);
    clearDropHint(row);
    row.classList.add(`drop-${position}`);
    // 停留在收合的資料夾上 → 自動展開，方便拖進巢狀層
    if (position === 'into' && !state.ui.expandedFolders.includes(node.id)) {
      expandTimer ??= setTimeout(() => {
        expandTimer = undefined;
        state.ui.expandedFolders.push(node.id);
        touchUi();
        render();
      }, 600);
    } else {
      cancelExpand();
    }
  });
  row.addEventListener('dragleave', () => {
    clearDropHint(row);
    cancelExpand();
  });
  row.addEventListener('drop', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    clearDropHint(row);
    cancelExpand();
    const sourceId = ev.dataTransfer?.getData('text/node-id');
    draggingNodeId = null;
    if (sourceId) {
      moveNode(sourceId, node.id, dropPosition(row, node, ev));
      render();
    }
  });
}

function renderNode(node: TreeNode): HTMLElement {
  const container = el('div', { class: 'tree-node' });
  if (isFolder(node)) {
    const expanded = state.ui.expandedFolders.includes(node.id) || searchExpand.has(node.id);
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
      el('span', { class: 'twisty' }, codicon(expanded ? 'chevron-down' : 'chevron-right')),
      el('span', { class: 'tree-icon' }, codicon(expanded ? 'folder-opened' : 'folder')),
      state.renamingNodeId === node.id ? renameInput(node) : el('span', { class: 'tree-label' }, node.name),
    );
    if (state.renamingNodeId !== node.id) {
      setupDrag(row, node);
    }
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
      searchQuery !== '' && node.name !== '' && node.url !== '' ? el('span', { class: 'tree-url' }, node.url) : null,
    );
    if (state.renamingNodeId !== node.id) {
      setupDrag(row, node);
    }
    container.append(row);
  }
  return container;
}

/** 從環境選擇器直接新增 sub-environment；名稱留空用預設編號。 */
function addEnvironment(name: string): void {
  const collection = state.collection;
  if (!collection) {
    return;
  }
  const sub: SubEnvironment = {
    id: genId('env'),
    name: name || `Environment ${collection.environments.subEnvironments.length + 1}`,
    color: null,
    data: {},
  };
  collection.environments.subEnvironments.push(sub);
  state.ui.activeEnvironmentId = sub.id;
  touch();
  touchUi();
  render();
}

export function renderSidebar(root: HTMLElement): void {
  root.replaceChildren();
  const collection = state.collection;

  const findState = state.find.sidebar;
  const query = findState.open ? findState.query.trim().toLowerCase() : '';
  searchExpand = new Set<string>();
  searchQuery = query;
  if (query !== '' && collection) {
    collectSearchExpand(collection.children, query, searchExpand);
  }

  // collection 選擇列：可搜尋，共用／私人分組，輸入新名稱可直接新增
  const collectionSelect = combobox({
    title: '選擇 collection（可輸入文字搜尋）',
    display: collection ? collection.name : '（無 collection）',
    placeholder: '搜尋或輸入新名稱…',
    selectedValue: collection?.id ?? null,
    groups: [
      { key: 'shared', label: '共用' },
      { key: 'private', label: '私人' },
    ],
    options: state.collections.map((c) => ({ value: c.id, label: c.name, group: c.source ?? 'shared' })),
    onSelect: (id) => post({ type: 'selectCollection', collectionId: id }),
    createActions: [
      {
        label: (t) => (t ? `新增到共用：「${t}」` : '新增 collection（共用）…'),
        run: (t) => post({ type: 'createCollection', name: t, source: 'shared' }),
      },
      {
        label: (t) => (t ? `新增到私人：「${t}」` : '新增 collection（私人）…'),
        run: (t) => post({ type: 'createCollection', name: t, source: 'private' }),
      },
    ],
  });

  const moreButton = el(
    'button',
    {
      class: 'secondary more-button',
      title: '匯入、匯出與其他 collection 操作',
      onclick: (ev: MouseEvent) => {
        // 阻擋冒泡：避免前一個選單的 window click 監聽器關掉剛開的選單
        ev.stopPropagation();
        const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        const run = (command: Extract<ClientMessage, { type: 'runCommand' }>['command']) => () => post({ type: 'runCommand', command });
        showCtxMenu(rect.left, rect.bottom + 2, [
          { label: '匯入 Insomnia…', action: run('importInsomnia') },
          { label: '匯入 OpenAPI…', action: run('importOpenApi') },
          { label: '從剪貼簿匯入 curl', action: run('importCurl') },
          { label: '從網址匯入…', action: run('importFromUrl') },
          { sep: true, label: '' },
          { label: '匯出 Insomnia v5 YAML…', action: run('exportInsomniaYaml') },
          { label: '匯出 Clean OpenAPI…', action: run('exportOpenApi') },
          { sep: true, label: '' },
          { label: '選擇共用資料夾…', action: () => post({ type: 'chooseDataFolder', source: 'shared' }) },
          { label: '選擇私人資料夾…', action: () => post({ type: 'chooseDataFolder', source: 'private' }) },
          { label: '在 Finder 顯示共用資料夾', action: () => post({ type: 'openDataFolder', source: 'shared' }) },
          { label: '在 Finder 顯示私人資料夾', action: () => post({ type: 'openDataFolder', source: 'private' }) },
          { label: '從磁碟重新載入', action: run('reload') },
        ]);
      },
    },
    '更多…',
    codicon('chevron-down'),
  );

  // 環境選擇列：可搜尋，輸入新名稱可直接新增 sub-environment
  let envSelect: HTMLElement | null = null;
  if (collection) {
    const base = collection.environments.base;
    const subs = collection.environments.subEnvironments;
    const activeSub = subs.find((s) => s.id === state.ui.activeEnvironmentId);
    envSelect = combobox({
      title: '作用中環境（可輸入文字搜尋）',
      display: activeSub ? activeSub.name : base.name || 'Base Environment',
      displayDot: activeSub ? (activeSub.color ?? null) : null,
      placeholder: '搜尋或輸入新環境名稱…',
      selectedValue: state.ui.activeEnvironmentId ?? '',
      options: [
        { value: '', label: base.name || 'Base Environment', dotColor: null },
        ...subs.map((s) => ({ value: s.id, label: s.name, dotColor: s.color ?? null })),
      ],
      onSelect: (value) => {
        state.ui.activeEnvironmentId = value === '' ? null : value;
        touchUi();
        render();
      },
      createActions: [
        {
          label: (t) => (t ? `新增環境：「${t}」` : '新增環境…'),
          run: addEnvironment,
        },
      ],
    });
  }

  const header = el(
    'div',
    { class: 'sidebar-header' },
    el(
      'div',
      { class: 'row' },
      collectionSelect,
      el('button', { class: 'icon', title: '新增資料夾', onclick: () => requireCollection(() => newFolder(null)) }, codicon('new-folder')),
      el('button', {
        class: 'icon',
        title: '重新命名 collection',
        onclick: () => requireCollection(() => post({ type: 'renameCollection', collectionId: state.collection!.id })),
      }, codicon('edit')),
      el('button', {
        class: 'icon',
        title: '刪除 collection',
        onclick: () => requireCollection(() => post({ type: 'deleteCollection', collectionId: state.collection!.id })),
      }, codicon('trash')),
      el('button', {
        class: 'icon',
        title: '從磁碟重新載入（外部或其他裝置的變更）',
        onclick: () => post({ type: 'runCommand', command: 'reload' }),
      }, codicon('refresh')),
    ),
    el(
      'div',
      { class: 'row' },
      collection ? envSelect : null,
      collection
        ? el('button', { class: 'icon', title: '管理環境變數', onclick: () => openEnvEditor('collection') }, codicon('settings-gear'))
        : null,
      moreButton,
    ),
  );
  root.append(header);

  // 搜尋 request 名稱／method／URL：命中的資料夾暫時展開，命中的文字直接在樹上標色
  const findBar = createFindBar({
    findState,
    target: () => root.querySelector<HTMLElement>('.tree'),
    placeholder: '搜尋 request 名稱或網址…',
    // 查詢字串會改變展開狀態，必須重畫整棵樹後才重新標示
    onQueryChange: () => renderSidebar(root),
    onClose: () => renderSidebar(root),
  });
  if (findBar) {
    root.append(findBar.element);
  }

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
        '空 collection。在空白處右鍵新增 request／資料夾（或點擊新增資料夾按鈕），也可用「更多…」匯入 OpenAPI / curl / Insomnia 格式。',
      ),
    );
  } else {
    for (const node of collection.children) {
      tree.append(renderNode(node));
    }
  }
  root.append(tree);
  findBar?.refresh();
}
