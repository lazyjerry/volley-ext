import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'workjerry.volley';

suite('extension activation', () => {
  test('延伸模組可啟動', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, '找不到延伸模組');
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test('commands 全數註冊', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    await ext?.activate();
    const all = await vscode.commands.getCommands(true);
    for (const cmd of [
      'volley.open',
      'volley.newCollection',
      'volley.importInsomnia',
      'volley.importOpenApi',
      'volley.importCurl',
      'volley.importFromUrl',
      'volley.exportInsomniaYaml',
      'volley.exportOpenApi',
      'volley.chooseDataFolder',
      'volley.openDataFolder',
      'volley.reload',
    ]) {
      assert.ok(all.includes(cmd), `缺少 command：${cmd}`);
    }
  });

  test('設定項存在且有預設值', () => {
    const config = vscode.workspace.getConfiguration('volley');
    assert.strictEqual(config.get('dataFolder'), '');
    assert.strictEqual(config.get('privateDataFolder'), '');
    assert.strictEqual(config.get('requestTimeoutMs'), 30000);
    assert.strictEqual(config.get('responseHistoryLimit'), 20);
  });

  test('open 指令可執行（view focus）', async () => {
    await vscode.commands.executeCommand('volley.open');
  });
});
