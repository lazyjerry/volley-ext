// 資料夾解析與初始化：展開 ~/、建立子目錄結構、寫入格式版本標記。
// 純 Node，不 import vscode。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const FORMAT_VERSION = 1;

export interface DataFolderLayout {
  root: string;
  collectionsDir: string;
  stateDir: string;
  responsesDir: string;
  /** true = 使用者未設定 dataFolder，落在延伸模組專屬儲存空間 */
  isFallback: boolean;
}

export function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function resolveDataFolder(configValue: string, fallbackDir: string): DataFolderLayout {
  const trimmed = configValue.trim();
  const isFallback = trimmed === '';
  const root = isFallback ? fallbackDir : path.resolve(expandHome(trimmed));
  const collectionsDir = path.join(root, 'collections');
  const stateDir = path.join(root, 'state');
  const responsesDir = path.join(stateDir, 'responses');
  for (const dir of [root, collectionsDir, stateDir, responsesDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const markerPath = path.join(root, '.volley.json');
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(markerPath, JSON.stringify({ formatVersion: FORMAT_VERSION }, null, 2) + '\n');
  }
  return { root, collectionsDir, stateDir, responsesDir, isFallback };
}

/** Dropbox 衝突副本偵測（"xxx (使用者的 conflicted copy 2024-01-01).yaml" 等）。 */
export function findConflictedCopies(collectionsDir: string): string[] {
  try {
    return fs
      .readdirSync(collectionsDir)
      .filter((f) => /conflicted copy|衝突的複本/i.test(f));
  } catch {
    return [];
  }
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'collection';
}

export function collectionFileName(name: string, id: string): string {
  return `${slugify(name)}-${id.slice(-6)}.openapi.yaml`;
}
