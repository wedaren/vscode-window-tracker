import * as vscode from 'vscode';

/**
 * @docs EditorTracker
 * 会话内编辑器标签页最后活跃时间追踪器（单例）。
 * 监听活跃编辑器切换事件，记录每个 URI 字符串的最后访问时间戳（毫秒）。
 * 数据仅在本次会话内有效，重启 VS Code 后重置。
 */
export class EditorTracker {
  private static _instance: EditorTracker | undefined;

  /** URI string → lastActive 时间戳（毫秒） */
  private readonly _map = new Map<string, number>();

  private constructor() {}

  /**
   * @docs getInstance
   * 获取单例实例。
   */
  static getInstance(): EditorTracker {
    if (!EditorTracker._instance) {
      EditorTracker._instance = new EditorTracker();
    }
    return EditorTracker._instance;
  }

  /**
   * @docs start
   * 开始监听活跃编辑器变化，将 Disposable 注册到 context.subscriptions 以自动释放。
   * 同时记录激活时已打开的活跃编辑器。
   */
  start(context: vscode.ExtensionContext): void {
    const active = vscode.window.activeTextEditor;
    if (active) {
      this._map.set(active.document.uri.toString(), Date.now());
    }

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
          this._map.set(editor.document.uri.toString(), Date.now());
        }
      })
    );
  }

  /**
   * @docs getLastActive
   * 获取指定 URI 字符串的最后活跃时间（毫秒）。未追踪的 URI 返回 undefined。
   */
  getLastActive(uriString: string): number | undefined {
    return this._map.get(uriString);
  }
}
