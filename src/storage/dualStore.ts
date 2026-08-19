// 共用／私人雙資料夾的路由層：對外提供與單一 store 相同的操作介面，
// 依 collection id 分流到所屬 store。兩個根目錄嚴格隔離，絕不合併讀寫。
// 純 Node，不 import vscode。

import type { Collection, CollectionSource, CollectionSummary, ResponseRecord, UiState } from '../core/model/types';
import type { CollectionStore, Disposable } from './collectionStore';
import type { StateStore } from './stateStore';

export class DualCollectionStore {
  // 刪除後仍保留最後已知來源，讓 state 清理等後續操作能正確分流
  private readonly lastKnownSource = new Map<string, CollectionSource>();

  constructor(
    private readonly shared: CollectionStore,
    private readonly priv: CollectionStore,
  ) {}

  private storeFor(source: CollectionSource): CollectionStore {
    return source === 'private' ? this.priv : this.shared;
  }

  loadAll(): void {
    this.shared.loadAll();
    this.priv.loadAll();
    this.rememberAll();
  }

  checkDisk(): void {
    this.shared.checkDisk();
    this.priv.checkDisk();
  }

  private rememberAll(): void {
    for (const s of this.shared.list()) {
      this.lastKnownSource.set(s.id, 'shared');
    }
    for (const s of this.priv.list()) {
      this.lastKnownSource.set(s.id, 'private');
    }
  }

  list(): CollectionSummary[] {
    this.rememberAll();
    return [
      ...this.shared.list().map((s) => ({ ...s, source: 'shared' as const })),
      ...this.priv.list().map((s) => ({ ...s, source: 'private' as const })),
    ];
  }

  get(id: string): Collection | undefined {
    return this.shared.get(id) ?? this.priv.get(id);
  }

  sourceOf(id: string): CollectionSource | undefined {
    if (this.shared.get(id)) {
      return 'shared';
    }
    if (this.priv.get(id)) {
      return 'private';
    }
    return this.lastKnownSource.get(id);
  }

  create(collection: Collection, source: CollectionSource): void {
    this.lastKnownSource.set(collection.id, source);
    this.storeFor(source).create(collection);
  }

  /** 依現有歸屬分流；不明 id 沿用最後已知來源重建（保留原 store 的防資料遺失行為）。 */
  update(collection: Collection): void {
    const source = this.sourceOf(collection.id) ?? 'shared';
    this.lastKnownSource.set(collection.id, source);
    this.storeFor(source).update(collection);
  }

  delete(id: string): void {
    const source = this.sourceOf(id);
    if (source) {
      this.storeFor(source).delete(id);
    }
  }

  onExternalChange(listener: (collection: Collection) => void): Disposable {
    return combine(this.shared.onExternalChange(listener), this.priv.onExternalChange(listener));
  }

  onListChange(listener: () => void): Disposable {
    return combine(this.shared.onListChange(listener), this.priv.onListChange(listener));
  }

  onError(listener: (message: string) => void): Disposable {
    return combine(this.shared.onError(listener), this.priv.onError(listener));
  }

  async flush(): Promise<void> {
    await Promise.all([this.shared.flush(), this.priv.flush()]);
  }

  dispose(): void {
    this.shared.dispose();
    this.priv.dispose();
  }
}

export class DualStateStore {
  constructor(
    private readonly shared: StateStore,
    private readonly priv: StateStore,
    private readonly sourceOf: (collectionId: string) => CollectionSource | undefined,
  ) {}

  private storeFor(collectionId: string): StateStore {
    return this.sourceOf(collectionId) === 'private' ? this.priv : this.shared;
  }

  loadUiState(collectionId: string): UiState {
    return this.storeFor(collectionId).loadUiState(collectionId);
  }

  saveUiState(collectionId: string, state: UiState): void {
    this.storeFor(collectionId).saveUiState(collectionId, state);
  }

  loadHistory(collectionId: string, requestId: string): ResponseRecord[] {
    return this.storeFor(collectionId).loadHistory(collectionId, requestId);
  }

  appendResponse(collectionId: string, record: ResponseRecord, limit: number): ResponseRecord[] {
    return this.storeFor(collectionId).appendResponse(collectionId, record, limit);
  }

  clearHistory(collectionId: string, requestId: string): void {
    this.storeFor(collectionId).clearHistory(collectionId, requestId);
  }

  deleteCollectionState(collectionId: string): void {
    this.storeFor(collectionId).deleteCollectionState(collectionId);
  }

  flush(): void {
    this.shared.flush();
    this.priv.flush();
  }
}

function combine(...disposables: Disposable[]): Disposable {
  return {
    dispose: () => {
      for (const d of disposables) {
        d.dispose();
      }
    },
  };
}
