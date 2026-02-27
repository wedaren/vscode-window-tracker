import * as assert from 'assert';
import * as os from 'os';
import * as vscode from 'vscode';
import { SavedService } from '../savedService';

suite('SavedService 单元测试', () => {
  const origGetConfig = vscode.workspace.getConfiguration;
  setup(() => {
    (vscode.workspace as any).getConfiguration = (_: any) => ({ get: (_k: any, d: any) => d });
  });
  teardown(() => {
    (vscode.workspace as any).getConfiguration = origGetConfig;
  });

  test('save/remove/isSaved/getAllSaved 工作正常', async () => {
    const fakeState: any = { get: (_: string) => [], update: async () => {} };
    const ctx = { globalState: fakeState, globalStoragePath: os.tmpdir() } as any;
    const svc = new SavedService(ctx, { fs: {} as any, trackerDir: os.tmpdir() });

    assert.deepStrictEqual(svc.getSavedArray(), []);
    await svc.save('foo');
    assert.strictEqual(svc.isSaved('foo'), true);
    assert.deepStrictEqual(svc.getAllSaved(), ['foo']);
    await svc.remove('foo');
    assert.strictEqual(svc.isSaved('foo'), false);
  });
});
