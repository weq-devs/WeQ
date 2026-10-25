interface QuitEventSource<E extends string> {
  on(event: E, listener: () => void): unknown;
}

/** 全部窗口同意关闭后才停止后台，避免未保存内容取消退出时服务已被关闭。 */
export function registerAppQuitCleanup(
  app: {
    on(
      event: 'will-quit',
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
  app.on('will-quit', (event) => {
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
        // 等 Electron 完成这次 will-quit 取消，避免微任务内重入仍被视为正在退出。
        setImmediate(() => app.quit());
      }
    })();
  });
}

/** 普通退出与更新退出共享窗口放行标记；取消卸载后允许重置并重新准备。 */
export function registerAppQuitPreparation(
  app: QuitEventSource<'before-quit'>,
  updater: QuitEventSource<'before-quit-for-update'>,
  prepare: () => void,
): () => void {
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
  return () => {
    prepared = false;
  };
}

/** Electron 默认静默拦截 beforeunload；由原生确认框明确决定是否放弃更改。 */
export function registerWindowUnloadConfirmation(
  contents: {
    on(
      event: 'will-prevent-unload',
      listener: (event: { preventDefault(): void }) => void,
    ): unknown;
  },
  options: { confirmDiscard(): boolean; cancelled(): void },
): void {
  contents.on('will-prevent-unload', (event) => {
    // 此事件 preventDefault 的含义是忽略渲染层拦截，继续卸载。
    if (options.confirmDiscard()) event.preventDefault();
    else options.cancelled();
  });
}
