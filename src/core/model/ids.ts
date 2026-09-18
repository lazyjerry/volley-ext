// id：前綴 + 32 位十六進位亂數（前綴規則沿用 Insomnia v5 格式，匯出時可直接通過其 schema 驗證）。
// 前綴是硬規則（wrk_/fld_/req_/env_/jar_），v5 schema 依前綴驗證。

const HEX = '0123456789abcdef';

function randomHex(length: number): string {
  let out = '';
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(length);
    cryptoObj.getRandomValues(bytes);
    for (let i = 0; i < length; i++) {
      out += HEX[bytes[i] % 16];
    }
    return out;
  }
  for (let i = 0; i < length; i++) {
    out += HEX[Math.floor(Math.random() * 16)];
  }
  return out;
}

export type IdPrefix = 'wrk' | 'fld' | 'req' | 'env' | 'jar';

export function genId(prefix: IdPrefix): string {
  return `${prefix}_${randomHex(32)}`;
}

/**
 * collection／request id 會直接成為 state 檔名或目錄名，
 * 必須是單一路徑片段：非空、不是 . 或 ..、不含 / \ 與 NUL。
 * 不限定 genId 格式：既有資料與 Insomnia 匯入的 id 形式不一。
 */
export function isSafeIdSegment(id: unknown): id is string {
  return typeof id === 'string' && id !== '' && id !== '.' && id !== '..' && !/[/\\\0]/.test(id);
}

/** 匯入／解析用：id 不安全就重新產生。 */
export function safeIdOr(id: unknown, prefix: IdPrefix): string {
  return isSafeIdSegment(id) ? id : genId(prefix);
}
