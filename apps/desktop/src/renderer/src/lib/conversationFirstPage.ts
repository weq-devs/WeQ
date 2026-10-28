import type { MessagePageStage, MessageReadWindow } from '../../../shared/message_read';

export interface FirstPageTarget {
  kind: 'c2c' | 'group';
  conv: string;
  limit: number;
}
export const firstPageKey = (target: FirstPageTarget) => `${target.kind}:${target.conv}`;

interface Job<T> {
  target: FirstPageTarget;
  window: MessageReadWindow;
  prefetch: boolean;
  adopted: boolean;
  partial?: T[];
  show?: (rows: T[]) => void;
  promise: Promise<T[]>;
  stop: () => void;
}

/** 至多一个在途读取；只为当前可见的三个目标准备首屏，点击直接接用同一读取。 */
export class ConversationFirstPage<T> {
  private current?: Job<T>;
  private visible: FirstPageTarget[] = [];
  private visibleKey = '';
  private intent?: FirstPageTarget;
  private selected = '';
  private enabled = false;
  private disposed = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly attempts = new Map<string, number>();
  constructor(
    private readonly options: {
      owner: string;
      fresh: (target: FirstPageTarget) => boolean;
      subscribe: (
        target: FirstPageTarget,
        window: MessageReadWindow,
        prefetch: boolean,
        stage: (value: MessagePageStage<T>) => void,
        error: (error: unknown) => void,
      ) => () => void;
      promote: (window: MessageReadWindow) => void;
      cancel: (window: MessageReadWindow) => void;
      store: (target: FirstPageTarget, rows: T[], prefetch: boolean) => void;
      valid: () => boolean;
      version: () => number;
    },
  ) {}

  activate(enabled: boolean, selected: string): void {
    this.disposed = false;
    this.enabled = enabled;
    this.selected = selected;
    const job = this.current;
    if (
      job &&
      ((job.adopted && firstPageKey(job.target) !== selected) || (!enabled && !job.adopted))
    )
      job.stop();
    if (enabled) this.schedule(300);
    else if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
  setVisible(targets: readonly FirstPageTarget[]): void {
    const unique = [
      ...new Map(targets.map((target) => [firstPageKey(target), target])).values(),
    ].slice(0, 3);
    const key = JSON.stringify(unique.map(firstPageKey));
    if (key === this.visibleKey) return;
    this.visible = unique;
    this.visibleKey = key;
    const intent = this.intent;
    if (intent && !targets.some((target) => firstPageKey(target) === firstPageKey(intent)))
      this.intent = undefined;
    const current = this.current;
    if (
      current &&
      !current.adopted &&
      !targets.some((target) => firstPageKey(target) === firstPageKey(current.target))
    )
      current.stop();
    if (this.enabled) this.schedule(300);
  }
  hint(target: FirstPageTarget): void {
    if (!this.enabled || firstPageKey(target) === this.selected) return;
    this.intent = target;
    this.schedule(80);
  }
  read(target: FirstPageTarget, show: (rows: T[]) => void): Promise<T[]> {
    if (this.disposed || !this.options.valid())
      return Promise.reject(new DOMException('会话读取已取消', 'AbortError'));
    this.selected = firstPageKey(target);
    if (
      this.current &&
      (firstPageKey(this.current.target) !== this.selected ||
        this.current.target.limit !== target.limit)
    )
      this.current.stop();
    const job = this.current ?? this.start(target, false);
    const adopted = job.adopted;
    job.adopted = true;
    job.show = show;
    if (job.prefetch && !adopted) this.options.promote(job.window);
    if (job.partial?.length) show([...job.partial]);
    return job.promise.then((rows) => [...rows]);
  }
  dispose(): void {
    this.disposed = true;
    this.current?.stop();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.visible = [];
    this.visibleKey = '';
    this.intent = undefined;
    this.attempts.clear();
  }
  interrupt(): void {
    this.current?.stop();
  }
  private schedule(delay: number): void {
    if (this.disposed || !this.enabled) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, delay);
  }
  private pump(): void {
    if (!this.enabled || this.disposed || !this.options.valid()) return;
    const candidates = this.intent ? [this.intent, ...this.visible] : this.visible;
    const target = candidates.find(
      (candidate) =>
        firstPageKey(candidate) !== this.selected &&
        !this.options.fresh(candidate) &&
        Date.now() - (this.attempts.get(firstPageKey(candidate)) ?? -Infinity) >= 15_000,
    );
    if (!target || this.current?.adopted) return;
    if (this.current) {
      if (!this.intent || firstPageKey(this.current.target) === firstPageKey(target)) return;
      this.current.stop();
    }
    this.intent = undefined;
    this.attempts.delete(firstPageKey(target));
    this.attempts.set(firstPageKey(target), Date.now());
    if (this.attempts.size > 16) this.attempts.delete(this.attempts.keys().next().value!);
    this.start(target, true);
  }
  private start(target: FirstPageTarget, prefetch: boolean): Job<T> {
    const window = { owner: this.options.owner, generation: ++this.generation };
    const version = this.options.version();
    let resolve!: (rows: T[]) => void;
    let reject!: (error: unknown) => void;
    let unsubscribe: (() => void) | undefined;
    const release = () => {
      const stop = unsubscribe;
      unsubscribe = undefined;
      stop?.();
    };
    let finished = false;
    const job: Job<T> = {
      target,
      window,
      prefetch,
      adopted: !prefetch,
      promise: new Promise<T[]>((done, fail) => {
        resolve = done;
        reject = fail;
      }),
      stop: () => {
        if (finished) return;
        finished = true;
        release();
        this.options.cancel(window);
        reject(new DOMException('会话读取已取消', 'AbortError'));
        if (this.current === job) this.current = undefined;
      },
    };
    this.current = job;
    void job.promise
      .catch(() => {})
      .finally(() => {
        release();
        if (this.current === job) this.current = undefined;
        this.schedule(300);
      });
    try {
      unsubscribe = this.options.subscribe(
        target,
        window,
        prefetch,
        (stage) => {
          if (finished || this.current !== job || !this.options.valid()) return;
          if (!stage.complete) {
            job.partial = stage.rows;
            job.show?.([...stage.rows]);
            return;
          }
          finished = true;
          const rows = stage.reuseLocal ? job.partial : stage.rows;
          if (!rows) {
            reject(new Error('缺少可复用的本地首屏'));
            return;
          }
          try {
            if (version === this.options.version()) this.options.store(target, rows, prefetch);
          } catch {
            /* 缓存失败不阻断正文交付。 */
          }
          resolve(rows);
        },
        (error) => {
          if (!finished) {
            finished = true;
            reject(error);
          }
        },
      );
      if (finished) release();
    } catch (error) {
      finished = true;
      reject(error);
    }
    return job;
  }
}
