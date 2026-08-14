import type { Collection, Folder } from '../model/types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 深合併：overlay 覆蓋 base，物件遞迴合併，其餘型別直接取代。 */
export function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 解析生效環境：base ← active sub-env ← 資料夾鏈（由外而內，越近 request 優先）。
 */
export function resolveEnvironment(
  collection: Collection,
  activeSubEnvironmentId: string | null,
  folderChain: Folder[],
): Record<string, unknown> {
  let merged: Record<string, unknown> = { ...collection.environments.base.data };
  if (activeSubEnvironmentId) {
    const sub = collection.environments.subEnvironments.find((s) => s.id === activeSubEnvironmentId);
    if (sub) {
      merged = deepMerge(merged, sub.data);
    }
  }
  for (const folder of folderChain) {
    if (folder.environment) {
      merged = deepMerge(merged, folder.environment);
    }
  }
  return merged;
}
