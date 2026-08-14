// UI 狀態與 response history 儲存。
// state/<wrk_id>.ui.json：activeEnv、selectedRequest、expandedFolders、layout。
// state/responses/<wrk_id>/<req_id>.json：ResponseRecord[]，新在前、上限輪替。

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResponseRecord, UiState } from '../core/model/types';
import { emptyUiState } from '../core/model/types';

const STATE_DEBOUNCE_MS = 300;

export class StateStore {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingState = new Map<string, UiState>();

  constructor(
    private readonly stateDir: string,
    private readonly responsesDir: string,
  ) {}

  private uiStatePath(collectionId: string): string {
    return path.join(this.stateDir, `${collectionId}.ui.json`);
  }

  private responsePath(collectionId: string, requestId: string): string {
    return path.join(this.responsesDir, collectionId, `${requestId}.json`);
  }

  loadUiState(collectionId: string): UiState {
    try {
      const text = fs.readFileSync(this.uiStatePath(collectionId), 'utf8');
      return { ...emptyUiState(), ...(JSON.parse(text) as UiState) };
    } catch {
      return emptyUiState();
    }
  }

  saveUiState(collectionId: string, state: UiState): void {
    this.pendingState.set(collectionId, state);
    const existing = this.timers.get(collectionId);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(
      collectionId,
      setTimeout(() => {
        this.timers.delete(collectionId);
        const toWrite = this.pendingState.get(collectionId);
        this.pendingState.delete(collectionId);
        if (toWrite) {
          this.atomicWrite(this.uiStatePath(collectionId), JSON.stringify(toWrite, null, 2));
        }
      }, STATE_DEBOUNCE_MS),
    );
  }

  loadHistory(collectionId: string, requestId: string): ResponseRecord[] {
    try {
      const text = fs.readFileSync(this.responsePath(collectionId, requestId), 'utf8');
      const parsed = JSON.parse(text) as ResponseRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  appendResponse(collectionId: string, record: ResponseRecord, limit: number): ResponseRecord[] {
    const history = this.loadHistory(collectionId, record.requestId);
    history.unshift(record);
    const trimmed = history.slice(0, Math.max(1, limit));
    const filePath = this.responsePath(collectionId, record.requestId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.atomicWrite(filePath, JSON.stringify(trimmed));
    return trimmed;
  }

  clearHistory(collectionId: string, requestId: string): void {
    try {
      fs.unlinkSync(this.responsePath(collectionId, requestId));
    } catch {
      // 不存在即視為已清除
    }
  }

  deleteCollectionState(collectionId: string): void {
    try {
      fs.unlinkSync(this.uiStatePath(collectionId));
    } catch {
      // ignore
    }
    try {
      fs.rmSync(path.join(this.responsesDir, collectionId), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  flush(): void {
    for (const [collectionId, timer] of this.timers) {
      clearTimeout(timer);
      const toWrite = this.pendingState.get(collectionId);
      if (toWrite) {
        this.atomicWrite(this.uiStatePath(collectionId), JSON.stringify(toWrite, null, 2));
      }
    }
    this.timers.clear();
    this.pendingState.clear();
  }

  private atomicWrite(filePath: string, content: string): void {
    try {
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch {
      // state 寫入失敗不阻斷主流程
    }
  }
}
