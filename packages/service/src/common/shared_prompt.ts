/** A shared dialog has independent callers; cancel its display only when none remain. */
export class SharedPrompt<T> {
  private active: { waiters: Set<{ finish(value: T): void }>; cleanup?: () => void } | null = null;
  constructor(private readonly cancelled: T) {}

  request(open: (settle: (value: T) => void) => () => void, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.resolve(this.cancelled);
    const first = this.active === null;
    const session = this.active ?? { waiters: new Set<{ finish(value: T): void }>() };
    this.active = session;
    const settle = (value: T): void => {
      if (this.active !== session) return;
      this.active = null;
      for (const waiter of [...session.waiters]) waiter.finish(value);
      session.cleanup?.();
    };
    const result = new Promise<T>((resolve) => {
      let done = false;
      const waiter = {
        finish: (value: T): void => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', cancel);
          session.waiters.delete(waiter);
          resolve(value);
        },
      };
      const cancel = (): void => {
        waiter.finish(this.cancelled);
        if (session.waiters.size === 0) settle(this.cancelled);
      };
      session.waiters.add(waiter);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    if (first) {
      try {
        const cleanup = open(settle);
        if (this.active === session) session.cleanup = cleanup;
        else cleanup();
      } catch {
        settle(this.cancelled);
      }
    }
    return result;
  }
}
