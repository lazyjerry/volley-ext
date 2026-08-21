// 面板內文字搜尋：Cmd/Ctrl+F 開啟，在目標容器裡以 <mark> 標出比對結果並可上下巡覽。
// 值只存在 input/textarea 的 value 的欄位在 DOM 裡找不到文字，改在欄位本身加外框標示。

import type { FindState } from '../store';
import { el } from '../store';

/** 上限保護：整份 body 都是同一個字時，全部包 <mark> 會讓 DOM 爆量。 */
const MAX_HITS = 1000;

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'SELECT', 'OPTION', 'MARK']);

function matches(haystack: string, needle: string, matchCase: boolean): boolean {
  return matchCase
    ? haystack.includes(needle)
    : haystack.toLowerCase().includes(needle.toLowerCase());
}

function collectTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node): number => {
      const parent = node.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName) || parent.closest('.find-bar')) {
        return NodeFilter.FILTER_REJECT;
      }
      return (node.nodeValue ?? '') === '' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

/** 移除前一輪的標示，還原成純文字節點。 */
export function clearFindMarks(root: HTMLElement): void {
  for (const mark of [...root.querySelectorAll('mark.find-hit')]) {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
  }
  for (const field of [...root.querySelectorAll('.find-field-hit')]) {
    field.classList.remove('find-field-hit', 'find-current');
  }
  root.normalize();
}

function markTextNodes(root: HTMLElement, query: string, matchCase: boolean): number {
  const needle = matchCase ? query : query.toLowerCase();
  let count = 0;
  for (const node of collectTextNodes(root)) {
    const value = node.nodeValue ?? '';
    const haystack = matchCase ? value : value.toLowerCase();
    let at = haystack.indexOf(needle);
    if (at < 0) {
      continue;
    }
    const frag = document.createDocumentFragment();
    let from = 0;
    while (at >= 0 && count < MAX_HITS) {
      if (at > from) {
        frag.append(value.slice(from, at));
      }
      frag.append(el('mark', { class: 'find-hit' }, value.slice(at, at + needle.length)));
      count++;
      from = at + needle.length;
      at = haystack.indexOf(needle, from);
    }
    if (from < value.length) {
      frag.append(value.slice(from));
    }
    node.replaceWith(frag);
    if (count >= MAX_HITS) {
      break;
    }
  }
  return count;
}

/** 值沒有被 .template-overlay 鏡射成文字的欄位：整格標示，至少讓使用者找得到是哪一格。 */
function markFields(root: HTMLElement, query: string, matchCase: boolean): void {
  const fields = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  for (const field of fields) {
    if (field.closest('.find-bar')) {
      continue;
    }
    if (field instanceof HTMLInputElement && field.type !== 'text') {
      continue;
    }
    if (field.parentElement?.querySelector(':scope > .template-overlay')) {
      continue;
    }
    if (matches(field.value, query, matchCase)) {
      field.classList.add('find-field-hit');
    }
  }
}

