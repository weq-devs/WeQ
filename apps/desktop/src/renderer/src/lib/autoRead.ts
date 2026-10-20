/** 只供幂等读取使用；切换页面或来源时同时取消等待与后续尝试。 */
export async function readWithRetry<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const value = await work();
      signal.throwIfAborted();
      return value;
    } catch (error) {
      if (signal.aborted || attempt >= 2) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        const timer = setTimeout(
          () => {
            signal.removeEventListener('abort', abort);
            resolve();
          },
          1000 * 2 ** attempt,
        );
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}
