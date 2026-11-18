export class AssistantToolTimeoutError extends Error {}

/** 超时只取消当前调用；即使下游不响应 signal，助手也不再等待它。 */
export async function withAssistantToolDeadline<T>(
  run: (signal: AbortSignal) => T | Promise<T>,
  ms: number,
  label: string,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const timer = setTimeout(
    () => controller.abort(new AssistantToolTimeoutError(`${label}超时（${ms / 1000} 秒）`)),
    ms,
  );
  let onAbort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([
      stopped,
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return run(signal);
      }),
    ]);
    signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
