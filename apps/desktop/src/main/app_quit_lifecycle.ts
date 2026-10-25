interface QuitEventSource<E extends string> {
  on(event: E, listener: () => void): unknown;
}

/** 暂缓真正退出，等后台清理结束后重走正常退出，不绕过更新安装的握手。 */
export function registerAppQuitCleanup(
  app: {
    on(
      event: 'before-quit',
      listener: (event: { readonly defaultPrevented?: boolean; preventDefault(): void }) => void,
    ): unknown;
    quit(): void;
  },
  cleanup: () => Promise<void>,
  failed: (error: unknown) => void,
  updater?: QuitEventSource<'before-quit-for-update'>,
): void {
  let cleaning = false;
  let cleaned = false;
  let updating = false;
  // 原生更新先关闭窗口再交给安装器，不把这次交接改成普通 app.quit。
  updater?.on('before-quit-for-update', () => {
    updating = true;
  });
  app.on('before-quit', (event) => {
    if (event.defaultPrevented || cleaned || updating) return;
    event.preventDefault();
    if (cleaning) return;
    cleaning = true;
    void (async () => {
      try {
        await cleanup();
      } catch (error) {
        failed(error);
      } finally {
        cleaned = true;
        app.quit();
      }
    })();
  });
}

/** 普通退出与更新退出共享准备动作，避免重复保存和释放资源。 */
export function registerAppQuitPreparation(
  app: QuitEventSource<'before-quit'>,
  updater: QuitEventSource<'before-quit-for-update'>,
  prepare: () => void,
): void {
  let prepared = false;
  const run = () => {
    if (prepared) return;
    prepared = true;
    prepare();
  };
  app.on('before-quit', (event?: { readonly defaultPrevented?: boolean }) => {
    if (!event?.defaultPrevented) run();
  });
  // 更新安装先关闭窗口，再发普通 before-quit；必须提前放行窗口 close。
  updater.on('before-quit-for-update', run);
}
