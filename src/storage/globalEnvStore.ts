// 共用環境儲存：每個資料根一檔 <root>/global-environment.json（{ data, descriptions }）。
// 寫入一律 tmp + rename；不輪詢，由 checkDisk() 在面板變可見或手動重新載入時比對 mtime。
// 純 Node，不 import vscode。

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GlobalEnvironment } from '../core/model/types';
import { emptyGlobalEnvironment } from '../core/model/types';

export const GLOBAL_ENV_FILE = 'global-environment.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 檔案內容不可信（手改、同步半寫入）：形狀不對的部分丟掉，不拋例外。 */
export function normalizeGlobalEnvironment(value: unknown): GlobalEnvironment {
  if (!isRecord(value) || !isRecord(value.data)) {
    return emptyGlobalEnvironment();
  }
  const data = value.data;
  const env: GlobalEnvironment = { data };
  if (isRecord(value.descriptions)) {
    const descriptions = Object.fromEntries(
      Object.entries(value.descriptions).filter(
        ([k, v]) => typeof v === 'string' && v !== '' && k in data,
      ),
    ) as Record<string, string>;
    if (Object.keys(descriptions).length > 0) {
      env.descriptions = descriptions;
    }
  }
  return env;
}

export class GlobalEnvStore {
  private readonly filePath: string;
  private env: GlobalEnvironment = emptyGlobalEnvironment();
  private lastMtimeMs = 0;

  constructor(root: string) {
    this.filePath = path.join(root, GLOBAL_ENV_FILE);
    this.load();
  }

  get(): GlobalEnvironment {
    return this.env;
  }

  load(): void {
    try {
      const text = fs.readFileSync(this.filePath, 'utf8');
      this.env = normalizeGlobalEnvironment(JSON.parse(text));
      this.lastMtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch {
      // 檔案不存在或 JSON 壞掉：視為空的共用環境，下次儲存時覆寫
      this.env = emptyGlobalEnvironment();
      this.lastMtimeMs = 0;
    }
  }

  save(env: GlobalEnvironment): void {
    this.env = normalizeGlobalEnvironment(env);
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.env, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, this.filePath);
    this.lastMtimeMs = fs.statSync(this.filePath).mtimeMs;
  }

  /** 磁碟上的檔案與上次讀寫時不同（外部或其他裝置同步）→ 重新載入並回傳 true。 */
  checkDisk(): boolean {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    if (mtimeMs === this.lastMtimeMs) {
      return false;
    }
    this.load();
    return true;
  }
}
