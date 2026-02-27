import * as assert from 'assert';
import * as vscode from 'vscode';
import { TrackerService } from '../trackerService';

suite('TrackerService 单独模块测试 (中文注释)', () => {
  const origGetConfig = vscode.workspace.getConfiguration;

  setup(() => {
    // 将配置钩子替换为默认值，避免依赖真实 workspace
    (vscode.workspace as any).getConfiguration = (_: any) => ({ get: (_k: any, d: any) => d });
  });

  teardown(() => {
    // 恢复原始配置函数
    (vscode.workspace as any).getConfiguration = origGetConfig;
  });

  test('场景1：writeNow 写入文件并记录路径', async () => {
    // 使用假的 fs 和 globalState 观察副作用
    let wroteTmp: { path?: string; data?: string } = {};
    let renamed: { src?: string; dest?: string } = {};
    let updatedKey: string | undefined;
    let updatedValue: any;

    const fakeFs: any = {
      mkdir: async () => {},
      writeFile: async (p: string, data: string) => { wroteTmp.path = p; wroteTmp.data = data; },
      rename: async (s: string, d: string) => { renamed.src = s; renamed.dest = d; },
      readFile: async () => '',
      unlink: async () => {},
      readdir: async () => [],
    };

    const fakeGlobalState = {
      get: (_k: string) => undefined,
      update: async (k: string, v: any) => { updatedKey = k; updatedValue = v; },
    } as any;
    const ctx = { globalState: fakeGlobalState } as vscode.ExtensionContext;
    const svc = new TrackerService(ctx, { fs: fakeFs });

    await svc.writeNow();

    assert.ok(wroteTmp.path?.endsWith('.tmp'), '应该先写入 .tmp 文件');
    assert.strictEqual(renamed.src, wroteTmp.path);
    assert.ok(renamed.dest?.endsWith('.json'));
    assert.strictEqual(updatedKey, 'vscode-window-tracker.trackerFile');
    assert.ok(typeof updatedValue === 'string' && updatedValue.endsWith('.json'));
  });

  test('场景2：startupCleanup 删除过期文件', async () => {
    const files = ['old.json', 'new.json'];
    let deleted: string[] = [];

    const fakeFs2: any = {
      readdir: async () => files,
      readFile: async (p: string, _enc: string) => {
        if (p.endsWith('old.json')) return JSON.stringify({ lastActive: Date.now() - 1000 * 60 * 60 });
        return JSON.stringify({ lastActive: Date.now() });
      },
      unlink: async (p: string) => { deleted.push(p); },
    };

    const fakeGlobalState = { get: (_k: string) => undefined, update: async () => {} } as any;
    const ctx = { globalState: fakeGlobalState } as vscode.ExtensionContext;
    const svc = new TrackerService(ctx, { fs: fakeFs2 });

    // 私有方法，通过 any 绕过类型检查
    await (svc as any).startupCleanup();

    assert.ok(deleted.some(d => d.endsWith('old.json')), '旧文件应被删除');
    assert.ok(!deleted.some(d => d.endsWith('new.json')), '新文件不应被删除');
  });

  test('场景3：removeNow 清理文件并重置 globalState', async () => {
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
