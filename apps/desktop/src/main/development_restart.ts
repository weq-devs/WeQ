// electron-vite 收到该退出码后，在当前监听和 Vite 服务内重启 Electron。
export const DEVELOPMENT_RESTART_EXIT_CODE = 75;
export const DEVELOPMENT_MENU_RESTART = 'weq:development-menu-restart';

/** 只有窗口放行且退出清理完成，才向开发启动器提交重启。 */
export function scheduleDevelopmentRestart(
  app: Pick<Electron.App, 'on' | 'removeListener' | 'exit'>,
  signal: AbortSignal,
): void {
  if (process.env.WEQ_DEV_RESTART_MANAGED !== '1')
    throw new Error('请先退出 WeQ，并在终端重新运行 pnpm dev 以启用菜单重启。');
  if (signal.aborted) return;

  const restart = (event: Electron.Event) => {
    if (event.defaultPrevented) return;
    remove();
    event.preventDefault();
    // 等本轮 will-quit 返回后退出，保留已经完成的正常退出清理。
    setImmediate(() => app.exit(DEVELOPMENT_RESTART_EXIT_CODE));
  };
  const remove = () => {
    app.removeListener('will-quit', restart);
    signal.removeEventListener('abort', remove);
  };
  app.on('will-quit', restart);
  signal.addEventListener('abort', remove, { once: true });
}
