import { setTimeout as wait } from 'node:timers/promises';
import { automaticAiRestricted, watchTransferPolicy } from '../common/transfer_policy';

export interface CloneConversationTarget {
  kind: 'persona' | 'group';
  id: string;
}

/** 省流量期间只保留每个对象最近的派生工作，限制解除后逐个处理。 */
export class DeferredCloneLearning {
  private readonly pending = new Map<
    string,
    {
      targets: CloneConversationTarget[];
      work: (signal: AbortSignal) => Promise<void>;
    }
  >();
  private unwatch?: () => void;
  private draining = false;

  constructor(private readonly runs: CloneConversationRuns) {}

  defer(
    key: string,
    targets: CloneConversationTarget[],
    work: (signal: AbortSignal) => Promise<void>,
  ) {
    if (!automaticAiRestricted() && !this.pending.has(key)) return false;
    this.pending.set(key, { targets, work });
    this.unwatch ??= watchTransferPolicy(() => void this.drain());
    void this.drain();
    return true;
  }

  discard(target: CloneConversationTarget) {
    for (const [key, job] of this.pending)
      if (job.targets.some(({ kind, id }) => kind === target.kind && id === target.id))
        this.pending.delete(key);
    if (this.pending.size === 0) this.unwatchEmpty();
  }

  close() {
    this.pending.clear();
    this.unwatchEmpty();
  }

  private unwatchEmpty() {
    this.unwatch?.();
    this.unwatch = undefined;
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const [key, { targets, work }] of this.pending) {
        if (automaticAiRestricted()) break;
        this.pending.delete(key);
        await this.runs.start(targets, work).catch(() => undefined);
      }
    } finally {
      this.draining = false;
      if (this.pending.size === 0) this.unwatchEmpty();
    }
  }
}

interface ConversationRun {
  controller: AbortController;
  done: Promise<unknown>;
}

/** 每段克隆对话独立停止；删除等待所有生成和派生写入收尾。 */
export class CloneConversationRuns {
  private readonly runs = new Map<string, Set<ConversationRun>>();
  private readonly deleting = new Set<string>();
  private closed = false;

  assertOpen(target: CloneConversationTarget) {
    if (this.closed) throw new Error('账号已关闭');
    if (this.deleting.has(this.key(target))) throw new Error('克隆对话正在永久删除');
  }

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
    try {
      for (const target of targets) this.assertOpen(target);
    } catch (error) {
      return Promise.reject(error);
    }
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
    this.closed = true;
    const pending = new Set([...this.runs.values()].flatMap((bucket) => [...bucket]));
    for (const run of pending) run.controller.abort(new DOMException('账号已关闭', 'AbortError'));
    await Promise.allSettled([...pending].map((run) => run.done));
  }
}

/** 合并连续输入，只让仍有效的回复写入；消息本身在调用前已经保存。 */
export class CloneReplyWindow {
  private readonly active = new Map<
    string,
    {
      controller: AbortController;
      burstStart: number;
      started: boolean;
      typing: boolean;
    }
  >();

  constructor(private readonly runs: CloneConversationRuns) {}

  isTyping(target: CloneConversationTarget): boolean {
    return this.active.get(`${target.kind}:${target.id}`)?.typing ?? false;
  }

  interrupt(target: CloneConversationTarget) {
    this.active.get(`${target.kind}:${target.id}`)?.controller.abort();
  }

  respond(
    target: CloneConversationTarget,
    operation: (signal: AbortSignal, typing: (value: boolean) => void) => Promise<void>,
    onTyping: (value: boolean) => void,
    onError: (error: unknown) => void,
    onSettled: () => void,
  ): void {
    const key = `${target.kind}:${target.id}`;
    const previous = this.active.get(key);
    const now = Date.now();
    const current = {
      controller: new AbortController(),
      burstStart: previous && !previous.started ? previous.burstStart : now,
      started: false,
      typing: false,
    };
    this.active.set(key, current);
    previous?.controller.abort();
    if (previous?.typing) onTyping(false);
    const typing = (value: boolean) => {
      if (this.active.get(key) !== current || current.typing === value) return;
      if (value && current.controller.signal.aborted) return;
      current.typing = value;
      onTyping(value);
    };
    void this.runs
      .start(
        [target],
        async (signal) => {
          await wait(
            Math.max(0, Math.min(550, current.burstStart + 1300 - Date.now())),
            undefined,
            { signal },
          );
          signal.throwIfAborted();
          current.started = true;
          await operation(signal, typing);
        },
        current.controller.signal,
      )
      .catch((error: unknown) => {
        if (
          !current.controller.signal.aborted &&
          !(error instanceof Error && error.name === 'AbortError')
        )
          onError(error);
      })
      .finally(() => {
        if (this.active.get(key) !== current) return;
        typing(false);
        this.active.delete(key);
        onSettled();
      });
  }
}
