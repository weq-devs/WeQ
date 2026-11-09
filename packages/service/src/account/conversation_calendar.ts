export type CalendarKind =
  | 'c2c'
  | 'group'
  | 'dataline'
  | 'official'
  | 'service'
  | 'guild'
  | 'persona'
  | 'cloneGroup';
export interface CalendarTarget {
  kind: CalendarKind;
  conv: string;
  name: string;
  avatar: string | null;
  ancestors: string[];
  hiddenIds?: Record<string, string[]>;
  searchText?: string;
  listingSearchText?: string;
}
export interface CalendarAnchor {
  id: string;
  seq: string;
  time: number;
  sessionId?: string | null;
}
export interface CalendarRow {
  target: CalendarTarget;
  count: number;
  anchor: CalendarAnchor;
}
export interface CalendarBatch {
  rows: Array<{ conv: string; time: number; anchor: CalendarAnchor }>;
  cursor?: unknown;
  done: boolean;
}
export interface CalendarSource {
  kind: CalendarKind;
  count?(start: number, end: number): Promise<number | null>;
  page(start: number, end: number, cursor: unknown, limit: number): Promise<CalendarBatch>;
}
export const CALENDAR_CACHE_BYTES = 8 * 1024 * 1024;
export const CALENDAR_BATCH_SIZE = 256;
export const CALENDAR_SOURCE_LABELS: Record<CalendarKind, string> = {
  c2c: '私聊',
  group: '群聊',
  dataline: '数据线',
  official: '公众号',
  service: '服务号',
  guild: '频道私聊',
  persona: '好友克隆',
  cloneGroup: '克隆群聊',
};
export function calendarTargetKey(target: Pick<CalendarTarget, 'kind' | 'conv'>): string {
  return `${target.kind}:${target.conv}`;
}
function compareMessageIds(a: string, b: string): number {
  if (/^-?\d+$/.test(a) && /^-?\d+$/.test(b)) return BigInt(a) < BigInt(b) ? -1 : a === b ? 0 : 1;
  return a.localeCompare(b);
}
export function calendarMonthDays(
  month: string,
): Array<{ day: string; start: number; end: number }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1970)
    throw new Error('日历月份无效');
  const [year, mon] = month.split('-').map(Number);
  const length = new Date(Date.UTC(year!, mon!, 0)).getUTCDate();
  return Array.from({ length }, (_, index) => {
    const day = `${month}-${String(index + 1).padStart(2, '0')}`;
    const start = Date.parse(`${day}T00:00:00+08:00`) / 1000;
    return { day, start, end: start + 86400 };
  });
}
export function filterCalendarTargets(
  targets: readonly CalendarTarget[],
  scope: 'all' | 'real' | 'virtual' | 'guild',
  query: string,
): CalendarTarget[] {
  const needle = query.trim().toLocaleLowerCase();
  const unique = new Map<string, CalendarTarget>();
  for (const target of targets) {
    const virtual = target.kind === 'persona' || target.kind === 'cloneGroup';
    if (
      (scope === 'real' && (virtual || target.kind === 'guild')) ||
      (scope === 'virtual' && !virtual) ||
      (scope === 'guild' && target.kind !== 'guild')
    )
      continue;
    const text =
      scope === 'guild' && target.kind === 'guild'
        ? target.searchText
        : (target.listingSearchText ?? target.searchText);
    if (needle && text !== undefined && !text.includes(needle)) continue;
    if (
      text === undefined &&
      needle &&
      ![target.name, target.conv, ...target.ancestors].some((value) =>
        value.toLocaleLowerCase().includes(needle),
      )
    )
      continue;
    unique.set(calendarTargetKey(target), target);
  }
  return [...unique.values()];
}

interface Work {
  source: CalendarSource;
  day: string;
  start: number;
  end: number;
  counted: boolean;
  detailed: boolean;
  count: number;
  cursor?: unknown;
  limit: number;
  failures: number;
  error?: string;
  rows: Map<string, CalendarRow>;
}

