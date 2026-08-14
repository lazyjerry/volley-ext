// 匯入外部（非本延伸模組產生的）OpenAPI 3.x 文件為 Collection。
// 推導規則：servers[0] → base_url 環境變數；tags → 單層資料夾；{x} → {{ _.x }}。

import * as YAML from 'yaml';
import type { Collection, Folder, QueryParam, RequestBody, RequestItem, TreeNode } from '../model/types';
import { defaultSettings } from '../model/types';
import { genId } from '../model/ids';

const OPENAPI_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function pathToTemplate(path: string): string {
  return path.replace(/\{([\w.-]+)\}/g, '{{ _.$1 }}');
}

function extractBody(operation: Record<string, unknown>): RequestBody {
  const requestBody = operation.requestBody as Record<string, unknown> | undefined;
  const content = requestBody?.content as Record<string, Record<string, unknown>> | undefined;
  if (!content) {
    return {};
  }
  const [mimeType, media] = Object.entries(content)[0] ?? [];
  if (!mimeType) {
    return {};
  }
  let text = '';
  const example = media.example ?? (media.examples ? Object.values(media.examples as Record<string, { value?: unknown }>)[0]?.value : undefined);
  if (example !== undefined) {
    text = typeof example === 'string' ? example : JSON.stringify(example, null, 2);
  }
  return { mimeType, text };
}

export function importOpenApi(input: string | Record<string, unknown>): Collection {
  const doc = (typeof input === 'string' ? YAML.parse(input) : input) as Record<string, unknown>;
  if (!doc || typeof doc !== 'object' || (!doc.openapi && !doc.swagger)) {
    throw new Error('不是有效的 OpenAPI 文件');
  }
  const info = (doc.info ?? {}) as Record<string, unknown>;
  const servers = ((doc.servers ?? []) as Array<{ url?: string }>)
    .map((s) => s.url ?? '')
    .filter((u) => u !== '');
  const baseUrl = servers[0] ?? '';

  const folderByTag = new Map<string, Folder>();
  const root: TreeNode[] = [];
  let sortCounter = 0;

  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const [path, opsByMethod] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(opsByMethod)) {
      if (!OPENAPI_METHODS.includes(method)) {
        continue;
      }
      const operation = op as Record<string, unknown>;
      const parameters: QueryParam[] = [];
      const opParams = [
        ...((opsByMethod.parameters as Array<Record<string, unknown>> | undefined) ?? []),
        ...((operation.parameters as Array<Record<string, unknown>> | undefined) ?? []),
      ];
      for (const p of opParams) {
        if (p.in === 'query') {
          parameters.push({ name: String(p.name ?? ''), value: '', disabled: p.required !== true });
        }
      }
      const url = (baseUrl ? '{{ _.base_url }}' : '') + pathToTemplate(path);
      const request: RequestItem = {
        kind: 'request',
        id: genId('req'),
        name: String(operation.summary ?? operation.operationId ?? `${method.toUpperCase()} ${path}`),
        sortKey: sortCounter++,
        method: method.toUpperCase(),
        url,
        parameters,
        pathParameters: [...path.matchAll(/\{([\w.-]+)\}/g)].map((m) => ({ name: m[1], value: '' })),
        headers: [],
        body: extractBody(operation),
        authentication: {},
        settings: defaultSettings(),
      };
      if (operation.description !== undefined) {
        request.description = String(operation.description);
      }
      const tag = ((operation.tags as string[] | undefined) ?? [])[0];
      if (tag) {
        if (!folderByTag.has(tag)) {
          const folder: Folder = {
            kind: 'folder',
            id: genId('fld'),
            name: tag,
            sortKey: sortCounter++,
            children: [],
          };
          folderByTag.set(tag, folder);
          root.push(folder);
        }
        folderByTag.get(tag)!.children.push(request);
      } else {
        root.push(request);
      }
    }
  }

  const now = Date.now();
  return {
    id: genId('wrk'),
    name: String(info.title ?? 'Imported API'),
    ...(info.description !== undefined ? { description: String(info.description) } : {}),
    created: now,
    modified: now,
    servers,
    children: root,
    environments: {
      base: {
        id: genId('env'),
        name: 'Base Environment',
        data: baseUrl ? { base_url: baseUrl } : {},
      },
      subEnvironments: [],
    },
    cookieJar: { id: genId('jar'), name: 'Default Jar', cookies: [] },
  };
}
