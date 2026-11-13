let uninstall: (() => void) | undefined;

/** 仅上报主应用异常，不镜像 console；重装先清除旧监听。 */
export function installDevelopmentErrors(
  target: Window,
  enabled: boolean,
  report: (level: 'error' | 'warn', message: string, context: object) => void,
): () => void {
  uninstall?.();
  if (!enabled) return () => {};
  const send = (level: 'error' | 'warn', message: string, context: object) => {
    try {
      report(level, message, context);
    } catch {
      /* 上报失败不改变浏览器原本的异常行为。 */
    }
  };
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeCount = 0;
  const reportResize = (count: number) =>
    send('warn', '界面尺寸监听循环，部分通知延后交付', {
      scope: 'renderer',
      event: 'renderer-resize-observer-loop',
      count,
    });
  const record = (kind: string, error: unknown, source: object = {}) =>
    send('error', '前端未处理异常', {
      scope: 'renderer',
      event: kind,
      ...source,
      ...(error instanceof Error
        ? { errorName: error.name, errorMessage: error.message, errorStack: error.stack }
        : {
            errorName:
              kind === 'renderer-unhandled-rejection' ? 'NonErrorRejection' : 'NonErrorException',
            errorMessage: typeof error === 'string' ? error.slice(0, 1000) : '非 Error 异常',
          }),
    });
  const onError = (event: ErrorEvent) => {
    // Chromium 会附带当前文档 URL，但没有异常对象和代码行列；真实代码异常仍按 error 处理。
    if (
      event.error == null &&
      !event.lineno &&
      !event.colno &&
      (event.message === 'ResizeObserver loop completed with undelivered notifications.' ||
        event.message === 'ResizeObserver loop limit exceeded')
    ) {
      if (resizeTimer === undefined) {
        resizeTimer = setTimeout(() => {
          resizeTimer = undefined;
          const count = resizeCount;
          resizeCount = 0;
          if (count) reportResize(count);
        }, 60_000);
        reportResize(1);
      } else resizeCount++;
      return;
    }
    record('renderer-uncaught', event.error ?? event.message, {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  };
  const onRejection = (event: PromiseRejectionEvent) =>
    record('renderer-unhandled-rejection', event.reason);
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  const dispose = () => {
    clearTimeout(resizeTimer);
    resizeTimer = undefined;
    if (resizeCount) reportResize(resizeCount);
    resizeCount = 0;
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
    if (uninstall === dispose) uninstall = undefined;
  };
  uninstall = dispose;
  return dispose;
}
