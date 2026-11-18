interface ImageRequest<T, Output> {
  controller: AbortController;
  waiters: Set<{ output?: (value: Output) => void }>;
  promise: Promise<T>;
  settled: boolean;
}

/** 同图推理共享实际请求，每个调用者独立退出等待。 */
export class ImageRecognitionRequests<T, Output = never> {
  private readonly pending = new Map<string, ImageRequest<T, Output>>();

  has(key: string): boolean {
    return this.pending.has(key);
  }

  async run(
    key: string,
    execute: (
      signal: AbortSignal,
      output: (value: Output) => void,
      current: () => boolean,
    ) => Promise<T>,
    options: { signal?: AbortSignal; output?: (value: Output) => void; refresh?: boolean } = {},
  ): Promise<T> {
    const { signal, output, refresh = false } = options;
    signal?.throwIfAborted();
    let request = this.pending.get(key);
    if (!request || refresh) {
      const controller = new AbortController();
      const waiters: ImageRequest<T, Output>['waiters'] = new Set();
      const current = () => this.pending.get(key)?.controller === controller;
      const promise = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return execute(
            controller.signal,
            (value) => {
              for (const waiter of waiters) {
                try {
                  waiter.output?.(value);
                } catch {
                  // 观察输出的调用者不应中断共享推理。
                }
              }
            },
            current,
          );
        })
        .finally(() => {
          created.settled = true;
          if (current()) this.pending.delete(key);
        });
      const created = { controller, waiters, promise, settled: false };
      request = created;
      this.pending.set(key, request);
    }
    const active = request;
    return new Promise<T>((resolve, reject) => {
      const waiter = { output };
      const release = () => {
        signal?.removeEventListener('abort', abort);
        active.waiters.delete(waiter);
      };
      const abort = () => {
        release();
        if (!active.settled && !active.waiters.size) {
          if (this.pending.get(key) === active) this.pending.delete(key);
          active.controller.abort(signal?.reason);
        }
        reject(signal?.reason);
      };
      active.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      void active.promise.then(
        (value) => {
          release();
          resolve(value);
        },
        (error) => {
          release();
          reject(error);
        },
      );
    });
  }
}
