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

  test('buildSavedNodes 支持 displayName 和 color', async () => {
    const fakeState: any = { get: (_: string) => [], update: async () => {} };
    const fakeFs: any = {
      readFile: async () =>
        JSON.stringify([{ id: '/tmp/demo', displayName: '演示项目', color: 'blue' }]),
    };
    const ctx = { globalState: fakeState, globalStoragePath: os.tmpdir() } as any;
    const svc = new SavedService(ctx, { fs: fakeFs, trackerDir: os.tmpdir() });

    const nodes = await svc.buildSavedNodes();

    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes[0].displayName, '演示项目');
    assert.strictEqual(nodes[0].color, 'blue');
  });

  test('upsertMetadata 会创建并更新保存项元数据', async () => {
    let written: any;
    const fakeState: any = { get: (_: string) => [], update: async () => {} };
    const fakeFs: any = {
      readFile: async () => '[]',
      writeFile: async (_path: string, data: string) => {
        written = JSON.parse(data);
      },
      rename: async () => {},
    };
    const ctx = { globalState: fakeState, globalStoragePath: os.tmpdir() } as any;
    const svc = new SavedService(ctx, { fs: fakeFs, trackerDir: os.tmpdir() });

    await svc.upsertMetadata('/tmp/demo', { displayName: '演示项目', color: 'green' });

    assert.strictEqual(written[0].id, '/tmp/demo');
    assert.strictEqual(written[0].displayName, '演示项目');
    assert.strictEqual(written[0].color, 'green');
  });
});
