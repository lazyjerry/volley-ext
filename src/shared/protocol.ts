// extension ⇄ webview 訊息協定（tagged union，兩端共用型別）。
// 編輯採粗粒度 updateCollection 全量回傳（webview 端 debounce）。

import type {
  Collection,
  CollectionSource,
  CollectionSummary,
  RequestItem,
  ResponseRecord,
  UiState,
} from '../core/model/types';

export interface DataFolderInfo {
  path: string;
  /** true = 未設定，落在延伸模組專屬儲存空間 */
  isFallback: boolean;
}

export interface ClientConfig {
  dataFolders: Record<CollectionSource, DataFolderInfo>;
  requestTimeoutMs: number;
  responseHistoryLimit: number;
}

// Extension → Webview
export type HostMessage =
  | {
      type: 'init';
      collections: CollectionSummary[];
      activeCollection: Collection | null;
      uiState: UiState | null;
      config: ClientConfig;
      conflictedCopies: string[];
    }
  | { type: 'collectionLoaded'; collection: Collection; uiState: UiState }
  | { type: 'collectionChangedOnDisk'; collection: Collection }
  | { type: 'collectionListChanged'; collections: CollectionSummary[] }
  | { type: 'responseStarted'; requestId: string }
  | {
      type: 'responseFinished';
      requestId: string;
      record: ResponseRecord;
      fullBody: string;
      history: ResponseRecord[];
      cookieJar: Collection['cookieJar'];
    }
  | { type: 'historyLoaded'; requestId: string; records: ResponseRecord[] }
  | { type: 'requestInserted'; request: RequestItem; folderId: string | null }
  | { type: 'curlExported'; requestId: string; text: string }
  | { type: 'folderDeleteConfirmed'; folderId: string; mode: 'all' | 'folderOnly' }
  | { type: 'envVarDeleteConfirmed'; key: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string };

// Webview → Extension
export type ClientMessage =
  | { type: 'ready' }
  | { type: 'selectCollection'; collectionId: string }
  | { type: 'createCollection'; name: string; source: CollectionSource }
  | { type: 'openDataFolder'; source: CollectionSource }
  | { type: 'chooseDataFolder'; source: CollectionSource }
  | { type: 'renameCollection'; collectionId: string }
  | { type: 'deleteCollection'; collectionId: string }
  | { type: 'confirmDeleteFolder'; folderId: string; name: string; requestCount: number; folderCount: number }
  | { type: 'confirmDeleteEnvVar'; key: string }
  | { type: 'showNotice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'updateCollection'; collection: Collection }
  | { type: 'sendRequest'; collectionId: string; requestId: string }
  | { type: 'cancelRequest'; requestId: string }
  | { type: 'loadHistory'; collectionId: string; requestId: string }
  | { type: 'clearHistory'; collectionId: string; requestId: string }
  | { type: 'updateUiState'; collectionId: string; state: UiState }
  | { type: 'importCurlText'; collectionId: string; folderId: string | null; text: string }
  | { type: 'exportCurl'; collectionId: string; requestId: string; copyToClipboard: boolean }
  | {
      type: 'runCommand';
      command:
        | 'importInsomnia'
        | 'importOpenApi'
        | 'importCurl'
        | 'importFromUrl'
        | 'exportInsomniaYaml'
        | 'exportOpenApi'
        | 'newCollection'
        | 'reload';
    };

export function isClientMessage(value: unknown): value is ClientMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

export function isHostMessage(value: unknown): value is HostMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}
