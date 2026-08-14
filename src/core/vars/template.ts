// 變數插值：{{ _.a.b }}、{{ _['x-y'] }}、舊式 {{ varName }}（語法與 Insomnia 格式相容）。
// {% ... %} template tag 不解析、原樣保留（以 warning 回報）。

export interface InterpolateResult {
  result: string;
  missing: string[];
  hasTemplateTags: boolean;
}

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const TAG_RE = /\{%[^%]*%\}/;

/** 解析 `_.a.b` / `_['x-y']` / `_["x"]` / `a.b` 為 key path；無法解析回傳 null。 */
export function parseVarPath(expr: string): string[] | null {
  let rest = expr.trim();
  if (rest === '' || rest === '_') {
    return null;
  }
  if (rest.startsWith('_.') || rest.startsWith('_[')) {
    rest = rest.slice(1);
  } else if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(rest)) {
    // 舊式 {{ varName }} 或 {{ a.b }} → 視為 _.varName
    return rest.split('.');
  } else {
    return null;
  }
  const path: string[] = [];
  while (rest.length > 0) {
    if (rest.startsWith('.')) {
      const m = /^\.([A-Za-z_$][\w$-]*)/.exec(rest);
      if (!m) {
        return null;
      }
      path.push(m[1]);
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith('[')) {
      const m = /^\[\s*(?:'([^']*)'|"([^"]*)")\s*\]/.exec(rest);
      if (!m) {
        return null;
      }
      path.push(m[1] ?? m[2]);
      rest = rest.slice(m[0].length);
    } else {
      return null;
    }
  }
  return path.length > 0 ? path : null;
}

function lookup(data: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = data;
  for (const key of path) {
    if (cur !== null && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function interpolate(input: string, data: Record<string, unknown>): InterpolateResult {
  const missing: string[] = [];
  const hasTemplateTags = TAG_RE.test(input);
  const result = input.replace(VAR_RE, (whole, expr: string) => {
    const path = parseVarPath(expr);
    if (!path) {
      missing.push(expr.trim());
      return whole;
    }
    const value = lookup(data, path);
    if (value === undefined) {
      missing.push(path.join('.'));
      return whole;
    }
    if (value === null) {
      return '';
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
  return { result, missing, hasTemplateTags };
}

/** 欄位是否含變數片段（UI 標示用）。 */
export function containsTemplate(input: string): boolean {
  VAR_RE.lastIndex = 0;
  return VAR_RE.test(input) || TAG_RE.test(input);
}
