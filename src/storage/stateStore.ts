// UI 狀態與 response history 儲存。
// state/<wrk_id>.ui.json：activeEnv、selectedRequest、expandedFolders、layout。
// state/responses/<wrk_id>/<req_id>.json：ResponseRecord[]，新在前、上限輪替。

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResponseRecord, UiState } from '../core/model/types';
import { emptyUiState } from '../core/model/types';
import { isSafeIdSegment } from '../core/model/ids';

const STATE_DEBOUNCE_MS = 300;

export class StateStore {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingState = new Map<string, UiState>();

  constructor(
    private readonly stateDir: string,
    private readonly responsesDir: string,
  ) {}

  // id 來自匯入檔與 webview 訊息，不可信：不是安全片段或解析後跑出基底目錄就回 undefined，呼叫端一律不做事
  private static inside(baseDir: string, ...segments: string[]): string | undefined {
    const base = path.resolve(baseDir);
    const target = path.resolve(base, ...segments);
    return target.startsWith(base + path.sep) ? target : undefined;
  }

  private uiStatePath(collectionId: string): string | undefined {
    if (!isSafeIdSegment(collectionId)) {
      return undefined;
    }
    return StateStore.inside(this.stateDir, `${collectionId}.ui.json`);
  }

  private collectionResponsesDir(collectionId: string): string | undefined {
    if (!isSafeIdSegment(collectionId)) {
      return undefined;
    }
    return StateStore.inside(this.responsesDir, collectionId);
  }

  private responsePath(collectionId: string, requestId: string): string | undefined {
    if (!isSafeIdSegment(collectionId) || !isSafeIdSegment(requestId)) {
      return undefined;
    }
    return StateStore.inside(this.responsesDir, collectionId, `${requestId}.json`);
  }

  loadUiState(collectionId: string): UiState {
    const filePath = this.uiStatePath(collectionId);
    if (!filePath) {
      return emptyUiState();
    }
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      return { ...emptyUiState(), ...(JSON.parse(text) as UiState) };
    } catch {
      return emptyUiState();
    }
  }

  saveUiState(collectionId: string, state: UiState): void {
    if (!this.uiStatePath(collectionId)) {
      return;
    }
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
        const filePath = this.uiStatePath(collectionId);
        if (toWrite && filePath) {
          this.atomicWrite(filePath, JSON.stringify(toWrite, null, 2));
        }
      }, STATE_DEBOUNCE_MS),
    );
  }

  loadHistory(collectionId: string, requestId: string): ResponseRecord[] {
    const filePath = this.responsePath(collectionId, requestId);
    if (!filePath) {
      return [];
    }
    try {
      const text = fs.readFileSync(filePath, 'utf8');
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
    if (!filePath) {
      return trimmed;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.atomicWrite(filePath, JSON.stringify(trimmed));
    return trimmed;
  }

  clearHistory(collectionId: string, requestId: string): void {
    const filePath = this.responsePath(collectionId, requestId);
    if (!filePath) {
      return;
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      // 不存在即視為已清除
    }
  }

  deleteCollectionState(collectionId: string): void {
    const uiPath = this.uiStatePath(collectionId);
    const responsesDir = this.collectionResponsesDir(collectionId);
    // 空 id 若放行，responsesDir 本身會被遞迴刪除（所有 collection 的歷史）
    if (!uiPath || !responsesDir) {
      return;
    }
    try {
      fs.unlinkSync(uiPath);
    } catch {
      // ignore
    }
    try {
      fs.rmSync(responsesDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  flush(): void {
    for (const [collectionId, timer] of this.timers) {
      clearTimeout(timer);
      const toWrite = this.pendingState.get(collectionId);
      const filePath = this.uiStatePath(collectionId);
      if (toWrite && filePath) {
        this.atomicWrite(filePath, JSON.stringify(toWrite, null, 2));
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
