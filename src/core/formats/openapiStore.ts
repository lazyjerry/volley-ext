// 原生保存格式：內部模型 ⇄ OpenAPI 3.1 YAML + x-volley 擴充欄位。
// 設計：paths 為主投影（每筆 request 只存一處），無法投影或 path+method 撞位者
// 整筆存頂層 x-volley.extraRequests。round-trip 不變式：parse(serialize(c)) 深度相等。

import * as YAML from 'yaml';
import type {
  Authentication,
  BodyParam,
  Collection,
  Folder,
  Header,
  PathParam,
  QueryParam,
  RequestBody,
  RequestItem,
  RequestSettings,
  Scripts,
  TreeNode,
} from '../model/types';
import { defaultSettings, isFolder, walkRequests } from '../model/types';
import { basePrefixCandidates, projectUrl } from './urlPath';
import { importOpenApi } from './openapiImport';

export const MAPPING_VERSION = 1;

interface RequestExtra {
  folderId: string | null;
  sortKey: number;
  url: string;
  parameters: QueryParam[];
  pathParameters: PathParam[];
  headers: Header[];
  body: RequestBody;
  authentication: Authentication;
  scripts?: Scripts;
  settings: RequestSettings;
}

interface ExtraRequestRecord extends RequestExtra {
  id: string;
  method: string;
  name: string;
  description?: string;
}

interface FlatFolder {
  id: string;
  parentId: string | null;
  name: string;
  description?: string;
  sortKey: number;
  environment?: Record<string, unknown>;
  headers?: Header[];
  authentication?: Authentication;
  scripts?: Scripts;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

function requestExtra(request: RequestItem, folderId: string | null): RequestExtra {
  return stripUndefined({
    folderId,
    sortKey: request.sortKey,
    url: request.url,
    parameters: request.parameters,
    pathParameters: request.pathParameters,
    headers: request.headers,
    body: request.body,
    authentication: request.authentication,
    scripts: request.scripts,
    settings: request.settings,
  }) as unknown as RequestExtra;
}

function flattenFolders(children: TreeNode[], parentId: string | null, out: FlatFolder[]): void {
  for (const node of children) {
    if (isFolder(node)) {
      out.push(
        stripUndefined({
          id: node.id,
          parentId,
          name: node.name,
          description: node.description,
          sortKey: node.sortKey,
          environment: node.environment,
          headers: node.headers,
          authentication: node.authentication,
          scripts: node.scripts,
        }) as unknown as FlatFolder,
      );
      flattenFolders(node.children, node.id, out);
    }
  }
}

/** 最佳努力投影 operation parameters（僅供外部 OpenAPI 工具閱讀，parse 時不使用）。 */
function projectedParameters(request: RequestItem, path: string): unknown[] {
  const params: unknown[] = [];
  const pathVars = [...path.matchAll(/\{([\w.-]+)\}/g)].map((m) => m[1]);
  for (const name of pathVars) {
    params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
  }
  for (const p of request.parameters) {
    if (!p.disabled) {
      params.push({ name: p.name, in: 'query', schema: { type: 'string' } });
    }
  }
  return params;
}

export function serializeCollection(collection: Collection): string {
  const candidates = basePrefixCandidates(collection);
  const paths: Record<string, Record<string, unknown>> = {};
  const extraRequests: ExtraRequestRecord[] = [];

  for (const { request, folderChain } of walkRequests(collection.children)) {
    const folderId = folderChain.length > 0 ? folderChain[folderChain.length - 1].id : null;
    const extra = requestExtra(request, folderId);
    const projection = projectUrl(request.url, request.method, candidates);
    const slotTaken =
      projection && paths[projection.path] && paths[projection.path][projection.method] !== undefined;
    if (projection && !slotTaken) {
      const op: Record<string, unknown> = stripUndefined({
        operationId: request.id,
        summary: request.name,
        description: request.description,
        'x-volley': extra,
      });
      const projected = projectedParameters(request, projection.path);
      if (projected.length > 0) {
        op.parameters = projected;
      }
      paths[projection.path] = paths[projection.path] ?? {};
      paths[projection.path][projection.method] = op;
    } else {
      extraRequests.push(
        stripUndefined({
          id: request.id,
          method: request.method,
          name: request.name,
          description: request.description,
          ...extra,
        }) as unknown as ExtraRequestRecord,
      );
    }
  }

  const folders: FlatFolder[] = [];
  flattenFolders(collection.children, null, folders);

  const doc: Record<string, unknown> = {
    openapi: '3.1.0',
    info: stripUndefined({
      title: collection.name,
      description: collection.description,
      version: '1.0.0',
      'x-volley': {
        id: collection.id,
        created: collection.created,
        modified: collection.modified,
        mappingVersion: MAPPING_VERSION,
      },
    }),
    ...(collection.servers.length > 0
      ? { servers: collection.servers.map((url) => ({ url })) }
      : {}),
    paths,
    'x-volley': {
      folders,
      environments: collection.environments,
      cookieJar: collection.cookieJar,
      extraRequests,
    },
  };
  return YAML.stringify(doc, { lineWidth: 0, aliasDuplicateObjects: false });
}

function toRequestItem(
  id: string,
  method: string,
  name: string,
  description: string | undefined,
  extra: RequestExtra,
): { request: RequestItem; folderId: string | null } {
  const request = stripUndefined({
    kind: 'request',
    id,
    name,
    description,
    sortKey: extra.sortKey ?? 0,
    method: method.toUpperCase(),
    url: extra.url ?? '',
    parameters: extra.parameters ?? [],
    pathParameters: extra.pathParameters ?? [],
    headers: extra.headers ?? [],
    body: extra.body ?? {},
    authentication: extra.authentication ?? {},
    scripts: extra.scripts,
    settings: extra.settings ?? defaultSettings(),
  }) as unknown as RequestItem;
  return { request, folderId: extra.folderId ?? null };
}

export function isNativeDocument(doc: unknown): boolean {
  const d = doc as { info?: Record<string, unknown> } | null;
  return Boolean(d && typeof d === 'object' && d.info && d.info['x-volley']);
}

export function parseCollection(text: string): Collection {
  const doc = YAML.parse(text) as Record<string, unknown>;
  if (!doc || typeof doc !== 'object') {
    throw new Error('無法解析檔案內容');
  }
  if (!isNativeDocument(doc)) {
    return importOpenApi(doc);
  }

  const info = doc.info as Record<string, unknown>;
  const meta = info['x-volley'] as Record<string, unknown>;
  const ext = (doc['x-volley'] ?? {}) as Record<string, unknown>;
  const flatFolders = (ext.folders ?? []) as FlatFolder[];
  const extraRequests = (ext.extraRequests ?? []) as ExtraRequestRecord[];

  const items: Array<{ node: TreeNode; folderId: string | null }> = [];

  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const opsByMethod of Object.values(paths)) {
    for (const [method, op] of Object.entries(opsByMethod)) {
      const operation = op as Record<string, unknown>;
      const extra = operation['x-volley'] as RequestExtra | undefined;
      if (!extra) {
        continue;
      }
      const { request, folderId } = toRequestItem(
        String(operation.operationId ?? ''),
        method,
        String(operation.summary ?? ''),
        operation.description !== undefined ? String(operation.description) : undefined,
        extra,
      );
      items.push({ node: request, folderId });
    }
  }
  for (const rec of extraRequests) {
    const { request, folderId } = toRequestItem(rec.id, rec.method, rec.name, rec.description, rec);
    items.push({ node: request, folderId });
  }

