// 底部完整網址列：橫跨 request／response 兩欄，唯讀、可換行、可選取複製。
// 顯示目前 request 實際會送出的網址（變數展開、query 參數接上），組法與送出端共用 buildUrl。

import { interpolate } from '../../core/vars/template';
import { buildUrl } from '../../core/http/buildUrl';
import { el, selectedRequest, state } from '../store';
import { currentEnv } from './requestPane';

/** 高度跟著內容長，但最多到 CSS 的 max-height，再多就在框內捲動。 */
function autosize(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

/** 可重複呼叫：skeleton 的 #url-bar 常駐，這裡只換內容，不重建元素（輸入中也能即時更新）。 */
export function renderUrlBar(): void {
  const bar = document.getElementById('url-bar');
  if (!bar) {
    return;
  }
  let textarea = bar.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) {
    textarea = el('textarea', {
      class: 'url-bar-text',
      readonly: 'readonly',
      rows: '1',
      spellcheck: false,
      'aria-label': '目前 request 的完整網址（變數已展開）',
    });
    bar.append(textarea);
  }
  const request = selectedRequest();
  const hidden = !request || !state.collection;
  bar.classList.toggle('hidden', hidden);
  // 窄版只有 request／response 分頁需要看網址，Collection 分頁留給樹用
  bar.classList.toggle('narrow-hidden', state.isNarrow && state.narrowTab === 'sidebar');
  if (!request || !state.collection) {
    textarea.value = '';
    return;
  }
  if (request.url.trim() === '') {
    textarea.value = '';
    textarea.placeholder = '尚未填寫網址';
    textarea.title = '目前 request 的完整網址（變數已展開）';
    bar.classList.remove('has-missing-var');
    autosize(textarea);
    return;
  }
  const env = currentEnv();
  const missing = new Set<string>();
  const url = buildUrl(request, (s) => {
    const res = interpolate(s, env);
    res.missing.forEach((m) => missing.add(m));
    return res.result;
  });
  textarea.value = url;
  textarea.placeholder = '';
  textarea.title = missing.size > 0
    ? `目前 request 的完整網址；未定義的變數：${[...missing].join(', ')}`
    : '目前 request 的完整網址（變數已展開）';
  bar.classList.toggle('has-missing-var', missing.size > 0);
  autosize(textarea);
}
