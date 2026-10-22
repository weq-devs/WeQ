interface QuitEventSource<E extends string> {
  on(event: E, listener: () => void): unknown;
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
  app.on('before-quit', run);
  // 更新安装先关闭窗口，再发普通 before-quit；必须提前放行窗口 close。
  updater.on('before-quit-for-update', run);
}
