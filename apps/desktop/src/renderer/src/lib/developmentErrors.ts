let uninstall: (() => void) | undefined;

/** 仅上报主应用异常，不镜像 console；重装先清除旧监听。 */
export function installDevelopmentErrors(
  target: Window,
  enabled: boolean,
  report: (level: 'error', message: string, context: object) => void,
): () => void {
  uninstall?.();
  if (!enabled) return () => {};
  const record = (kind: string, error: unknown) => {
    try {
      report('error', '前端未处理异常', {
        scope: 'renderer',
        event: kind,
        ...(error instanceof Error
          ? { errorName: error.name, errorMessage: error.message, errorStack: error.stack }
          : {
              errorName: 'NonErrorRejection',
              errorMessage: typeof error === 'string' ? error.slice(0, 1000) : '非 Error 异常',
            }),
      });
    } catch {
      /* 上报失败不改变浏览器原本的异常行为。 */
    }
  };
  const onError = (event: ErrorEvent) => record('renderer-uncaught', event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) =>
    record('renderer-unhandled-rejection', event.reason);
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  const dispose = () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
    if (uninstall === dispose) uninstall = undefined;
  };
  uninstall = dispose;
  return dispose;
}
