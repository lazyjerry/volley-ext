// Insomnia Export Format v4（JSON 或 YAML）匯入。
// 判別 __export_format === 4；resources[] 扁平陣列以 parentId 重建樹。
// 注意：settingDisableRenderRequestBody → settings.renderRequestBody 需布林反轉。

import * as YAML from 'yaml';
import type {
  Authentication,
  Collection,
  EnvironmentSet,
  Folder,
  RequestItem,
  Scripts,
  TreeNode,
} from '../model/types';
import { defaultSettings, isFolder } from '../model/types';
import { genId } from '../model/ids';

interface V4Resource {
  _id: string;
  _type: string;
  parentId: string | null;
  name?: string;
  description?: string;
  metaSortKey?: number;
  [key: string]: unknown;
}

export function isInsomniaV4(doc: unknown): boolean {
  const d = doc as { __export_format?: number } | null;
  return Boolean(d && typeof d === 'object' && d.__export_format === 4);
}

function scriptsOf(res: V4Resource): Scripts | undefined {
  const pre = res.preRequestScript as string | undefined;
  const after = res.afterResponseScript as string | undefined;
  if (!pre && !after) {
    return undefined;
  }
  const scripts: Scripts = {};
  if (pre) {
    scripts.preRequest = pre;
  }
  if (after) {
    scripts.afterResponse = after;
  }
  return scripts;
}

function toRequest(res: V4Resource, fallbackSort: number): RequestItem {
  const d = defaultSettings();
  const request: RequestItem = {
    kind: 'request',
    id: res._id || genId('req'),
    name: String(res.name ?? ''),
    sortKey: res.metaSortKey ?? fallbackSort,
    method: String(res.method ?? 'GET').toUpperCase(),
    url: String(res.url ?? ''),
    parameters: (res.parameters ?? []) as RequestItem['parameters'],
    pathParameters: (res.pathParameters ?? []) as RequestItem['pathParameters'],
    headers: (res.headers ?? []) as RequestItem['headers'],
    body: (res.body ?? {}) as RequestItem['body'],
    authentication: (res.authentication ?? {}) as Authentication,
    settings: {
      // v4 存「停用 render」，v5/內部模型存「啟用 render」→ 反轉
      renderRequestBody: !(res.settingDisableRenderRequestBody as boolean | undefined ?? false),
      encodeUrl: (res.settingEncodeUrl as boolean | undefined) ?? d.encodeUrl,
      followRedirects:
        (res.settingFollowRedirects as RequestItem['settings']['followRedirects'] | undefined) ??
        d.followRedirects,
      cookies: {
        send: (res.settingSendCookies as boolean | undefined) ?? d.cookies.send,
        store: (res.settingStoreCookies as boolean | undefined) ?? d.cookies.store,
      },
      rebuildPath: (res.settingRebuildPath as boolean | undefined) ?? d.rebuildPath,
    },
  };
  if (res.description) {
    request.description = String(res.description);
  }
  const scripts = scriptsOf(res);
  if (scripts) {
    request.scripts = scripts;
  }
  return request;
}

function toFolder(res: V4Resource, fallbackSort: number): Folder {
  const folder: Folder = {
    kind: 'folder',
    id: res._id || genId('fld'),
    name: String(res.name ?? ''),
    sortKey: res.metaSortKey ?? fallbackSort,
    children: [],
  };
  if (res.description) {
    folder.description = String(res.description);
  }
  if (res.environment && typeof res.environment === 'object' && Object.keys(res.environment).length > 0) {
    folder.environment = res.environment as Record<string, unknown>;
  }
  const scripts = scriptsOf(res);
  if (scripts) {
    folder.scripts = scripts;
  }
  return folder;
}

export function importInsomniaV4(text: string): Collection {
  // v4 檔可為 JSON 或 YAML；YAML.parse 是 JSON 超集，統一處理
  const doc = YAML.parse(text) as Record<string, unknown>;
  if (!isInsomniaV4(doc)) {
    throw new Error('不是 Insomnia v4 匯出檔');
  }
  const resources = (doc.resources ?? []) as V4Resource[];

  const workspace = resources.find((r) => r._type === 'workspace');
  const workspaceId = workspace?._id ?? null;

  const nodeById = new Map<string, TreeNode>();
  let sortCounter = 0;
  for (const res of resources) {
    if (res._type === 'request_group') {
      nodeById.set(res._id, toFolder(res, sortCounter++));
    } else if (res._type === 'request') {
      nodeById.set(res._id, toRequest(res, sortCounter++));
    }
  }

  const root: TreeNode[] = [];
  for (const res of resources) {
    const node = nodeById.get(res._id);
    if (!node) {
      continue;
    }
    const parent = res.parentId ? nodeById.get(res.parentId) : undefined;
    if (parent && isFolder(parent)) {
      parent.children.push(node);
    } else if (!res.parentId || res.parentId === workspaceId || !nodeById.has(res.parentId)) {
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

  // environment：parentId = workspace → base；parentId = base env → sub
  const envResources = resources.filter((r) => r._type === 'environment');
  const baseEnvRes = envResources.find((r) => r.parentId === workspaceId) ?? envResources[0];
  const environments: EnvironmentSet = {
    base: {
      id: baseEnvRes?._id ?? genId('env'),
      name: String(baseEnvRes?.name ?? 'Base Environment'),
      color: (baseEnvRes?.color as string | null | undefined) ?? null,
      data: (baseEnvRes?.data ?? {}) as Record<string, unknown>,
    },
    subEnvironments: envResources
      .filter((r) => baseEnvRes && r.parentId === baseEnvRes._id)
      .map((r) => ({
        id: r._id,
        name: String(r.name ?? ''),
        color: (r.color as string | null | undefined) ?? null,
        isPrivate: (r.isPrivate as boolean | undefined) ?? false,
        data: (r.data ?? {}) as Record<string, unknown>,
      })),
  };

  const jarRes = resources.find((r) => r._type === 'cookie_jar');
  const now = Date.now();
  return {
    id: workspaceId ?? genId('wrk'),
    name: String(workspace?.name ?? 'Imported Collection'),
    ...(workspace?.description ? { description: String(workspace.description) } : {}),
    created: (workspace?.created as number | undefined) ?? now,
    modified: (workspace?.modified as number | undefined) ?? now,
    servers: [],
    children: root,
    environments,
    cookieJar: {
      id: jarRes?._id ?? genId('jar'),
      name: String(jarRes?.name ?? 'Default Jar'),
      cookies: (jarRes?.cookies ?? []) as Collection['cookieJar']['cookies'],
    },
  };
}
