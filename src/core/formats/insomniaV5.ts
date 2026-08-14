// Insomnia Export Format v5（insomnia.yaml）匯出與匯入。
// 頂層 type: collection.insomnia.rest/5.0；資料夾用巢狀 children[]；
// 辨識規則：有 children → folder、有 method → request。

import * as YAML from 'yaml';
import type {
  Authentication,
  Collection,
  EnvironmentSet,
  Folder,
  RequestItem,
  RequestSettings,
  Scripts,
  TreeNode,
} from '../model/types';
import { defaultSettings, isFolder } from '../model/types';
import { genId } from '../model/ids';

export const V5_COLLECTION_TYPE = 'collection.insomnia.rest/5.0';
export const V5_SCHEMA_VERSION = '5.1';

interface V5Meta {
  id: string;
  created?: number;
  modified?: number;
  isPrivate?: boolean;
  description?: string;
  sortKey?: number;
}

function strip<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

function nodeToV5(node: TreeNode, now: number): Record<string, unknown> {
  if (isFolder(node)) {
    return strip({
      name: node.name,
      meta: strip({
        id: node.id,
        created: now,
        modified: now,
        sortKey: node.sortKey,
        description: node.description ?? '',
      }),
      children: node.children.map((c) => nodeToV5(c, now)),
      environment: node.environment,
      headers: node.headers,
      authentication: node.authentication,
      scripts: node.scripts
        ? strip({ preRequest: node.scripts.preRequest, afterResponse: node.scripts.afterResponse })
        : undefined,
    });
  }
  const request = node;
  return strip({
    url: request.url,
    name: request.name,
    meta: strip({
      id: request.id,
      created: now,
      modified: now,
      isPrivate: false,
      description: request.description ?? '',
      sortKey: request.sortKey,
    }),
    method: request.method,
    body:
      request.body && (request.body.mimeType !== undefined || request.body.text !== undefined || request.body.params !== undefined || request.body.fileName !== undefined)
        ? request.body
        : undefined,
    parameters: request.parameters,
    pathParameters: request.pathParameters.length > 0 ? request.pathParameters : undefined,
    headers: request.headers,
    authentication: request.authentication,
    scripts: request.scripts
      ? strip({ preRequest: request.scripts.preRequest, afterResponse: request.scripts.afterResponse })
      : undefined,
    settings: {
      renderRequestBody: request.settings.renderRequestBody,
      encodeUrl: request.settings.encodeUrl,
      followRedirects: request.settings.followRedirects,
      cookies: { send: request.settings.cookies.send, store: request.settings.cookies.store },
      rebuildPath: request.settings.rebuildPath,
    },
  });
}

function environmentsToV5(environments: EnvironmentSet, now: number): Record<string, unknown> {
  return strip({
    name: environments.base.name,
    meta: strip({
      id: environments.base.id ?? genId('env'),
      created: now,
      modified: now,
      isPrivate: false,
    }),
    color: environments.base.color ?? null,
    data: environments.base.data,
    subEnvironments: environments.subEnvironments.map((sub) =>
      strip({
        name: sub.name,
        meta: strip({ id: sub.id, created: now, modified: now, isPrivate: sub.isPrivate ?? false }),
        color: sub.color ?? null,
        data: sub.data,
      }),
    ),
  });
}

export function exportInsomniaV5(collection: Collection): string {
  const now = collection.modified;
  const doc = {
    type: V5_COLLECTION_TYPE,
    schema_version: V5_SCHEMA_VERSION,
    name: collection.name,
    meta: strip({
      id: collection.id,
      created: collection.created,
      modified: collection.modified,
      description: collection.description ?? '',
    }),
    collection: collection.children.map((n) => nodeToV5(n, now)),
    cookieJar: strip({
      name: collection.cookieJar.name,
      meta: { id: collection.cookieJar.id, created: now, modified: now },
      cookies: collection.cookieJar.cookies,
    }),
    environments: environmentsToV5(collection.environments, now),
  };
  return YAML.stringify(doc, { lineWidth: 0, aliasDuplicateObjects: false });
}

// ---------- 匯入 ----------

function metaOf(raw: Record<string, unknown>): V5Meta {
  const meta = (raw.meta ?? {}) as Record<string, unknown>;
  return {
    id: String(meta.id ?? ''),
    created: meta.created as number | undefined,
    modified: meta.modified as number | undefined,
    isPrivate: meta.isPrivate as boolean | undefined,
    description: meta.description as string | undefined,
    sortKey: meta.sortKey as number | undefined,
  };
}

function settingsFromV5(raw: unknown): RequestSettings {
  const s = (raw ?? {}) as Record<string, unknown>;
  const cookies = (s.cookies ?? {}) as Record<string, unknown>;
  const d = defaultSettings();
  return {
    renderRequestBody: (s.renderRequestBody as boolean | undefined) ?? d.renderRequestBody,
    encodeUrl: (s.encodeUrl as boolean | undefined) ?? d.encodeUrl,
    followRedirects: (s.followRedirects as RequestSettings['followRedirects'] | undefined) ?? d.followRedirects,
    cookies: {
      send: (cookies.send as boolean | undefined) ?? d.cookies.send,
      store: (cookies.store as boolean | undefined) ?? d.cookies.store,
    },
    rebuildPath: (s.rebuildPath as boolean | undefined) ?? d.rebuildPath,
  };
}

