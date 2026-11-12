export type CalendarKind =
  | 'c2c'
  | 'group'
  | 'dataline'
  | 'official'
  | 'service'
  | 'guild'
  | 'persona'
  | 'cloneGroup'
  | 'assistant';
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
  progress?: CalendarScanProgress;
}
export interface CalendarScanProgress {
  phase: string;
  processed: number;
  total?: number;
  unit: string;
  recordsScanned?: number;
}
export interface CalendarLogLine {
  ts: number;
  seq: number;
  stage: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}
export const CALENDAR_LOG_LIMIT = 200;
export interface CalendarSource {
  kind: CalendarKind;
  count?(start: number, end: number): Promise<number | null>;
  page(start: number, end: number, cursor: unknown, limit: number): Promise<CalendarBatch>;
}
export const CALENDAR_CACHE_BYTES = 8 * 1024 * 1024;
export const CALENDAR_BATCH_SIZE = 256;
export const CALENDAR_SOURCE_ORDER: readonly CalendarKind[] = [
  'c2c',
  'group',
  'dataline',
  'official',
  'service',
  'guild',
  'persona',
  'cloneGroup',
  'assistant',
];
export const CALENDAR_SOURCE_LABELS: Record<CalendarKind, string> = {
  c2c: '私聊',
  group: '群聊',
  dataline: '我的设备',
  official: '公众号',
  service: '服务号',
  guild: '频道私聊',
  persona: '好友克隆',
  cloneGroup: '克隆群聊',
  assistant: 'WeQ 助手会话',
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
export function calendarToday(now = Date.now()): string {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
export function filterCalendarTargets(
  targets: readonly CalendarTarget[],
  scope: 'all' | 'real' | 'virtual' | 'guild',
  query: string,
): CalendarTarget[] {
  const needle = query.trim().toLocaleLowerCase();
  const unique = new Map<string, CalendarTarget>();
  for (const target of targets) {
    const virtual =
      target.kind === 'persona' || target.kind === 'cloneGroup' || target.kind === 'assistant';
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
  generation: number;
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
  progress?: CalendarScanProgress;
  refresh?: Work;
}

export type CalendarControlAction = 'pause' | 'continue' | 'retry';
export type CalendarControlState = 'running' | 'paused' | 'complete' | 'failed' | 'empty';
export interface CalendarSavedWork {
  kind: CalendarKind;
  day: string;
  counted: boolean;
  detailed: boolean;
  count: number;
  cursor?: unknown;
  limit: number;
  failures: number;
  error?: string;
  progress?: CalendarScanProgress;
  fallback: boolean;
  rows: Array<{ key: string; count: number; anchor: CalendarAnchor }>;
  refresh?: CalendarSavedWork;
}
export interface CalendarCheckpoint {
  schema: 1;
  month: string;
  day?: string;
  kinds: CalendarKind[];
  monthPaused: boolean;
  pausedDays: string[];
  work: CalendarSavedWork[];
  logs?: CalendarLogLine[];
  scan?: { day: string; kind: CalendarKind };
  dayFocus?: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function cursorValue(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (value === undefined || value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 2048;
  if (typeof value === 'number') return Number.isFinite(value);
  return (
    record(value) &&
    Object.keys(value).length <= 16 &&
    Object.entries(value).every(
      ([key, item]) => key !== '__proto__' && cursorValue(item, depth + 1),
    )
  );
}

/** 单个弹窗的可续查任务；调用方控制调度和 lease，不建立常驻统计服务。 */
export class ConversationCalendarJob {
  controller = new AbortController();
  private enabled = new Set<CalendarKind>(CALENDAR_SOURCE_ORDER);
  private monthPaused = false;
  private dayFocus: string | undefined;
  private readonly pausedDays = new Set<string>();
  persistenceError: string | undefined;
  get day(): string | undefined {
    return this.selectedDay;
  }
  private needsWork(task: Work): boolean {
    return (
      Boolean(task.refresh) || !task.counted || (task.day === this.selectedDay && !task.detailed)
    );
  }
  private nextWork(): Work | undefined {
    const pending = this.work.filter(
      (task) =>
        this.available(task) &&
        this.needsWork(task) &&
        !this.pausedDays.has(task.day) &&
        (!this.monthPaused || task.day === this.dayFocus) &&
        !(task.refresh ?? task).error,
    );
    return (
      pending.find((task) => task.refresh) ??
      pending.find((task) => task.day === this.selectedDay) ??
      pending[0]
    );
  }
  control(scope: 'month' | 'day', action: CalendarControlAction, day?: string): void {
    if (
      scope === 'day' &&
      (!day ||
        !calendarMonthDays(this.month).some((item) => item.day === day) ||
        day > calendarToday())
    )
      throw new Error('请选择不晚于今天的本月日期');
    if (action === 'pause') {
      if (scope === 'month') {
        this.dayFocus =
          this.activeWork?.day ??
          this.snapshot(this.selectedDay).scanDayProgress?.day ??
          this.selectedDay;
        this.monthPaused = true;
      } else {
        this.dayFocus = day;
        this.pausedDays.add(day!);
      }
    } else if (action === 'continue') {
      if (scope === 'month') {
        this.monthPaused = false;
      } else {
        this.dayFocus = day;
        this.pausedDays.delete(day!);
      }
    } else {
      if (scope === 'month') {
        this.monthPaused = false;
      } else {
        this.dayFocus = day;
        this.pausedDays.delete(day!);
      }
      for (const task of this.work) {
        if (!this.available(task) || (scope === 'day' && task.day !== day)) continue;
        if (task.refresh) this.releaseRows(task.refresh);
        task.generation++;
        task.error = undefined;
        task.refresh = {
          ...task,
          counted: false,
          detailed: false,
          count: 0,
          cursor: undefined,
          rows: new Map(),
          progress: undefined,
          failures: 0,
          error: undefined,
          refresh: undefined,
        };
      }
    }
    const label = { pause: '暂停', continue: '继续', retry: '重新获取' }[action];
    this.log(
      'info',
      'task',
      `${label}${scope === 'month' ? this.month : day}统计${action === 'retry' ? '，保留原结果直到该来源读取完成' : ''}`,
    );
  }
  checkpoint(): CalendarCheckpoint {
    const save = (task: Work): CalendarSavedWork => ({
      kind: task.source.kind,
      day: task.day,
      counted: task.counted,
      detailed: task.detailed,
      count: task.count,
      cursor: task.cursor,
      limit: task.limit,
      failures: task.failures,
      error: task.error,
      progress: task.progress,
      fallback: !task.source.count,
      rows: [...task.rows].map(([key, row]) => ({ key, count: row.count, anchor: row.anchor })),
      refresh: task.refresh ? save(task.refresh) : undefined,
    });
    return {
      schema: 1,
      month: this.month,
      day: this.selectedDay,
      kinds: [...this.enabled],
      monthPaused: this.monthPaused,
      pausedDays: [...this.pausedDays],
      work: this.work.map(save),
      logs: [...this.logs],
      scan: this.lastScan ? { day: this.lastScan.day, kind: this.lastScan.source.kind } : undefined,
      dayFocus: this.dayFocus,
    };
  }
  restore(raw: unknown): boolean {
    // 先校验全部来源、行和双缓冲预算，再一次性恢复，坏检查点不能部分覆盖结果。
    if (
      !record(raw) ||
      raw.schema !== 1 ||
      raw.month !== this.month ||
      typeof raw.monthPaused !== 'boolean' ||
      !Array.isArray(raw.kinds) ||
      raw.kinds.length > CALENDAR_SOURCE_ORDER.length ||
      !raw.kinds.every((kind) => CALENDAR_SOURCE_ORDER.some((known) => known === kind)) ||
      !Array.isArray(raw.pausedDays) ||
      raw.pausedDays.length > 31 ||
      !Array.isArray(raw.work) ||
      raw.work.length > this.work.length
    )
      return false;
    const days = new Set(calendarMonthDays(this.month).map((item) => item.day));
    const scanValue = raw.scan;
    const scan = record(scanValue)
      ? this.work.find((task) => task.day === scanValue.day && task.source.kind === scanValue.kind)
      : undefined;
    if (raw.scan !== undefined && !scan) return false;
    if (
      raw.logs !== undefined &&
      (!Array.isArray(raw.logs) ||
        raw.logs.length > CALENDAR_LOG_LIMIT ||
        !raw.logs.every(
          (line) =>
            record(line) &&
            natural(line.ts) &&
            natural(line.seq) &&
            typeof line.stage === 'string' &&
            line.stage.length <= 64 &&
            typeof line.level === 'string' &&
            ['info', 'warn', 'error'].includes(line.level) &&
            typeof line.text === 'string' &&
            line.text.length <= 512,
        ))
    )
      return false;
    if (
      (raw.day !== undefined && (typeof raw.day !== 'string' || !days.has(raw.day))) ||
      (raw.dayFocus !== undefined &&
        (typeof raw.dayFocus !== 'string' || !days.has(raw.dayFocus))) ||
      !raw.pausedDays.every((day) => typeof day === 'string' && days.has(day))
    )
      return false;
    const saved: Array<[Work, Work]> = [];
    let bytes = 0;
    const load = (value: unknown, base: Work, nested = false): Work | undefined => {
      if (
        !record(value) ||
        value.kind !== base.source.kind ||
        value.day !== base.day ||
        typeof value.counted !== 'boolean' ||
        typeof value.detailed !== 'boolean' ||
        !natural(value.count) ||
        !natural(value.limit) ||
        value.limit < 1 ||
        value.limit > CALENDAR_BATCH_SIZE ||
        !natural(value.failures) ||
        value.failures > 3 ||
        typeof value.fallback !== 'boolean' ||
        !Array.isArray(value.rows) ||
        value.rows.length > this.targets.size ||
        (value.error !== undefined &&
          (typeof value.error !== 'string' || value.error.length > 1024)) ||
        !cursorValue(value.cursor)
      )
        return undefined;
      const rows = new Map<string, CalendarRow>();
      for (const row of value.rows) {
        if (
          !record(row) ||
          typeof row.key !== 'string' ||
          !row.key.startsWith(`${base.source.kind}:`) ||
          !natural(row.count) ||
          row.count === 0 ||
          !record(row.anchor)
        )
          return undefined;
        const target = this.targets.get(row.key),
          anchor = row.anchor;
        if (
          !target ||
          rows.has(row.key) ||
          typeof anchor.id !== 'string' ||
          anchor.id.length > 256 ||
          typeof anchor.seq !== 'string' ||
          anchor.seq.length > 64 ||
          typeof anchor.time !== 'number' ||
          !Number.isFinite(anchor.time) ||
          anchor.time < base.start ||
          anchor.time >= base.end ||
          (anchor.sessionId !== undefined &&
            anchor.sessionId !== null &&
            typeof anchor.sessionId !== 'string')
        )
          return undefined;
        rows.set(row.key, {
          target,
          count: row.count,
          anchor: {
            id: anchor.id,
            seq: anchor.seq,
            time: anchor.time,
            sessionId: anchor.sessionId as string | null | undefined,
          },
        });
        bytes += 512 + target.name.length * 2;
      }
      if (
        value.detailed &&
        (!value.counted ||
          [...rows.values()].reduce((sum, row) => sum + row.count, 0) !== value.count)
      )
        return undefined;
      const result: Work = {
        ...base,
        counted: value.counted,
        detailed: value.detailed,
        count: value.count,
        cursor: value.cursor,
        limit: value.limit,
        failures: value.failures,
        error: value.error as string | undefined,
        rows,
        progress: undefined,
        refresh: undefined,
        source: value.fallback ? { ...base.source, count: undefined } : base.source,
      };
      if (value.refresh !== undefined) {
        if (nested) return undefined;
        result.refresh = load(value.refresh, base, true);
        if (!result.refresh) return undefined;
      }
      return result;
    };
    const seen = new Set<string>();
    for (const value of raw.work) {
      if (!record(value)) return false;
      const key = `${value.day}:${value.kind}`;
      const base = this.work.find(
        (task) => task.day === value.day && task.source.kind === value.kind,
      );
      if (!base || seen.has(key)) return false;
      seen.add(key);
      const loaded = load(value, base);
      if (!loaded) return false;
      saved.push([base, loaded]);
    }
    if (this.bytes + bytes > CALENDAR_CACHE_BYTES || (this.reserve && !this.reserve(bytes)))
      return false;
    for (const [base, loaded] of saved) Object.assign(base, loaded);
    const restoredOrder = new Set(saved.map(([base]) => base));
    this.work.splice(
      0,
      this.work.length,
      ...saved.map(([base]) => base),
      ...this.work.filter((task) => !restoredOrder.has(task)),
    );
    this.lastScan = scan ? (scan.refresh ?? scan) : undefined;
    this.bytes += bytes;
    this.enabled = new Set(raw.kinds as CalendarKind[]);
    this.monthPaused = raw.monthPaused;
    for (const day of raw.pausedDays) this.pausedDays.add(day as string);
    this.selectedDay = raw.day as string | undefined;
    this.dayFocus = (raw.dayFocus ?? (scan ? scan.day : raw.day)) as string | undefined;
    if (Array.isArray(raw.logs)) {
      this.logs.splice(0, this.logs.length, ...(raw.logs as CalendarLogLine[]));
      this.logSeq = this.logs.reduce((max, line) => Math.max(max, line.seq), 0);
      this.lastLogKey = undefined;
    }
    this.log('info', 'task', '已恢复持久化统计结果与进度');
    return true;
  }
  private readState: { state: 'idle' | 'queued' | 'reading'; since: number } | undefined;
  observeState(state: 'idle' | 'queued' | 'reading' | undefined): void {
    this.readState = state ? { state, since: Date.now() } : undefined;
    const task = this.activeWork;
    if (task && state && this.enabled.has(task.source.kind)) {
      const label = {
        idle: '等待数据库空闲',
        queued: '等待前序数据库查询结束',
        reading: '正在读取数据库',
      }[state];
      this.log(
        'info',
        task.source.kind,
        `${task.day} · ${CALENDAR_SOURCE_LABELS[task.source.kind]}｜${label}；已计 ${task.count.toLocaleString('zh-CN')} 条消息`,
        `${task.day}:${task.source.kind}:progress`,
      );
    }
  }
  setKinds(kinds: CalendarKind[]): void {
    if (kinds.length === this.enabled.size && kinds.every((kind) => this.enabled.has(kind))) return;
    this.enabled = new Set(kinds);
    this.log('info', 'task', '统计内容已更新');
  }
  get inBackground(): boolean {
    return this.background;
  }
  resume(): void {
    if (this.running) throw new Error('旧统计读取尚未结束');
    if (this.controller.signal.aborted) this.controller = new AbortController();
  }
  invalidate(): void {
    this.control('month', 'retry');
  }
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
  private available(task: Work): boolean {
    return this.enabled.has(task.source.kind) && task.day <= calendarToday();
  }
  private selectedDay: string | undefined;
  private running: Promise<void> | undefined;
  private leaseTimer: ReturnType<typeof setTimeout> | undefined;
  private leaseUntil = Date.now() + 5000;
  private background = false;
  private bytes = 0;
  private readonly order = new Map<string, Map<string, number>>();
  private orderSequence = 0;
  private activeWork: Work | undefined;
  private lastScan: Work | undefined;
  private readonly logs: CalendarLogLine[] = [];
  private logSeq = 0;
  private lastLogKey: string | undefined;
  private log(level: CalendarLogLine['level'], stage: string, text: string, key?: string): void {
    const previous = this.logs.at(-1);
    const row = {
      ts: Date.now(),
      seq: previous && key && key === this.lastLogKey ? previous.seq : ++this.logSeq,
      stage,
      level,
      text: text.slice(0, 512),
    };
    if (previous && key && key === this.lastLogKey) this.logs[this.logs.length - 1] = row;
    else {
      this.logs.push(row);
      if (this.logs.length > CALENDAR_LOG_LIMIT) this.logs.shift();
    }
    this.lastLogKey = key;
    this.onProgress?.();
  }
  private logWork(task: Work): void {
    const progress = task.progress;
    const phase = progress?.phase ?? '读取统计信息';
    const count = task.count.toLocaleString('zh-CN');
    const scanned = progress
      ? `；已处理 ${progress.processed.toLocaleString('zh-CN')}${progress.total !== undefined ? `/${progress.total.toLocaleString('zh-CN')}` : ''} ${progress.unit}${progress.recordsScanned !== undefined ? `，已读 ${progress.recordsScanned.toLocaleString('zh-CN')} 条元数据` : ''}`
      : '';
    this.log(
      task.error ? 'warn' : 'info',
      task.source.kind,
      `${task.day} · ${CALENDAR_SOURCE_LABELS[task.source.kind]} · ${phase}｜已计 ${count} 条消息${scanned}；${task.error ?? (task.detailed || (task.counted && task.day !== this.selectedDay) ? '完成' : '进行中')}`,
      task.error ? undefined : `${task.day}:${task.source.kind}:progress`,
    );
  }
  noteWaiting(): void {
    if (!this.controller.signal.aborted) this.observeState('idle');
  }
  constructor(
    readonly month: string,
    targets: CalendarTarget[],
    sources: CalendarSource[],
    private readonly reserve?: (bytes: number) => boolean,
    private readonly onProgress?: () => void,
  ) {
    this.targets = new Map(targets.map((target) => [calendarTargetKey(target), target]));
    this.bytes =
      new TextEncoder().encode(JSON.stringify(targets)).byteLength + CALENDAR_LOG_LIMIT * 1536;
    if (this.bytes > CALENDAR_CACHE_BYTES || (reserve && !reserve(this.bytes)))
      throw new Error('日历会话范围超过缓存上限');
    const days = calendarMonthDays(month).reverse();
    this.work = days.flatMap((day) =>
      [...sources]
        .sort(
          (a, b) => CALENDAR_SOURCE_ORDER.indexOf(a.kind) - CALENDAR_SOURCE_ORDER.indexOf(b.kind),
        )
        .map((source) => ({
          generation: 0,
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
    this.log(
      'info',
      'task',
      `创建 ${month} 会话统计｜${this.targets.size.toLocaleString('zh-CN')} 个会话，${sources.length} 类来源，${days.length} 个日期`,
    );
  }
  keepAlive(day?: string, retry = false): void {
    if (day && day > calendarToday()) day = undefined;
    this.leaseUntil = Date.now() + 5000;
    clearTimeout(this.leaseTimer);
    if (!this.background)
      this.leaseTimer = setTimeout(() => {
        if (this.running) this.cancel();
      }, 5000);
    if (day !== this.selectedDay) {
      this.dayFocus = day;
      this.log(
        'info',
        'task',
        day ? `优先统计 ${day}；完成后继续统计截至今天的其他日期` : '继续统计本月日期',
      );
      if (day)
        this.work.sort((a, b) => {
          if (a.day === b.day)
            return (
              CALENDAR_SOURCE_ORDER.indexOf(a.source.kind) -
              CALENDAR_SOURCE_ORDER.indexOf(b.source.kind)
            );
          if (a.day === day) return -1;
          if (b.day === day) return 1;
          const aPast = a.day < day,
            bPast = b.day < day;
          if (aPast !== bPast) return aPast ? -1 : 1;
          return aPast ? b.day.localeCompare(a.day) : a.day.localeCompare(b.day);
        });
    }
    this.selectedDay = day;
    if (retry)
      for (const work of this.work) {
        work.error = undefined;
        work.failures = 0;
      }
    this.start();
  }
  continueInBackground(): void {
    if (this.controller.signal.aborted) throw new Error('日历任务已停止，请重新打开日历');
    this.background = true;
    clearTimeout(this.leaseTimer);
    this.log('info', 'task', `${this.month} 统计转入后台，继续为前台读取让路`);
    this.start();
  }
  cancel(): void {
    if (this.controller.signal.aborted) return;
    if (
      this.work.some(
        (task) => !task.counted || task.error || (task.day === this.selectedDay && !task.detailed),
      )
    )
      this.log('info', 'task', '停止统计，保留已经完成的计数和日志');
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
    return !this.controller.signal.aborted && (this.background || Date.now() < this.leaseUntil);
  }
  private start(): void {
    if (this.running || this.controller.signal.aborted) return;
    const next = this.nextWork();
    if (!next) {
      clearTimeout(this.leaseTimer);
      return;
    }
    this.running = this.run().finally(() => {
      this.running = undefined;
      this.activeWork = undefined;
      this.readState = undefined;
      clearTimeout(this.leaseTimer);
      if (!this.controller.signal.aborted) {
        const available = this.work.filter((task) => this.available(task));
        const done = available.filter((task) => task.counted && !task.error).length;
        const failed = available.filter((task) => task.error).length;
        const paused =
          this.monthPaused ||
          available.some((task) => this.needsWork(task) && this.pausedDays.has(task.day));
        this.log(
          failed ? 'warn' : 'info',
          'task',
          `${paused ? '统计已暂停' : failed ? '部分统计已暂停' : '本轮统计完成'}｜完成 ${done}/${available.length} 个日期来源${failed ? `，${failed} 个未完成` : ''}`,
        );
      }
    });
  }
  async settled(): Promise<void> {
    await this.running;
  }
  private releaseRows(task: Work): void {
    for (const row of task.rows.values()) {
      this.bytes -= 512 + row.target.name.length * 2;
    }
    task.rows.clear();
  }
  private async run(): Promise<void> {
    while (this.current()) {
      const owner = this.nextWork();
      if (!owner) return;
      const task = owner.refresh ?? owner;
      const generation = owner.generation;
      if (this.activeWork !== task)
        this.log(
          'info',
          task.source.kind,
          `${task.day} · ${CALENDAR_SOURCE_LABELS[task.source.kind]}｜开始读取`,
        );
      this.activeWork = task;
      this.lastScan = task;
      const began = performance.now();
      try {
        if (
          !task.counted &&
          !task.cursor &&
          !task.rows.size &&
          !owner.refresh &&
          task.day !== this.selectedDay &&
          task.source.count
        ) {
          const count = await task.source.count(task.start, task.end);
          if (!this.current()) return;
          if (owner.generation !== generation) continue;
          if (count !== null) {
            task.count = count;
            task.counted = true;
            continue;
          }
        }
        const page = await task.source.page(task.start, task.end, task.cursor, task.limit);
        if (!this.current()) return;
        if (owner.generation !== generation) continue;
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
        task.progress = page.progress;
        task.failures = 0;
        if (!task.counted || page.done)
          task.count = [...task.rows.values()].reduce((sum, row) => sum + row.count, 0);
        if (page.done) {
          task.counted = true;
          task.detailed = true;
          if (owner.refresh === task) {
            this.releaseRows(owner);
            Object.assign(owner, task, { refresh: undefined });
          }
        }
      } catch (error) {
        if (!this.current()) return;
        if (owner.generation !== generation) continue;
        if (error instanceof Error && error.name === 'AbortError') {
          this.cancel();
          return;
        }
        if (/database_query_(execution|wait)_timeout/.test(String(error))) {
          this.metrics.timeouts++;
          // 计数超预算后直接进入可续查元数据路径，不反复重跑同一条 COUNT。
          task.source = { ...task.source, count: undefined };
          task.limit = Math.max(1, Math.floor(task.limit / 2));
          this.log(
            'warn',
            task.source.kind,
            `${task.day} · ${CALENDAR_SOURCE_LABELS[task.source.kind]}｜读取超出预算，缩小到每批 ${task.limit} 条后续查，已完成计数不清零`,
          );
          if (++task.failures < 3) continue;
        }
        task.error = /timeout/.test(String(error))
          ? '读取超出预算，统计已暂停'
          : error instanceof Error
            ? error.message
            : '统计失败';
        this.metrics.pauses++;
      } finally {
        if (this.current()) this.logWork(task);
        this.metrics.batches++;
        this.metrics.maxBatchMs = Math.max(this.metrics.maxBatchMs, performance.now() - began);
        await new Promise<void>((done) => setTimeout(done, 20));
      }
    }
    this.cancel();
  }
  snapshot(day?: string, offset = 0, includeLogs = false, limit = 50) {
    const enabledWork = this.work.filter((item) => this.available(item));
    const emptyReason = !this.enabled.size
      ? '未选择统计内容'
      : !enabledWork.length
        ? '当前范围没有可统计的来源'
        : undefined;
    const days = calendarMonthDays(this.month).map(({ day: value }) => {
      const work = enabledWork.filter((item) => item.day === value);
      return {
        day: value,
        unavailable: value > calendarToday(),
        paused: this.pausedDays.has(value),
        count: work.reduce((sum, item) => sum + item.count, 0),
        complete:
          value > calendarToday() || (work.length > 0 && work.every((item) => item.counted)),
        emptyReason: value > calendarToday() ? undefined : emptyReason,
        errors: [
          ...new Set(
            work.flatMap((item) =>
              [item.error, item.refresh?.error].filter((value): value is string => Boolean(value)),
            ),
          ),
        ],
      };
    });
    const work = enabledWork.filter((item) => item.day === day);
    const pausedDay =
      enabledWork.find(
        (item) =>
          this.needsWork(item) && this.pausedDays.has(item.day) && item.day === this.dayFocus,
      ) ?? enabledWork.find((item) => this.needsWork(item) && this.pausedDays.has(item.day));
    const scanDay =
      this.activeWork && this.available(this.activeWork)
        ? this.activeWork.day
        : this.monthPaused && this.dayFocus
          ? this.dayFocus
          : !this.nextWork() && pausedDay
            ? pausedDay.day
            : this.lastScan && this.available(this.lastScan)
              ? this.lastScan.day
              : undefined;
    const scanWork = enabledWork.filter((item) => item.day === scanDay);
    if (day && !days.some((value) => value.day === day)) throw new Error('日历日期无效');
    const complete = day
      ? work.length > 0 && work.every((item) => item.detailed)
      : enabledWork.length > 0 && enabledWork.every((item) => item.counted);
    const rows = work.flatMap((item) => [...item.rows.values()]);
    const state = (scope?: string): CalendarControlState => {
      if (!enabledWork.some((item) => !scope || item.day === scope)) return 'empty';
      const pending = enabledWork.filter(
        (item) => (!scope || item.day === scope) && this.needsWork(item),
      );
      if (scope && this.pausedDays.has(scope)) return 'paused';
      if (!pending.length) return 'complete';
      if (this.controller.signal.aborted || (!scope && this.monthPaused)) return 'paused';
      const failures = scope ? pending : pending.filter((item) => !this.pausedDays.has(item.day));
      return failures.length > 0 && failures.every((item) => (item.refresh ?? item).error)
        ? 'failed'
        : 'running';
    };
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
      emptyReason,
      controls: {
        month: { state: state(), disabled: !enabledWork.length },
        day: {
          state: state(scanDay ?? day),
          disabled: !enabledWork.some((item) => item.day === (scanDay ?? day)),
        },
      },
      hasPending: enabledWork.some((item) => this.needsWork(item)),
      canRun: !this.controller.signal.aborted && Boolean(this.nextWork()),
      refreshing: enabledWork.some((item) => Boolean(item.refresh)),
      persistenceError: this.persistenceError,
      enabledKinds: [...this.enabled],
      scanDayProgress: scanDay
        ? {
            day: scanDay,
            completedSources: scanWork.filter((item) =>
              item.day === this.selectedDay ? item.detailed : item.counted,
            ).length,
            totalSources: scanWork.length,
            count: scanWork.reduce((sum, item) => sum + item.count, 0),
          }
        : undefined,
      readState: this.activeWork && this.available(this.activeWork) ? this.readState : undefined,
      days,
      progress: {
        completedSources: enabledWork.filter((item) => item.counted && !item.error).length,
        totalSources: enabledWork.length,
        failedSources: enabledWork.filter((item) => item.error || item.refresh?.error).length,
      },
      logs: includeLogs ? [...this.logs] : undefined,
      activeScan:
        this.activeWork &&
        this.available(this.activeWork) &&
        this.current() &&
        !this.activeWork.error
          ? {
              day: this.activeWork.day,
              kind: this.activeWork.source.kind,
              progress: this.activeWork.progress,
            }
          : undefined,
      dayProgress: day
        ? {
            paused: this.pausedDays.has(day),
            completedSources: work.filter((item) => item.detailed).length,
            totalSources: work.length,
            count: work.reduce((sum, item) => sum + item.count, 0),
          }
        : undefined,
      rows: rows.slice(offset, offset + limit),
      totalRows: rows.length,
      complete,
      cancelled: this.controller.signal.aborted,
      metrics: { ...this.metrics },
    };
  }
}
