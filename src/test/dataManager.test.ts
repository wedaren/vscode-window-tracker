import * as assert from 'assert';
import * as os from 'os';
import * as vscode from 'vscode';
import { DataManager, formatTitle, buildTooltip } from '../dataManager';
import { TrackerService } from '../trackerService';

suite('DataManager 保存/跟踪/追踪服务测试', () => {
  const origGetConfig = vscode.workspace.getConfiguration;

  setup(() => {
    // stub configuration to use defaults
    (vscode.workspace as any).getConfiguration = (_: any) => ({ get: (_k: any, d: any) => d });
  });

  teardown(() => {
    (vscode.workspace as any).getConfiguration = origGetConfig;
  });

  test('保存集基本操作和持久化回写', async () => {
    const fakeGlobalState: any = {
      get: (_k: string) => [],
      update: async (_k: string, v: any) => {
        lastUpdate = v;
      },
    };
    let lastUpdate: any;
    const ctx = {
      globalState: fakeGlobalState,
      globalStoragePath: os.tmpdir(),
    } as any as vscode.ExtensionContext;
    const dm = new DataManager(ctx, { fs: {} as any });

    assert.deepStrictEqual(dm.getSavedArray(), []);
    assert.strictEqual(dm.isSaved('foo'), false);

    await dm.save('foo');
    assert.strictEqual(dm.isSaved('foo'), true);
    assert.deepStrictEqual(dm.getAllSaved(), ['foo']);
    assert.strictEqual(lastUpdate[0].id, 'foo');

    await dm.removeSaved('foo');
    assert.strictEqual(dm.isSaved('foo'), false);
    assert.deepStrictEqual(dm.getAllSaved(), []);
  });

  test('normalizeTrackedNodes 将记录转换为 WindowNode 并排序', () => {
    const ctx = { globalState: { get: (_: any) => [], update: async () => {} } } as any;
    const dm = new DataManager(ctx, { fs: {} as any });
    const now = Date.now();
    const records = [
      { title: 'A', lastActive: now - 1000 },
      { title: 'B', lastActive: now - 5000 },
    ];
    const nodes = dm.normalizeTrackedNodes(records as any);
    assert.strictEqual(nodes.length, 2);
    assert.strictEqual(nodes[0].title, 'A');
    assert.strictEqual(nodes[1].title, 'B');
  });

  test('tracker 功能应写入文件并更新 globalState', async () => {
    let wroteTmp: { path?: string; data?: string } = {};
    let renamed: { src?: string; dest?: string } = {};
    let updatedKey: string | undefined;
    let updatedValue: any;

    const fakeFs: any = {
      mkdir: async () => {},
      writeFile: async (p: string, data: string) => {
        wroteTmp.path = p;
        wroteTmp.data = data;
      },
      rename: async (s: string, d: string) => {
        renamed.src = s;
        renamed.dest = d;
      },
      readFile: async () => '',
      unlink: async () => {},
      readdir: async () => [],
    };

    const fakeGlobalState = {
      get: (_k: string) => undefined,
      update: async (k: string, v: any) => {
        updatedKey = k;
        updatedValue = v;
      },
    } as any;
    const ctx = {
      globalState: fakeGlobalState,
      globalStoragePath: os.tmpdir(),
    } as any as vscode.ExtensionContext;
    const dm = new DataManager(ctx, { fs: fakeFs });

    dm.startTracker();
    const svc = (dm as any).tracker;
    await svc.writeNow();

    assert.ok(wroteTmp.path?.endsWith('.tmp'));
    assert.strictEqual(renamed.src, wroteTmp.path);
    assert.ok(renamed.dest?.endsWith('.json'));
    assert.strictEqual(updatedKey, 'vscode-window-tracker.trackerFile');
    assert.ok(typeof updatedValue === 'string' && updatedValue.endsWith('.json'));

    await dm.stopTracker();
  });

  test('TrackerService 可以独立实例化并执行相同逻辑', async () => {
    let wroteTmp: { path?: string; data?: string } = {};
    let renamed: { src?: string; dest?: string } = {};
    let updatedKey: string | undefined;
    let updatedValue: any;

    const fakeFs: any = {
      mkdir: async () => {},
      writeFile: async (p: string, data: string) => {
        wroteTmp.path = p;
        wroteTmp.data = data;
      },
      rename: async (s: string, d: string) => {
        renamed.src = s;
        renamed.dest = d;
      },
      readFile: async () => '',
      unlink: async () => {},
      readdir: async () => [],
    };

    const fakeGlobalState = {
      get: (_k: string) => undefined,
      update: async (k: string, v: any) => {
        updatedKey = k;
        updatedValue = v;
      },
    } as any;
    const ctx = {
      globalState: fakeGlobalState,
      globalStoragePath: os.tmpdir(),
    } as any as vscode.ExtensionContext;
    const svc = new TrackerService(ctx, { fs: fakeFs });

    svc.start();
    await svc.writeNow();

    assert.ok(wroteTmp.path?.endsWith('.tmp'));
    assert.strictEqual(renamed.src, wroteTmp.path);
    assert.ok(renamed.dest?.endsWith('.json'));
    assert.strictEqual(updatedKey, 'vscode-window-tracker.trackerFile');
    assert.ok(typeof updatedValue === 'string' && updatedValue.endsWith('.json'));

    svc.stop();
  });

  // additional helper tests
  test('formatTitle and tooltip formatting produce expected strings', () => {
    const ctx = { globalState: { get: (_: any) => [], update: async () => {} } } as any;
    const dm = new DataManager(ctx, { fs: {} as any });
    const node: any = { title: 'T', relativeActive: 'now' };
    assert.strictEqual(formatTitle(node), 'T');
    const tip = buildTooltip(node);
    assert.ok(tip.value.includes('T'));
  });
});
