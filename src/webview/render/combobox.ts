// select2 式下拉元件：點開後以文字搜尋過濾選項，
// 搜尋字串沒有完全一致的選項時，底部顯示「＋ 新增」動作列。

import { el } from '../store';

export interface ComboGroup {
  key: string;
  label: string;
}

export interface ComboOption {
  value: string;
  label: string;
  group?: string;
  /** 顯示色點（環境用）；undefined = 不顯示 */
  dotColor?: string | null;
}

export interface ComboCreateAction {
  /** text = 目前搜尋字串（已 trim） */
  label: (text: string) => string;
  run: (text: string) => void;
}

export interface ComboConfig {
  title?: string;
  display: string;
  displayDot?: string | null;
  placeholder?: string;
  options: ComboOption[];
  selectedValue?: string | null;
  groups?: ComboGroup[];
  onSelect: (value: string) => void;
  createActions?: ComboCreateAction[];
}

function dot(color: string | null): HTMLElement {
  return el('span', { class: 'env-dot', style: color ? `background:${color}` : '' });
}

export function combobox(config: ComboConfig): HTMLElement {
  const container = el('div', { class: 'combo', title: config.title ?? '' });
  const button = el(
    'div',
    { class: 'combo-button', tabindex: '0', role: 'button' },
    config.displayDot !== undefined ? dot(config.displayDot) : null,
    el('span', { class: 'combo-label' }, config.display),
    el('span', { class: 'codicon codicon-chevron-down' }),
  );
  container.append(button);

  let panel: HTMLElement | null = null;

  const close = (): void => {
    panel?.remove();
    panel = null;
    document.removeEventListener('mousedown', onOutside, true);
  };

  const onOutside = (ev: MouseEvent): void => {
    if (!container.contains(ev.target as Node)) {
      close();
    }
  };

  const open = (): void => {
    if (panel) {
      close();
      return;
    }
    const search = el('input', { type: 'text', class: 'combo-search', placeholder: config.placeholder ?? '搜尋…', spellcheck: false });
    const list = el('div', { class: 'combo-list' });
    panel = el('div', { class: 'combo-panel' }, search, list);
    container.append(panel);
    document.addEventListener('mousedown', onOutside, true);

    // 可鍵盤操作的列（選項 + 新增動作），每次過濾後重建
    let rows: Array<{ element: HTMLElement; activate: () => void }> = [];
    let activeIdx = 0;

    const setActive = (idx: number): void => {
      if (rows.length === 0) {
        return;
      }
      activeIdx = Math.max(0, Math.min(idx, rows.length - 1));
      rows.forEach((row, i) => row.element.classList.toggle('active', i === activeIdx));
      rows[activeIdx].element.scrollIntoView({ block: 'nearest' });
    };

    const addRow = (element: HTMLElement, activate: () => void): void => {
      element.addEventListener('click', () => {
        close();
        activate();
      });
      const idx = rows.length;
      element.addEventListener('mousemove', () => setActive(idx));
      rows.push({ element, activate });
      list.append(element);
    };

    const rebuild = (): void => {
      list.replaceChildren();
      rows = [];
      const text = search.value.trim();
      const lower = text.toLowerCase();
      const matches = config.options.filter((o) => o.label.toLowerCase().includes(lower));
      const renderOption = (option: ComboOption): void => {
        addRow(
          el(
            'div',
            { class: `combo-option${option.value === config.selectedValue ? ' selected' : ''}` },
            option.dotColor !== undefined ? dot(option.dotColor) : null,
            el('span', { class: 'combo-label' }, option.label),
          ),
          () => config.onSelect(option.value),
        );
      };
      const groups = config.groups ?? [];
      if (groups.length === 0) {
        matches.forEach(renderOption);
      } else {
        for (const group of groups) {
          const inGroup = matches.filter((o) => o.group === group.key);
          if (inGroup.length > 0) {
            list.append(el('div', { class: 'combo-group-label' }, group.label));
            inGroup.forEach(renderOption);
          }
        }
      }
      if (matches.length === 0 && (config.createActions ?? []).length === 0) {
        list.append(el('div', { class: 'combo-empty' }, '沒有符合的項目'));
      }
      // 沒有名稱完全一致的選項時才顯示新增列（空字串 = 一般新增入口）
      const hasExact = config.options.some((o) => o.label.trim().toLowerCase() === lower);
      if (!hasExact) {
        for (const action of config.createActions ?? []) {
          addRow(
            el('div', { class: 'combo-option combo-create' },
              el('span', { class: 'codicon codicon-add' }),
              el('span', { class: 'combo-label' }, action.label(text)),
            ),
            () => action.run(text),
          );
        }
      }
      setActive(0);
    };

    search.addEventListener('input', rebuild);
    search.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        setActive(activeIdx + 1);
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        setActive(activeIdx - 1);
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        const row = rows[activeIdx];
        if (row) {
          close();
          row.activate();
        }
      } else if (ev.key === 'Escape') {
        ev.stopPropagation();
        close();
        button.focus();
      }
    });

    rebuild();
    search.focus();
  };

  button.addEventListener('click', open);
  button.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      open();
    }
  });

  return container;
}