/** 单个弹窗的可续查任务；调用方控制调度和 lease，不建立常驻统计服务。 */
export class ConversationCalendarJob {
  readonly controller = new AbortController();
  readonly metrics = {
    batches: 0,
    timeouts: 0,
    pauses: 0,
    maxBatchMs: 0,
    reads: 0,
    maxNativeAwaitMs: 0,
  };
  observeRead(milliseconds: number): void {
    this.metrics.reads++;
    this.metrics.maxNativeAwaitMs = Math.max(this.metrics.maxNativeAwaitMs, milliseconds);
  }
  private readonly targets: Map<string, CalendarTarget>;
  private readonly work: Work[];
  private selectedDay: string | undefined;
  private running: Promise<void> | undefined;
  private leaseTimer: ReturnType<typeof setTimeout> | undefined;
  private leaseUntil = Date.now() + 5000;
  private bytes = 0;
  private readonly order = new Map<string, Map<string, number>>();
  private orderSequence = 0;
  constructor(
    readonly month: string,
    targets: CalendarTarget[],
    sources: CalendarSource[],
    private readonly reserve?: (bytes: number) => boolean,
  ) {
    this.targets = new Map(targets.map((target) => [calendarTargetKey(target), target]));
    this.bytes = new TextEncoder().encode(JSON.stringify(targets)).byteLength;
    if (this.bytes > CALENDAR_CACHE_BYTES || (reserve && !reserve(this.bytes)))
      throw new Error('日历会话范围超过缓存上限');
    const days = calendarMonthDays(month).reverse();
    this.work = days.flatMap((day) =>
      sources.map((source) => ({
        ...day,
        source,
        counted: false,
        detailed: false,
        count: 0,
        limit: CALENDAR_BATCH_SIZE,
        failures: 0,
        rows: new Map(),
      })),
    );
  }
  keepAlive(day?: string, retry = false): void {
    this.leaseUntil = Date.now() + 5000;
    clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => {
      if (this.running) this.cancel();
    }, 5000);
    if (day !== this.selectedDay)
      for (const task of this.work) {
        if (task.day !== day && task.counted && task.detailed) this.clearDetails(task);
      }
    this.selectedDay = day;
    if (retry)
      for (const work of this.work) {
        work.error = undefined;
        work.failures = 0;
      }
    this.start();
  }
  cancel(): void {
    clearTimeout(this.leaseTimer);
    this.controller.abort();
  }
  get memoryBytes(): number {
    return this.bytes;
  }
  anchor(target: CalendarTarget, id: string): CalendarAnchor | undefined {
    const key = calendarTargetKey(target);
    return this.work.flatMap((work) => {
      const row = work.rows.get(key);
      return row?.anchor.id === id ? [row.anchor] : [];
    })[0];
  }
  private current(): boolean {
    return !this.controller.signal.aborted && Date.now() < this.leaseUntil;
  }
  private start(): void {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
      clearTimeout(this.leaseTimer);
    });
  }
  async settled(): Promise<void> {
    await this.running;
  }
  private clearDetails(task: Work): void {
    for (const [key, row] of task.rows) {
      this.bytes -= 512 + row.target.name.length * 2;
      this.order.get(task.day)?.delete(key);
    }
    task.rows.clear();
    task.cursor = undefined;
    task.detailed = false;
  }
  private async run(): Promise<void> {
    while (this.current()) {
      const task =
        this.work.find((work) => work.day === this.selectedDay && !work.detailed && !work.error) ??
        this.work.find((work) => !work.counted && !work.error);
      if (!task) return;
      const began = performance.now();
      try {
        if (
          !task.counted &&
          !task.cursor &&
          !task.rows.size &&
          task.day !== this.selectedDay &&
          task.source.count
        ) {
          const count = await task.source.count(task.start, task.end);
          if (!this.current()) return;
          if (count !== null) {
            task.count = count;
            task.counted = true;
            continue;
          }
        }
        const page = await task.source.page(task.start, task.end, task.cursor, task.limit);
        if (!this.current()) return;
        const applicable = page.rows.filter(
          (message) => message.time >= task.start && message.time < task.end,
        );
        const newKeys = new Set(
          applicable.map((message) =>
            calendarTargetKey({ kind: task.source.kind, conv: message.conv }),
          ),
        );
        let addedBytes = 0;
        for (const key of newKeys) {
          const target = this.targets.get(key);
          if (target && !task.rows.has(key)) addedBytes += 512 + target.name.length * 2;
        }
        if (
          this.bytes + addedBytes > CALENDAR_CACHE_BYTES ||
          (this.reserve && !this.reserve(addedBytes))
        )
          throw new Error('日历缓存已达上限，请缩小会话范围后重试');
        for (const message of applicable) {
          if (message.time < task.start || message.time >= task.end) continue;
          const key = calendarTargetKey({ kind: task.source.kind, conv: message.conv });
          const target = this.targets.get(key);
          if (!target) continue;
          const previous = task.rows.get(key);
          if (previous) {
            previous.count++;
            if (
              message.time < previous.anchor.time ||
              (message.time === previous.anchor.time &&
                compareMessageIds(message.anchor.id, previous.anchor.id) < 0)
            )
              previous.anchor = message.anchor;
          } else {
            this.bytes += 512 + target.name.length * 2;
            task.rows.set(key, { target, count: 1, anchor: message.anchor });
            let order = this.order.get(task.day);
            if (!order) {
              order = new Map();
              this.order.set(task.day, order);
            }
            if (!order.has(key)) order.set(key, this.orderSequence++);
          }
        }
        task.cursor = page.cursor;
        task.failures = 0;
        if (!task.counted || page.done)
          task.count = [...task.rows.values()].reduce((sum, row) => sum + row.count, 0);
        if (page.done) {
          task.counted = true;
          task.detailed = true;
          if (task.day !== this.selectedDay) this.clearDetails(task);
        }
      } catch (error) {
        if (!this.current()) return;
        if (error instanceof Error && error.name === 'AbortError') {
          this.cancel();
          return;
        }
        if (/database_query_(execution|wait)_timeout/.test(String(error))) {
          this.metrics.timeouts++;
          // 计数超预算后直接进入可续查元数据路径，不反复重跑同一条 COUNT。
          task.source = { ...task.source, count: undefined };
          task.limit = Math.max(1, Math.floor(task.limit / 2));
          if (++task.failures < 3) continue;
        }
        task.error = /timeout/.test(String(error))
          ? '统计已暂停，点击重试'
          : error instanceof Error
            ? error.message
            : '统计失败';
        this.metrics.pauses++;
      } finally {
        this.metrics.batches++;
        this.metrics.maxBatchMs = Math.max(this.metrics.maxBatchMs, performance.now() - began);
        await new Promise<void>((done) => setTimeout(done, 20));
      }
    }
    this.cancel();
  }
  snapshot(day?: string, offset = 0) {
    const days = calendarMonthDays(this.month).map(({ day: value }) => {
      const work = this.work.filter((item) => item.day === value);
      return {
        day: value,
        count: work.reduce((sum, item) => sum + item.count, 0),
        complete: work.every((item) => item.counted),
        errors: [...new Set(work.flatMap((item) => (item.error ? [item.error] : [])))],
      };
    });
    const work = this.work.filter((item) => item.day === day);
    if (day && !days.some((value) => value.day === day)) throw new Error('日历日期无效');
    const complete = work.every((item) => item.detailed);
    const rows = work.flatMap((item) => [...item.rows.values()]);
    if (complete)
      rows.sort(
        (a, b) =>
          b.count - a.count ||
          a.target.name.localeCompare(b.target.name, 'zh-CN') ||
          calendarTargetKey(a.target).localeCompare(calendarTargetKey(b.target)),
      );
    else
      rows.sort(
        (a, b) =>
          (this.order.get(day ?? '')?.get(calendarTargetKey(a.target)) ?? 0) -
          (this.order.get(day ?? '')?.get(calendarTargetKey(b.target)) ?? 0),
      );
    return {
      days,
      rows: rows.slice(offset, offset + 50),
      totalRows: rows.length,
      complete,
      cancelled: this.controller.signal.aborted,
      metrics: { ...this.metrics },
    };
  }
}
