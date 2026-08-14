// 響應式版面：寬 ≥ 840px 三欄 grid + splitter，窄改 tab 切換。
// 只加減 class，不重建 DOM。

import { render, state, touchUi } from './store';

export const NARROW_BREAKPOINT = 840;

export function initLayout(): void {
  const observer = new ResizeObserver(() => {
    const narrow = document.body.clientWidth < NARROW_BREAKPOINT;
    if (narrow !== state.isNarrow) {
      state.isNarrow = narrow;
      applyLayoutClass();
      render();
    }
  });
  observer.observe(document.body);
  state.isNarrow = document.body.clientWidth < NARROW_BREAKPOINT;
  applyLayoutClass();
  applyColumnWidths();
}

export function applyLayoutClass(): void {
  document.body.classList.toggle('layout-narrow', state.isNarrow);
  document.body.classList.toggle('layout-wide', !state.isNarrow);
}

export function applyColumnWidths(): void {
  const main = document.getElementById('main');
  if (!main) {
    return;
  }
  const sidebarPct = state.ui.layout?.sidebarPct ?? 22;
  const requestPct = state.ui.layout?.requestPct ?? 39;
  main.style.gridTemplateColumns = `minmax(150px, ${sidebarPct}%) 4px minmax(200px, ${requestPct}%) 4px 1fr`;
}

export function initSplitters(): void {
  const main = document.getElementById('main');
  if (!main) {
    return;
  }
  const setup = (splitterId: string, which: 'sidebar' | 'request'): void => {
    const splitter = document.getElementById(splitterId);
    if (!splitter) {
      return;
    }
    splitter.addEventListener('pointerdown', (down) => {
      down.preventDefault();
      splitter.setPointerCapture(down.pointerId);
      const total = main.clientWidth;
      const move = (ev: PointerEvent): void => {
        const pct = Math.min(70, Math.max(10, (ev.clientX / total) * 100));
        state.ui.layout = state.ui.layout ?? {};
        if (which === 'sidebar') {
          state.ui.layout.sidebarPct = pct;
        } else {
          const sidebarPct = state.ui.layout.sidebarPct ?? 22;
          state.ui.layout.requestPct = Math.min(75, Math.max(15, pct - sidebarPct));
        }
        applyColumnWidths();
      };
      const up = (): void => {
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
        touchUi();
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
    });
  };
  setup('split-1', 'sidebar');
  setup('split-2', 'request');
}