  const folderById = new Map<string, Folder>();
  for (const f of flatFolders) {
    folderById.set(
      f.id,
      stripUndefined({
        kind: 'folder',
        id: f.id,
        name: f.name,
        description: f.description,
        sortKey: f.sortKey ?? 0,
        environment: f.environment,
        headers: f.headers,
        authentication: f.authentication,
        scripts: f.scripts,
        children: [],
      }) as unknown as Folder,
    );
  }
  for (const f of flatFolders) {
    items.push({ node: folderById.get(f.id)!, folderId: f.parentId ?? null });
  }

  const root: TreeNode[] = [];
  for (const { node, folderId } of items) {
    if (folderId && folderById.has(folderId)) {
      folderById.get(folderId)!.children.push(node);
    } else {
      root.push(node);
    }
  }
  const sortTree = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => a.sortKey - b.sortKey);
    for (const n of nodes) {
      if (isFolder(n)) {
        sortTree(n.children);
      }
    }
  };
  sortTree(root);

  const environments = (ext.environments ?? {
    base: { name: 'Base Environment', data: {} },
    subEnvironments: [],
  }) as Collection['environments'];
  const cookieJar = (ext.cookieJar ?? {
    id: 'jar_00000000000000000000000000000000',
    name: 'Default Jar',
    cookies: [],
  }) as Collection['cookieJar'];

  return stripUndefined({
    id: String(meta.id ?? ''),
    name: String(info.title ?? ''),
    description: info.description !== undefined ? String(info.description) : undefined,
    created: Number(meta.created ?? Date.now()),
    modified: Number(meta.modified ?? Date.now()),
    servers: ((doc.servers ?? []) as Array<{ url: string }>).map((s) => s.url),
    children: root,
    environments,
    cookieJar,
  }) as unknown as Collection;
}

/** 匯出「乾淨」OpenAPI：去除所有 x-volley 欄位（extraRequests 不輸出）。 */
export function serializeCleanOpenApi(collection: Collection): string {
  const full = YAML.parse(serializeCollection(collection)) as Record<string, unknown>;
  delete full['x-volley'];
  const info = full.info as Record<string, unknown>;
  delete info['x-volley'];
  const paths = (full.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const ops of Object.values(paths)) {
    for (const op of Object.values(ops)) {
      delete (op as Record<string, unknown>)['x-volley'];
    }
  }
  return YAML.stringify(full, { lineWidth: 0, aliasDuplicateObjects: false });
}

export type { BodyParam };
