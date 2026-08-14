// 從網址下載匯入檔，並自動辨識格式（Insomnia v5/v4、OpenAPI 3.x、本延伸模組原生檔）。

import * as YAML from 'yaml';
import type { Collection } from '../model/types';
import { importInsomniaV4, isInsomniaV4 } from './insomniaV4';
import { importInsomniaV5, isInsomniaV5 } from './insomniaV5';
import { importOpenApi } from './openapiImport';
import { isNativeDocument, parseCollection } from './openapiStore';

export async function downloadText(url: string, timeoutMs = 30000): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`無效的網址：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('僅支援 http / https 網址');
  }
  let response: Response;
  try {
    response = await fetch(parsed, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // fetch 的網路層錯誤（DNS、連線拒絕）常包在 cause 裡，攤平成可讀訊息
    const cause = (err as { cause?: unknown }).cause;
    const detail =
      cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
    throw new Error(`下載失敗：${detail}`);
  }
  if (!response.ok) {
    throw new Error(`下載失敗：HTTP ${response.status} ${response.statusText}`.trimEnd());
  }
  return await response.text();
}

export function parseImportedText(text: string): Collection {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch {
    throw new Error('資料格式不符：內容不是有效的 YAML / JSON');
  }
  if (isInsomniaV4(doc)) {
    return importInsomniaV4(text);
  }
  if (isInsomniaV5(doc)) {
    return importInsomniaV5(text);
  }
  if (doc && typeof doc === 'object') {
    // 本延伸模組產生的檔（含 x-volley）走原生解析，保留完整資訊
    if (isNativeDocument(doc)) {
      return parseCollection(text);
    }
    const d = doc as Record<string, unknown>;
    if (d.openapi || d.swagger) {
      return importOpenApi(text);
    }
  }
  throw new Error('資料格式不符：無法辨識為 Insomnia v5/v4、OpenAPI 3.x 或 Volley 匯出檔');
}
