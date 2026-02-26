import * as assert from 'assert';
import * as vscode from 'vscode';
import { TrackerService } from '../trackerService';

suite('TrackerService 使用场景测试', () => {
  const origGetConfig = vscode.workspace.getConfiguration;

  setup(() => {
    // stub configuration to use defaults
    (vscode.workspace as any).getConfiguration = (_: any) => ({ get: (_k: any, d: any) => d });
  });

  teardown(() => {
    // restore vscode config
    (vscode.workspace as any).getConfiguration = origGetConfig;
  });

  test('场景：启动时写入当前会话并持久化路径', async () => {
    // 场景描述：服务写入临时文件并通过 rename 生成最终 json，同时把文件路径保存到 globalState
    let wroteTmp: { path?: string; data?: string } = {};
    let renamed: { src?: string; dest?: string } = {};
    let updatedKey: string | undefined;
    let updatedValue: any;

    const fakeFs: any = {
      mkdir: async () => {},
      writeFile: async (p: string, data: string) => { wroteTmp.path = p; wroteTmp.data = data; },
      rename: async (s: string, d: string) => { renamed.src = s; renamed.dest = d; },
    };

    const fakeGlobalState = {
      get: (_k: string) => undefined,
      update: async (k: string, v: any) => { updatedKey = k; updatedValue = v; },
    } as any;

    const ctx = { globalState: fakeGlobalState } as vscode.ExtensionContext;
    const svc = new TrackerService(ctx, { fs: fakeFs });

    await svc.writeNow();

    assert.ok(wroteTmp.path?.endsWith('.tmp'));
    assert.strictEqual(renamed.src, wroteTmp.path);
    assert.ok(renamed.dest?.endsWith('.json'));
    assert.strictEqual(updatedKey, 'vscode-window-tracker.trackerFile');
    assert.ok(typeof updatedValue === 'string' && updatedValue.endsWith('.json'));
  });

  test('场景：启动清理会移除过期文件', async () => {
    // 场景描述：当目录中存在过期 JSON 文件，启动清理应删除它们
    const files = ['old.json', 'new.json'];
    const fakeFs2: any = {
      readdir: async () => files,
      readFile: async (p: string, _enc: string) => {
        if (p.endsWith('old.json')) return JSON.stringify({ lastActive: Date.now() - 1000 * 60 * 60 });
        return JSON.stringify({ lastActive: Date.now() });
      },
      unlink: async (p: string) => { deleted.push(p); },
    };
    let deleted: string[] = [];

    const fakeGlobalState = { get: (_k: string) => undefined, update: async () => {} } as any;
    const ctx = { globalState: fakeGlobalState } as vscode.ExtensionContext;
    const svc = new TrackerService(ctx, { fs: fakeFs2 });

    // startupCleanup 是私有的，直接调用以便测试其效果
    await (svc as any).startupCleanup();

    assert.ok(deleted.some(d => d.endsWith('old.json')));
    assert.ok(!deleted.some(d => d.endsWith('new.json')));
  });

  test('场景：停用时删除当前会话文件', async () => {
    // 场景描述：服务在停用时应删除自己的 tracker 文件并清空 globalState
    let unlinkedPath: string | undefined;
    let updatedKey: string | undefined;
    let updatedValue: any;

    const fakeFs3: any = { unlink: async (p: string) => { unlinkedPath = p; } };

    const fakeGlobalState = {
      get: (_k: string) => '/tmp/fake-tracker-123.json',
      update: async (k: string, v: any) => { updatedKey = k; updatedValue = v; },
    } as any;

    const ctx = { globalState: fakeGlobalState } as vscode.ExtensionContext;
    const svc = new TrackerService(ctx, { fs: fakeFs3 });

    await svc.removeNow();

    assert.strictEqual(unlinkedPath, '/tmp/fake-tracker-123.json');
    assert.strictEqual(updatedKey, 'vscode-window-tracker.trackerFile');
    assert.strictEqual(updatedValue, undefined);
  });
});
