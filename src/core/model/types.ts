// 內部資料模型：以 Insomnia v5 的巢狀 children 樹為形，
// 作為 OpenAPI 保存格式與各匯入匯出格式之間的樞紐。

export interface Header {
  name: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface QueryParam {
  name: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface PathParam {
  name: string;
  value: string;
}

export interface BodyParam {
  name: string;
  value: string;
  description?: string;
  disabled?: boolean;
  type?: string;
  fileName?: string;
  multiline?: string | boolean;
}

export interface RequestBody {
  mimeType?: string | null;
  text?: string;
  fileName?: string;
  params?: BodyParam[];
}

// discriminated union by `type`；未支援的類型原樣保存，round-trip 不遺失
export interface Authentication {
  type?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface Scripts {
  preRequest?: string;
  afterResponse?: string;
}

export interface CookieSettings {
  send: boolean;
  store: boolean;
}

export interface RequestSettings {
  renderRequestBody: boolean;
  encodeUrl: boolean;
  followRedirects: 'global' | 'on' | 'off';
  cookies: CookieSettings;
  rebuildPath: boolean;
}

export function defaultSettings(): RequestSettings {
  return {
    renderRequestBody: true,
    encodeUrl: true,
    followRedirects: 'global',
    cookies: { send: true, store: true },
    rebuildPath: true,
  };
}

export interface RequestItem {
  kind: 'request';
  id: string; // req_...
  name: string;
  description?: string;
  sortKey: number;
  method: string;
  url: string; // 原始未插值字串，可含 {{ _.x }}
  parameters: QueryParam[];
  pathParameters: PathParam[];
  headers: Header[];
  body: RequestBody;
  authentication: Authentication;
  scripts?: Scripts;
  settings: RequestSettings;
}

export interface Folder {
  kind: 'folder';
  id: string; // fld_...
  name: string;
  description?: string;
  sortKey: number;
  environment?: Record<string, unknown>;
  headers?: Header[];
  authentication?: Authentication;
  scripts?: Scripts;
  children: TreeNode[];
}

export type TreeNode = Folder | RequestItem;

export interface EnvironmentData {
  id?: string; // env_...（base 可省略，匯出時補）
  name: string;
  color?: string | null;
  data: Record<string, unknown>;
}

export interface SubEnvironment extends EnvironmentData {
  id: string;
  isPrivate?: boolean;
}

export interface EnvironmentSet {
  base: EnvironmentData;
  subEnvironments: SubEnvironment[];
}

export interface CookieRecord {
  id: string;
  key: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  hostOnly?: boolean;
  expires?: string | null;
  [key: string]: unknown;
}

export interface CookieJar {
  id: string; // jar_...
  name: string;
  cookies: CookieRecord[];
}

export interface Collection {
  id: string; // wrk_...
  name: string;
  description?: string;
  created: number;
  modified: number;
  servers: string[];
  children: TreeNode[];
  environments: EnvironmentSet;
  cookieJar: CookieJar;
}

export interface ResponseRecord {
  id: string;
  requestId: string;
  at: number;
  durationMs: number;
  method: string;
  url: string; // 插值後實際送出的 URL
  status: number;
  statusText: string;
  requestHeaders: Header[];
  responseHeaders: Header[];
  contentType?: string;
  bodyEncoding: 'utf8' | 'base64';
  body: string;
  bodySize: number;
  bodyTruncated: boolean;
  redirectChain?: string[];
  warnings?: string[];
  error?: string;
}

export interface CollectionSummary {
  id: string;
  name: string;
  fileName: string;
}

export interface UiState {
  activeEnvironmentId: string | null; // null = Base Environment
  selectedRequestId: string | null;
  expandedFolders: string[];
  layout?: { sidebarPct?: number; requestPct?: number };
  activeResponseIds?: Record<string, string>;
}

export function emptyUiState(): UiState {
  return { activeEnvironmentId: null, selectedRequestId: null, expandedFolders: [] };
}

export function isFolder(node: TreeNode): node is Folder {
  return node.kind === 'folder';
}

export function isRequest(node: TreeNode): node is RequestItem {
  return node.kind === 'request';
}

/** 走訪整棵樹，回傳每個 request 及其資料夾鏈（由外而內）。 */
export function walkRequests(
  children: TreeNode[],
  chain: Folder[] = [],
): Array<{ request: RequestItem; folderChain: Folder[] }> {
  const out: Array<{ request: RequestItem; folderChain: Folder[] }> = [];
  for (const node of children) {
    if (isFolder(node)) {
      out.push(...walkRequests(node.children, [...chain, node]));
    } else {
      out.push({ request: node, folderChain: chain });
    }
  }
  return out;
}

export function findRequest(children: TreeNode[], id: string): RequestItem | undefined {
  return walkRequests(children).find((r) => r.request.id === id)?.request;
}

export function findFolderChain(children: TreeNode[], requestId: string): Folder[] {
  return walkRequests(children).find((r) => r.request.id === requestId)?.folderChain ?? [];
}
