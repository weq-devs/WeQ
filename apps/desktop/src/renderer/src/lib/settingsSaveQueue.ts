export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/** 每个编辑目标只保留最新草稿；请求严格串行，失败不自动重试。 */
export class SettingsSaveQueue<T> {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private inFlightValue?: string;
  private next?: { value: T; save: (value: T) => Promise<void> };
  private baseline: string;
  private revision = 0;
  private blocked = false;
  status: SaveStatus = 'idle';
  error = '';
  constructor(
    initial: T,
    private changed: () => void = () => {},
  ) {
    this.baseline = JSON.stringify(initial);
  }
  private publish(status: SaveStatus, error = '') {
    this.status = status;
    this.error = error;
    this.changed();
  }
  edit(value: T, valid: boolean, save: (value: T) => Promise<void>, delay: number | null = 600) {
    if (this.blocked) return;
    clearTimeout(this.timer);
    this.revision++;
    this.next =
      valid && JSON.stringify(value) !== (this.inFlightValue ?? this.baseline)
        ? { value, save }
        : undefined;
    this.publish(this.running ? 'saving' : this.next ? 'pending' : 'idle');
    if (this.next && delay !== null) this.timer = setTimeout(() => void this.flush(), delay);
  }
  async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.blocked) return true;
    if (this.running) {
      await this.running;
      if (this.status === 'error') return false;
      return this.flush();
    }
    const work = this.next;
    if (!work) return this.status !== 'error';
    this.next = undefined;
    const revision = this.revision;
    this.inFlightValue = JSON.stringify(work.value);
    this.publish('saving');
    const run = async () => {
      try {
        await work.save(work.value);
        this.baseline = JSON.stringify(work.value);
        if (this.next && JSON.stringify(this.next.value) === this.baseline) this.next = undefined;
        this.publish(this.next ? 'pending' : 'saved');
      } catch (reason) {
        clearTimeout(this.timer);
        // 失败后保留最新输入；没有新输入时保留刚失败的提交。
        if (revision === this.revision) this.next = work;
        this.publish('error', reason instanceof Error ? reason.message : String(reason));
      }
    };
    this.running = run();
    await this.running;
    this.running = undefined;
    this.inFlightValue = undefined;
    this.changed();
    if (this.status === 'error') return false;
    return this.next ? this.flush() : true;
  }
  async suspend() {
    this.blocked = true;
    clearTimeout(this.timer);
    this.next = undefined;
    this.revision++;
    await this.running;
    clearTimeout(this.timer);
    this.next = undefined;
  }
  reset(value: T) {
    this.blocked = false;
    clearTimeout(this.timer);
    this.next = undefined;
    this.baseline = JSON.stringify(value);
    this.publish('idle');
  }
  observe(value: T) {
    if (!this.dirty) this.baseline = JSON.stringify(value);
  }
  release() {
    this.blocked = false;
  }
  cancelPending() {
    clearTimeout(this.timer);
    this.next = undefined;
    this.revision++;
    if (this.status === 'pending') this.publish('idle');
  }
  get dirty() {
    return !!this.running || !!this.next || this.status === 'saving' || this.status === 'error';
  }
}

export const settingsSaves = new Set<{
  flush: () => Promise<boolean>;
  readonly pending: boolean;
}>();
export function hasPendingSettingsSaves() {
  return [...settingsSaves].some((save) => save.pending);
}
export async function flushSettingsSaves() {
  const saved = (await Promise.all([...settingsSaves].map((save) => save.flush()))).every(Boolean);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return saved;
}
