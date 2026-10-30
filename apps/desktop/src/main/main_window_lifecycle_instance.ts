/**
 * 把「唤起主窗口」从 `index.ts` 里露出来，给不认识 Electron 的调用方（外部 MCP 的
 * 切号工具）用。
 *
 * `mainWindowLifecycle` 在 `index.ts` 里创建，而 `index.ts` 又会 import 大量模块；
 * 直接反向 import 会成环。所以 `index.ts` 启动时把 lifecycle 注册到这里，需要的人
 * 拿一个函数走 —— 与 `main_window.ts` 的窗口登记表同一个思路。
 */

interface Revealable {
  open(options?: { show?: boolean }): unknown;
}

let lifecycle: Revealable | null = null;

export function registerMainWindowReveal(target: Revealable): void {
  lifecycle = target;
}

/**
 * 恢复 / 显示 / 聚焦主窗口，窗口已被销毁时新建。
 *
 * 返回 false 表示当前进程没有可用的窗口生命周期（尚未启动完成、或正在退出）——
 * 调用方据此判断「唤起」到底做没做成。
 */
export function revealMainWindow(): boolean {
  if (!lifecycle) return false;
  lifecycle.open({ show: true });
  return true;
}
