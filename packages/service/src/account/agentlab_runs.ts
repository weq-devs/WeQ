export interface CloneConversationTarget {
  kind: 'persona' | 'group';
  id: string;
}

interface ConversationRun {
  controller: AbortController;
  done: Promise<unknown>;
}

/** 每段克隆对话独立停止；删除等待所有生成和派生写入收尾。 */
export class CloneConversationRuns {
  private readonly runs = new Map<string, Set<ConversationRun>>();
  private readonly deleting = new Set<string>();

  private key(target: CloneConversationTarget): string {
    return `${target.kind}:${target.id}`;
  }

  list(): CloneConversationTarget[] {
    return [...this.runs.keys()].map((key) => {
      const separator = key.indexOf(':');
      return { kind: key.slice(0, separator) as 'persona' | 'group', id: key.slice(separator + 1) };
    });
  }

  start<T>(
    targets: CloneConversationTarget[],
    operation: (signal: AbortSignal) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    const keys = targets.map((target) => this.key(target));
    if (keys.some((key) => this.deleting.has(key)))
      return Promise.reject(new Error('克隆对话正在永久删除'));
    const controller = new AbortController();
    const signal = parentSignal
      ? AbortSignal.any([controller.signal, parentSignal])
      : controller.signal;
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const done = new Promise<T>((success, failure) => {
      resolve = success;
      reject = failure;
    });
    const run = { controller, done };
    for (const key of keys) {
      const bucket = this.runs.get(key) ?? new Set<ConversationRun>();
      bucket.add(run);
      this.runs.set(key, bucket);
    }
    const finish = (): void => {
      for (const key of keys) {
        const bucket = this.runs.get(key);
        bucket?.delete(run);
        if (!bucket?.size) this.runs.delete(key);
      }
    };
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation(signal);
      })
      .then(
        (value) => {
          finish();
          resolve(value);
        },
        (error: unknown) => {
          finish();
          reject(error);
        },
      );
    return done;
  }

  async stopAndDelete<T>(
    target: CloneConversationTarget,
    remove: () => T | Promise<T>,
  ): Promise<T> {
    const key = this.key(target);
    if (this.deleting.has(key)) throw new Error('克隆对话正在永久删除');
    this.deleting.add(key);
    try {
      while (this.runs.get(key)?.size) {
        const pending = [...(this.runs.get(key) ?? [])];
        for (const run of pending)
          run.controller.abort(new DOMException('克隆对话已停止', 'AbortError'));
        await Promise.allSettled(pending.map((run) => run.done));
      }
      return await remove();
    } finally {
      this.deleting.delete(key);
    }
  }

  async close(): Promise<void> {
    const pending = new Set([...this.runs.values()].flatMap((bucket) => [...bucket]));
    for (const run of pending) run.controller.abort(new DOMException('账号已关闭', 'AbortError'));
    await Promise.allSettled([...pending].map((run) => run.done));
  }
}
