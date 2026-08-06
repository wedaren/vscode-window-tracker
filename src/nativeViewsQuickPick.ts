import * as vscode from 'vscode';

/**
 * @docs openNativeViewsQuickPick
 * 调用 VS Code 内置的「Open View」命令，列出所有视图（含所有插件的 TreeView），
 * 输入过滤后选择即可跳转。作为 viewsQuickPick 的原生 fallback 保留。
 */
export function openNativeViewsQuickPick(): void {
  void vscode.commands.executeCommand('workbench.action.openView');
}
