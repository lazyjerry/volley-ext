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