/** 捲到命中處。overlay 的捲動由 input 驅動（varField 監聽 scroll 同步），不能直接捲 overlay。 */
function revealHit(hit: HTMLElement): void {
  const overlay = hit.closest('.template-overlay');
  if (overlay) {
    const wrapper = overlay.parentElement;
    const field = wrapper?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    if (field) {
      field.scrollTop = Math.max(0, hit.offsetTop - field.clientHeight / 2);
      field.scrollLeft = Math.max(0, hit.offsetLeft - field.clientWidth / 2);
      field.dispatchEvent(new Event('scroll'));
    }
    wrapper?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  hit.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** 重新標示容器內容並回傳命中數；同時把 findState.index 夾回合法範圍。 */
export function applyFind(root: HTMLElement, findState: FindState, reveal = true): number {
  clearFindMarks(root);
  if (findState.query === '') {
    return 0;
  }
  markTextNodes(root, findState.query, findState.matchCase);
  markFields(root, findState.query, findState.matchCase);
  const hits = [...root.querySelectorAll<HTMLElement>('mark.find-hit, .find-field-hit')];
  if (hits.length === 0) {
    return 0;
  }
  findState.index = ((findState.index % hits.length) + hits.length) % hits.length;
  const current = hits[findState.index];
  current.classList.add('find-current');
  if (reveal) {
    revealHit(current);
  }
  return hits.length;
}

export interface FindBarOptions {
  findState: FindState;
  /** 每次重新標示時取一次目標容器；面板重繪後拿到的是新節點。 */
  target: () => HTMLElement | null;
  placeholder?: string;
  /** 查詢字串變動時要連帶重繪面板（例如 sidebar 需展開命中的資料夾）才提供。 */
  onQueryChange?: () => void;
  /** 關閉搜尋列後重繪面板。 */
  onClose: () => void;
}

export interface FindBarHandle {
  element: HTMLElement;
  /** 面板內容重繪完成後呼叫：重新標示並更新計數。reveal=false 用於「只是補標示」而不該動捲軸的場合。 */
  refresh: (reveal?: boolean) => void;
}

/** findState.open 為 false 時回傳 null。 */
export function createFindBar(options: FindBarOptions): FindBarHandle | null {
  const findState = options.findState;
  if (!findState.open) {
    return null;
  }
  // type=search：讓 store 的 editableField() 不把搜尋框當成模型欄位（不觸發自動保存與訊息延後）
  const input = el('input', {
    type: 'search',
    class: 'find-input',
    value: findState.query,
    spellcheck: false,
    placeholder: options.placeholder ?? '搜尋內容…',
    title: 'Enter 下一個、Shift+Enter 上一個、Esc 關閉',
  });
  const counter = el('span', { class: 'find-count' });
  const bar = el('div', { class: 'find-bar' });

  const refresh = (reveal = true): void => {
    const target = options.target();
    const total = target ? applyFind(target, findState, reveal) : 0;
    counter.textContent = findState.query === ''
      ? ''
      : total === 0
        ? '無結果'
        : `${findState.index + 1}/${total}${total >= MAX_HITS ? '+' : ''}`;
    bar.classList.toggle('no-match', findState.query !== '' && total === 0);
  };

  const syncCaret = (): void => {
    findState.caret = input.selectionStart ?? input.value.length;
  };
  const step = (delta: number): void => {
    findState.index += delta;
    refresh();
  };
  const close = (): void => {
    findState.open = false;
    findState.focused = false;
    const target = options.target();
    if (target) {
      clearFindMarks(target);
    }
    options.onClose();
  };

  input.addEventListener('input', () => {
    findState.query = input.value;
    findState.index = 0;
    syncCaret();
    // onQueryChange 可能整個重畫面板；移除中的元素不一定發 blur，先自己記住焦點在這裡
    findState.focused = true;
    if (options.onQueryChange) {
      options.onQueryChange();
    } else {
      refresh();
    }
  });
  input.addEventListener('keyup', syncCaret);
  input.addEventListener('click', syncCaret);
  input.addEventListener('focus', () => {
    findState.focused = true;
  });
  input.addEventListener('blur', () => {
    findState.focused = false;
  });
  input.addEventListener('keydown', (event) => {
    const ev = event as KeyboardEvent;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      step(ev.shiftKey ? -1 : 1);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  });

  // 按工具鈕不該把焦點從搜尋框上拿走（拿走了下次重繪就不會還原焦點）
  const keepFocus = (ev: MouseEvent): void => ev.preventDefault();

  const caseBtn = el('button', {
    class: `icon find-toggle${findState.matchCase ? ' active' : ''}`,
    title: '區分大小寫',
    onmousedown: keepFocus,
    onclick: () => {
      findState.matchCase = !findState.matchCase;
      findState.index = 0;
      caseBtn.classList.toggle('active', findState.matchCase);
      refresh();
    },
  }, 'Aa');

  bar.append(
    input,
    caseBtn,
    counter,
    el('button', { class: 'icon', title: '上一個（Shift+Enter）', onmousedown: keepFocus, onclick: () => step(-1) }, '↑'),
    el('button', { class: 'icon', title: '下一個（Enter）', onmousedown: keepFocus, onclick: () => step(1) }, '↓'),
    el('button', { class: 'icon', title: '關閉（Esc）', onclick: close }, '✕'),
  );

  // 面板重繪會把搜尋框整個換掉（移除中的元素不發 blur），focused 記錄的是重繪前的狀態
  if (findState.focused) {
    const selectAll = findState.selectAll;
    findState.selectAll = false;
    setTimeout(() => {
      input.focus();
      if (selectAll) {
        input.select();
        return;
      }
      const caret = Math.min(findState.caret, input.value.length);
      input.setSelectionRange(caret, caret);
    }, 0);
  }

  return { element: bar, refresh };
}