function v5ToNode(raw: Record<string, unknown>, fallbackSort: number): TreeNode | null {
  const meta = metaOf(raw);
  if (Array.isArray(raw.children) || (raw.method === undefined && raw.url === undefined)) {
    // 資料夾
    const children: TreeNode[] = [];
    const rawChildren = (raw.children ?? []) as Array<Record<string, unknown>>;
    rawChildren.forEach((c, i) => {
      const node = v5ToNode(c, i);
      if (node) {
        children.push(node);
      }
    });
    const folder: Folder = {
      kind: 'folder',
      id: meta.id || genId('fld'),
      name: String(raw.name ?? ''),
      sortKey: meta.sortKey ?? fallbackSort,
      children,
    };
    if (meta.description) {
      folder.description = meta.description;
    }
    if (raw.environment && typeof raw.environment === 'object') {
      folder.environment = raw.environment as Record<string, unknown>;
    }
    if (Array.isArray(raw.headers) && raw.headers.length > 0) {
      folder.headers = raw.headers as Folder['headers'];
    }
    if (raw.authentication && Object.keys(raw.authentication as object).length > 0) {
      folder.authentication = raw.authentication as Authentication;
    }
    if (raw.scripts && Object.keys(raw.scripts as object).length > 0) {
      folder.scripts = raw.scripts as Scripts;
    }
    return folder;
  }
  if (raw.method === undefined) {
    return null; // gRPC/WebSocket 等目前不支援的類型：跳過
  }
  const id = meta.id || genId('req');
  if (id.startsWith('ws-req') || id.startsWith('socketio-req')) {
    return null;
  }
  const request: RequestItem = {
    kind: 'request',
    id,
    name: String(raw.name ?? ''),
    sortKey: meta.sortKey ?? fallbackSort,
    method: String(raw.method ?? 'GET').toUpperCase(),
    url: String(raw.url ?? ''),
    parameters: (raw.parameters ?? []) as RequestItem['parameters'],
    pathParameters: (raw.pathParameters ?? []) as RequestItem['pathParameters'],
    headers: (raw.headers ?? []) as RequestItem['headers'],
    body: (raw.body ?? {}) as RequestItem['body'],
    authentication: (raw.authentication ?? {}) as Authentication,
    settings: settingsFromV5(raw.settings),
  };
  if (meta.description) {
    request.description = meta.description;
  }
  if (raw.scripts && Object.keys(raw.scripts as object).length > 0) {
    request.scripts = raw.scripts as Scripts;
  }
  return request;
}

export function isInsomniaV5(doc: unknown): boolean {
  const d = doc as { type?: string } | null;
  return Boolean(d && typeof d === 'object' && typeof d.type === 'string' && d.type.includes('insomnia'));
}

export function importInsomniaV5(text: string): Collection {
  const doc = YAML.parse(text) as Record<string, unknown>;
  if (!isInsomniaV5(doc)) {
    throw new Error('不是 Insomnia v5 檔案');
  }
  if (doc.type !== V5_COLLECTION_TYPE && doc.type !== 'spec.insomnia.rest/5.0') {
    throw new Error(`不支援的 Insomnia 檔案類型：${String(doc.type)}`);
  }
  const meta = metaOf(doc);
  const children: TreeNode[] = [];
  ((doc.collection ?? []) as Array<Record<string, unknown>>).forEach((c, i) => {
    const node = v5ToNode(c, i);
    if (node) {
      children.push(node);
    }
  });

  const rawEnv = (doc.environments ?? {}) as Record<string, unknown>;
  const envMeta = metaOf(rawEnv);
  const environments: EnvironmentSet = {
    base: {
      id: envMeta.id || genId('env'),
      name: String(rawEnv.name ?? 'Base Environment'),
      color: (rawEnv.color as string | null | undefined) ?? null,
      data: (rawEnv.data ?? {}) as Record<string, unknown>,
    },
    subEnvironments: ((rawEnv.subEnvironments ?? []) as Array<Record<string, unknown>>).map((sub) => {
      const subMeta = metaOf(sub);
      return {
        id: subMeta.id || genId('env'),
        name: String(sub.name ?? ''),
        color: (sub.color as string | null | undefined) ?? null,
        isPrivate: subMeta.isPrivate ?? false,
        data: (sub.data ?? {}) as Record<string, unknown>,
      };
    }),
  };

  const rawJar = (doc.cookieJar ?? {}) as Record<string, unknown>;
  const jarMeta = metaOf(rawJar);
  const now = Date.now();
  return {
    id: meta.id || genId('wrk'),
    name: String(doc.name ?? 'Imported Collection'),
    ...(meta.description ? { description: meta.description } : {}),
    created: meta.created ?? now,
    modified: meta.modified ?? now,
    servers: [],
    children,
    environments,
    cookieJar: {
      id: jarMeta.id || genId('jar'),
      name: String(rawJar.name ?? 'Default Jar'),
      cookies: (rawJar.cookies ?? []) as Collection['cookieJar']['cookies'],
    },
  };
}
