import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // 在 VSCode extension host / Electron 環境下執行時會繼承 ELECTRON_RUN_AS_NODE=1，
  // 導致測試用 VSCode 以純 Node 模式啟動並對所有 Electron 參數回報 "bad option"。
  delete process.env.ELECTRON_RUN_AS_NODE;
  // 專案路徑長（含中文）會讓預設 user-data-dir 的 IPC socket 超過 103 字元上限 → 用短暫存路徑
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ie-ud-'));
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
    const extensionTestsPath = path.resolve(__dirname, 'integration', 'index');
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--disable-extensions', `--user-data-dir=${userDataDir}`],
    });
  } catch {
    console.error('整合測試失敗');
    process.exit(1);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

void main();
