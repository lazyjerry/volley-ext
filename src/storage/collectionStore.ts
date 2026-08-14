// Collection 檔案儲存：每 collection 一檔（OpenAPI YAML）。
// debounce 寫入 → 序列化寫入佇列 → tmp+rename 原子寫 → 自寫守衛；
// fs.watchFile 輪詢偵測外部變更（Dropbox 回寫）與目錄增刪。

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Collection, CollectionSummary } from '../core/model/types';
import { parseCollection, serializeCollection } from '../core/formats/openapiStore';
import { collectionFileName } from './dataFolder';

const WRITE_DEBOUNCE_MS = 500;
const WATCH_INTERVAL_MS = 500;

export interface Disposable {
  dispose(): void;
}

interface Entry {
  collection: Collection;
  filePath: string;
  pending?: Collection;
  timer?: ReturnType<typeof setTimeout>;
  writeInProgress: boolean;
  lastWrittenMtimeMs: number;
}

export class CollectionStore implements Disposable {
  private readonly entries = new Map<string, Entry>();
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly externalChangeListeners = new Set<(collection: Collection) => void>();
  private readonly listChangeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(message: string) => void>();
  private dirWatcherActive = false;

  constructor(private readonly collectionsDir: string) {}

  onExternalChange(listener: (collection: Collection) => void): Disposable {
    this.externalChangeListeners.add(listener);
    return { dispose: () => this.externalChangeListeners.delete(listener) };
  }

  onListChange(listener: () => void): Disposable {
    this.listChangeListeners.add(listener);
    return { dispose: () => this.listChangeListeners.delete(listener) };
  }

  onError(listener: (message: string) => void): Disposable {
    this.errorListeners.add(listener);
    return { dispose: () => this.errorListeners.delete(listener) };
  }

  private emitError(message: string): void {
    for (const l of this.errorListeners) {
      l(message);
    }
  }

  /** 掃描資料夾載入全部 collections（啟動與 reload 用）。 */
  loadAll(): Collection[] {
    for (const entry of this.entries.values()) {
      fs.unwatchFile(entry.filePath);
    }
    this.entries.clear();
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.collectionsDir).filter((f) => /\.ya?ml$/i.test(f));
    } catch {
      files = [];
    }
    const out: Collection[] = [];
    for (const file of files) {
      const filePath = path.join(this.collectionsDir, file);
      try {
        const text = fs.readFileSync(filePath, 'utf8');
        const collection = parseCollection(text);
        this.track(collection, filePath);
        out.push(collection);
      } catch (err) {
        this.emitError(`無法讀取 ${file}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.watchDir();
    return out;
  }

  list(): CollectionSummary[] {
    return [...this.entries.values()].map((e) => ({
      id: e.collection.id,
      name: e.collection.name,
      fileName: path.basename(e.filePath),
    }));
  }

  get(id: string): Collection | undefined {
    return this.entries.get(id)?.collection;
  }

  /** 建立新 collection 並立即落檔。 */
  create(collection: Collection): void {
    const filePath = path.join(this.collectionsDir, collectionFileName(collection.name, collection.id));
    this.track(collection, filePath);
    this.enqueueWrite(this.entries.get(collection.id)!, collection);
    this.emitListChange();
  }

  /** 更新（debounce 落檔）。 */
  update(collection: Collection): void {
    const entry = this.entries.get(collection.id);
    if (!entry) {
      this.create(collection);
      return;
    }
    const nameChanged = entry.collection.name !== collection.name;
    entry.collection = collection;
    entry.pending = collection;
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      const toWrite = entry.pending;
      entry.pending = undefined;
      if (toWrite) {
        this.enqueueWrite(entry, toWrite);
      }
    }, WRITE_DEBOUNCE_MS);
    if (nameChanged) {
      this.emitListChange();
    }
  }

  delete(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    fs.unwatchFile(entry.filePath);
    this.entries.delete(id);
    this.writeQueue = this.writeQueue.then(() => {
      try {
        fs.unlinkSync(entry.filePath);
      } catch {
        // 已被外部刪除
      }
    });
    this.emitListChange();
  }

  /** 確保所有 pending 寫入完成（deactivate 用）。 */
  async flush(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      const toWrite = entry.pending;
      entry.pending = undefined;
      if (toWrite) {
        this.enqueueWrite(entry, toWrite);
      }
    }
    await this.writeQueue;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      fs.unwatchFile(entry.filePath);
    }
    if (this.dirWatcherActive) {
      fs.unwatchFile(this.collectionsDir);
      this.dirWatcherActive = false;
    }
  }

  private emitListChange(): void {
    for (const l of this.listChangeListeners) {
      l();
    }
  }

  private track(collection: Collection, filePath: string): void {
    const entry: Entry = {
      collection,
      filePath,
      writeInProgress: false,
      lastWrittenMtimeMs: this.statMtime(filePath),
    };
    this.entries.set(collection.id, entry);
    fs.watchFile(filePath, { interval: WATCH_INTERVAL_MS }, () => this.handleFileChange(entry));
  }

  private statMtime(filePath: string): number {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private handleFileChange(entry: Entry): void {
    // 自寫守衛：pending 或寫入中時忽略（rename 後 mtime 由 enqueueWrite 記錄）
    if (entry.writeInProgress || entry.pending || entry.timer) {
      return;
    }
    const mtime = this.statMtime(entry.filePath);
    if (mtime === 0 || Math.abs(mtime - entry.lastWrittenMtimeMs) < 1) {
      return;
    }
    entry.lastWrittenMtimeMs = mtime;
    try {
      const text = fs.readFileSync(entry.filePath, 'utf8');
      const collection = parseCollection(text);
      entry.collection = collection;
      for (const l of this.externalChangeListeners) {
        l(collection);
      }
    } catch (err) {
      this.emitError(
        `外部變更解析失敗（${path.basename(entry.filePath)}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private watchDir(): void {
    if (this.dirWatcherActive) {
      return;
    }
    this.dirWatcherActive = true;
    // 目錄 mtime 變化（新增/刪除檔案）→ 通知外層 reload
    fs.watchFile(this.collectionsDir, { interval: 2000 }, () => {
      const known = new Set([...this.entries.values()].map((e) => path.basename(e.filePath)));
      let files: string[] = [];
      try {
        files = fs.readdirSync(this.collectionsDir).filter((f) => /\.ya?ml$/i.test(f));
      } catch {
        return;
      }
      const added = files.some((f) => !known.has(f));
      const removed = [...known].some((f) => !files.includes(f));
      if (added || removed) {
        this.emitListChange();
      }
    });
  }

  private enqueueWrite(entry: Entry, collection: Collection): void {
    entry.writeInProgress = true;
    this.writeQueue = this.writeQueue
      .then(async () => {
        const text = serializeCollection(collection);
        const tmpPath = `${entry.filePath}.tmp`;
        await fs.promises.writeFile(tmpPath, text, 'utf8');
        await fs.promises.rename(tmpPath, entry.filePath);
        entry.lastWrittenMtimeMs = this.statMtime(entry.filePath);
      })
      .catch((err: unknown) => {
        this.emitError(
          `寫入失敗（${path.basename(entry.filePath)}）：${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        entry.writeInProgress = false;
      });
  }
}
