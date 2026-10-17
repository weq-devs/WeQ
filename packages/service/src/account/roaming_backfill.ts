/** Manual roaming jobs: exact observed coverage, durable queues, no automatic restart. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { writeFileAtomicSync } from '../common/atomic_write';
import type { BackfillSeqWindow } from './export/msg_backfill';
import type { GapFetchedMessage, GapFetchResult } from './gap_history';

export interface RoamingInterval {
  start: number;
  end: number;
}
export interface RoamingTarget {
  kind: 'group' | 'c2c';
  conv: string;
  name: string;
}
export interface RoamingJobOptions {
  /** 旧通道值仅为读取原断点保留；旧 sso30 可按原小窗继续，聚合/SDK 任务不迁移。 */
  transport?: 'sso' | 'sso30' | 'native500' | 'sso500';
  nativeBinding?: string;
  targets: RoamingTarget[];
  range?: { start?: number; end?: number };
  beforeOldest: boolean;
  intervalMs: number;
  /** 仅保留旧断点的字段与校验和；不再限制请求数。 */
  maxRequests?: number;
}
export type RoamingJobStatus =
  | 'planned'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'partial'
  | 'completed'
  | 'cancelled'
  | 'failed';
export interface RoamingTargetPlan extends RoamingTarget {
  snapshot: { hash: string; count: number; oldest: string | null; newest: string | null };
  ranges: RoamingInterval[];
  remaining: RoamingInterval[];
  pending: RoamingInterval[];
}
export interface RoamingAttempt {
  id: string;
  at: number;
  target: string;
  start: number;
  end: number;
  outcome: 'cache' | 'observed' | 'empty' | 'error';
  observed: number;
  network: boolean;
  detail?: string;
}
export interface RoamingJob {
  id: string;
  source: string;
  optionsHash: string;
  options: RoamingJobOptions;
  createdAt: number;
  updatedAt: number;
  status: RoamingJobStatus;
  targets: RoamingTargetPlan[];
  requests: number;
  checkedWindows: number;
  protocolPages?: number;
  cacheWindows: number;
  observed: number;
  errors: number;
  unparsedOrEmpty: number;
  attempts: RoamingAttempt[];
  inFlight?: { target: string; start: number; end: number; at: number };
  note?: string;
}
export interface RoamingBackfillDeps {
  source: string;
  listSeqWindow(
    target: RoamingTarget,
    range?: RoamingJobOptions['range'],
  ): Promise<BackfillSeqWindow>;
  cached(target: RoamingTarget, start: number, end: number): Promise<GapFetchedMessage[]>;
  fetch(
    target: RoamingTarget,
    start: number,
    end: number,
    signal: AbortSignal,
    intervalMs: number,
    beforeRequest: () => void,
  ): Promise<GapFetchResult>;
  retain(messages: GapFetchedMessage[]): Promise<void>;
  checkOnline(transport?: RoamingJobOptions['transport']): void;
  onMessages?(target: RoamingTarget, messages: GapFetchedMessage[]): void;
}

const MAX_SEQ = 0xffffffff;
const statuses: RoamingJobStatus[] = [
  'planned',
  'running',
  'pausing',
  'paused',
  'partial',
  'completed',
  'cancelled',
  'failed',
];
const flights = new Map<string, Promise<void>>();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (target: RoamingTarget) => `${target.kind}:${target.conv}`;
const copy = <T>(value: T): T => structuredClone(value);
const validCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validAnchor = (value: unknown) =>
  value === null ||
  (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number(value) <= MAX_SEQ);

export function mergeRoamingIntervals(intervals: readonly RoamingInterval[]): RoamingInterval[] {
  const result: RoamingInterval[] = [];
  for (const item of [...intervals].sort((a, b) => a.start - b.start)) {
    if (
      !Number.isInteger(item.start) ||
      !Number.isInteger(item.end) ||
      item.start < 1 ||
      item.end > MAX_SEQ ||
      item.start > item.end
    )
      throw new Error('漫游区间无效。');
    const tail = result.at(-1);
    if (tail && item.start <= tail.end + 1) tail.end = Math.max(tail.end, item.end);
    else result.push({ ...item });
  }
  return result;
}

export function subtractRoamingIntervals(
  input: readonly RoamingInterval[],
  covered: readonly RoamingInterval[],
): RoamingInterval[] {
  const cuts = mergeRoamingIntervals(covered);
  const result: RoamingInterval[] = [];
  let index = 0;
  for (const interval of mergeRoamingIntervals(input)) {
    let cursor = interval.start;
    while (index < cuts.length && cuts[index]!.end < cursor) index++;
    for (let i = index; i < cuts.length && cuts[i]!.start <= interval.end; i++) {
      const cut = cuts[i]!;
      if (cut.start > cursor) result.push({ start: cursor, end: cut.start - 1 });
      cursor = Math.max(cursor, cut.end + 1);
      if (cursor > interval.end) break;
    }
    if (cursor <= interval.end) result.push({ start: cursor, end: interval.end });
  }
  return result;
}

const count = (ranges: readonly RoamingInterval[]) =>
  ranges.reduce((n, r) => n + r.end - r.start + 1, 0);
function sequencePlan(window: BackfillSeqWindow, beforeOldest: boolean) {
  if (
    [...window.seqs, window.below, window.above].some(
      (seq) => seq !== null && seq > BigInt(MAX_SEQ),
    )
  )
    throw new Error('本地序号超出当前漫游通道的 uint32 范围，未生成补全计划。');
  const seqs = [
    ...new Set(
      [...window.seqs, window.below, window.above].filter(
        (seq): seq is bigint => seq !== null && seq > 0n && seq <= BigInt(MAX_SEQ),
      ),
    ),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ranges: RoamingInterval[] = [];
  if (beforeOldest && window.below === null && seqs[0] && seqs[0] > 1n)
    ranges.push({ start: 1, end: Number(seqs[0] - 1n) });
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i]! - seqs[i - 1]! > 1n)
      ranges.push({ start: Number(seqs[i - 1]! + 1n), end: Number(seqs[i]! - 1n) });
  }
  return {
    ranges,
    seqs,
    snapshot: {
      hash: digest(seqs.map(String)),
      count: seqs.length,
      oldest: seqs[0]?.toString() ?? null,
      newest: seqs.at(-1)?.toString() ?? null,
    },
  };
}

export function roamingJobSummary(job: RoamingJob) {
  const planned = job.targets.reduce((n, t) => n + count(t.ranges), 0);
  const remaining = job.targets.reduce((n, t) => n + count(t.remaining), 0);
  const pending = job.targets.reduce((n, t) => n + count(t.pending), 0);
  const { targets, ...metadata } = job;
  return {
    ...copy(metadata),
    targets: targets.map((target) => ({
      kind: target.kind,
      conv: target.conv,
      name: target.name,
      snapshot: copy(target.snapshot),
      plannedSeqs: count(target.ranges),
      remainingSeqs: count(target.remaining),
      pendingSeqs: count(target.pending),
    })),
    plannedSeqs: planned,
    remainingSeqs: remaining,
    pendingSeqs: pending,
    estimatedWindows: job.targets.reduce(
      (n, t) =>
        n +
        t.pending.reduce(
          (m, r) =>
            m +
            (job.options.transport === 'native500' || job.options.transport === 'sso500'
              ? r.end - r.start + 1
              : Math.ceil((r.end - r.start + 1) / 30)),
          0,
        ),
      0,
    ),
    coverage: 'observed-only' as const,
  };
}

function validateOptions(options: RoamingJobOptions): void {
  if (
    (options.transport !== undefined &&
      !['sso', 'sso30', 'native500', 'sso500'].includes(options.transport)) ||
    (options.transport === 'native500' && !/^[a-f0-9]{64}$/.test(options.nativeBinding ?? '')) ||
    !Array.isArray(options.targets) ||
    !options.targets.length ||
    options.targets.some(
      (t) =>
        !['group', 'c2c'].includes(t.kind) ||
        !t.conv ||
        !t.name ||
        (t.kind === 'group'
          ? !/^[1-9]\d*$/.test(t.conv) || !Number.isSafeInteger(Number(t.conv))
          : !/^u_[A-Za-z0-9_-]{1,125}$/.test(t.conv)),
    ) ||
    new Set(options.targets.map(key)).size !== options.targets.length ||
    !Number.isInteger(options.intervalMs) ||
    options.intervalMs < 500 ||
    options.intervalMs > 60000 ||
    (options.maxRequests !== undefined &&
      (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1)) ||
    typeof options.beforeOldest !== 'boolean' ||
    [options.range?.start, options.range?.end].some(
      (v) => v !== undefined && (!Number.isSafeInteger(v) || v < 0),
    ) ||
    (options.range?.start !== undefined &&
      options.range?.end !== undefined &&
      options.range.start > options.range.end)
  )
    throw new Error('批量漫游任务选项无效。');
}

export class RoamingBackfillManager {
  private jobs: RoamingJob[] = [];
  private control: AbortController | null = null;
  private active: string | null = null;
  private planning = false;
  private disposed = false;
  private loadError: string | null = null;

  static async waitForIdle(path: string): Promise<void> {
    await flights.get(path);
  }

  constructor(
    private readonly path: string,
    private readonly deps: RoamingBackfillDeps,
  ) {
    try {
      this.load();
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  private load(): void {
    const path = this.path;
    if (existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as {
        version: number;
        jobs: RoamingJob[];
      };
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.jobs) ||
        saved.jobs.length > 10 ||
        new Set(saved.jobs.map((job) => job.id)).size !== saved.jobs.length
      )
        throw new Error('批量漫游断点文件无效，已保留原件。');
      for (const job of saved.jobs) {
        validateOptions(job.options);
        if (
          !statuses.includes(job.status) ||
          typeof job.id !== 'string' ||
          !job.id ||
          typeof job.source !== 'string' ||
          !job.source ||
          !validCount(job.createdAt) ||
          !validCount(job.updatedAt) ||
          (job.note !== undefined && typeof job.note !== 'string') ||
          job.optionsHash !== digest(job.options) ||
          !Array.isArray(job.targets) ||
          job.targets.length !== job.options.targets.length ||
          !Array.isArray(job.attempts) ||
          job.attempts.length > 200 ||
          [
            job.requests,
            job.checkedWindows,
            job.cacheWindows,
            job.observed,
            job.errors,
            job.unparsedOrEmpty,
          ].some((n) => !validCount(n)) ||
          (job.protocolPages !== undefined && !validCount(job.protocolPages))
        )
          throw new Error('批量漫游断点校验失败，已保留原件。');
        for (const [index, target] of job.targets.entries()) {
          const snapshot = target.snapshot;
          if (
            !snapshot ||
            !/^[a-f0-9]{64}$/.test(snapshot.hash) ||
            !validCount(snapshot.count) ||
            !validAnchor(snapshot.oldest) ||
            !validAnchor(snapshot.newest) ||
            (snapshot.count > 0
              ? snapshot.oldest === null ||
                snapshot.newest === null ||
                Number(snapshot.oldest) > Number(snapshot.newest)
              : snapshot.oldest !== null || snapshot.newest !== null)
          )
            throw new Error('批量漫游快照校验失败，已保留原件。');
          if (
            key(target) !== key(job.options.targets[index]!) ||
            target.name !== job.options.targets[index]!.name ||
            subtractRoamingIntervals(target.remaining, target.ranges).length ||
            subtractRoamingIntervals(target.pending, target.remaining).length
          )
            throw new Error('批量漫游断点区间不一致，已保留原件。');
        }
        if (job.inFlight) {
          mergeRoamingIntervals([job.inFlight]);
          if (
            !validCount(job.inFlight.at) ||
            !job.targets.some((target) => key(target) === job.inFlight!.target)
          )
            throw new Error('批量漫游在途断点校验失败，已保留原件。');
        }
        for (const attempt of job.attempts) {
          mergeRoamingIntervals([attempt]);
          if (
            typeof attempt.id !== 'string' ||
            !attempt.id ||
            !validCount(attempt.at) ||
            typeof attempt.target !== 'string' ||
            !validCount(attempt.observed) ||
            typeof attempt.network !== 'boolean' ||
            !['cache', 'observed', 'empty', 'error'].includes(attempt.outcome) ||
            (attempt.detail !== undefined && typeof attempt.detail !== 'string')
          )
            throw new Error('批量漫游回执校验失败，已保留原件。');
        }
        if (job.status === 'running' || job.status === 'pausing') {
          job.status = 'paused';
          job.note = '上次运行中断；继续前会复核本地记录和漫游缓存。';
        }
      }
      this.jobs = saved.jobs;
    }
  }

  list() {
    if (this.loadError) throw new Error(this.loadError);
    return this.jobs.map(roamingJobSummary).reverse();
  }
  running(): string | null {
    return this.active;
  }
  scanning(): boolean {
    return this.planning;
  }
  private save(): void {
    writeFileAtomicSync(this.path, JSON.stringify({ version: 1, jobs: this.jobs }));
  }
  private job(id: string) {
    const job = this.jobs.find((t) => t.id === id);
    if (!job || job.source !== this.deps.source || job.optionsHash !== digest(job.options))
      throw new Error('任务来源或选项不一致，不能续作。');
    return job;
  }
  private idle(): void {
    if (this.loadError) throw new Error(this.loadError);
    if (this.disposed || this.active || this.planning || flights.has(this.path))
      throw new Error('当前账号已有批量补全在运行或收尾。');
  }

  async plan(options: RoamingJobOptions) {
    this.idle();
    if (options.transport === 'native500') throw Error('SDK 历史通道已移除，请新建纯协议任务。');
    if (options.transport === 'sso500' || options.transport === 'sso30')
      throw Error('历史通道已统一为 SSO，请新建 SSO 任务。');
    validateOptions(options);
    options = { ...options, transport: 'sso' };
    this.planning = true;
    try {
      const targets: RoamingTargetPlan[] = [];
      for (const target of options.targets) {
        const plan = sequencePlan(
          await this.deps.listSeqWindow(target, options.range),
          options.beforeOldest,
        );
        if (this.disposed) throw new Error('账号已关闭。');
        targets.push({
          ...target,
          snapshot: plan.snapshot,
          ranges: plan.ranges,
          remaining: copy(plan.ranges),
          pending: copy(plan.ranges),
        });
      }
      const now = Date.now();
      const job: RoamingJob = {
        id: randomUUID(),
        source: this.deps.source,
        optionsHash: digest(options),
        options: copy(options),
        createdAt: now,
        updatedAt: now,
        status: 'planned',
        targets,
        requests: 0,
        checkedWindows: 0,
        cacheWindows: 0,
        observed: 0,
        errors: 0,
        unparsedOrEmpty: 0,
        attempts: [],
        note: '仅扫描本地锚点，未发起在线拉取。',
      };
      if (this.jobs.length >= 10) throw new Error('最多保留 10 个任务，请先移除已结束的任务。');
      this.jobs.push(job);
      try {
        this.save();
      } catch (e) {
        this.jobs.pop();
        throw e;
      }
      return roamingJobSummary(job);
    } finally {
      this.planning = false;
    }
  }

  start(id: string, retryRemaining = false) {
    this.idle();
    const job = this.job(id);
    this.assertSupportedTransport(job);
    if (job.status === 'cancelled' || job.status === 'completed')
      throw new Error('已结束的任务不能继续。');
    const previous = {
      status: job.status,
      note: job.note,
      updatedAt: job.updatedAt,
      pending: job.targets.map((target) => target.pending),
    };
    if (retryRemaining) for (const target of job.targets) target.pending = copy(target.remaining);
    job.status = 'running';
    job.note = '正在复核本地记录与候选缺口。';
    job.updatedAt = Date.now();
    try {
      this.save();
    } catch (error) {
      job.status = previous.status;
      job.note = previous.note;
      job.updatedAt = previous.updatedAt;
      for (const [index, target] of job.targets.entries())
        target.pending = previous.pending[index]!;
      throw error;
    }
    this.active = id;
    const controller = new AbortController();
    this.control = controller;
    const flight = this.run(job, controller.signal).finally(() => {
      this.active = null;
      this.control = null;
      flights.delete(this.path);
    });
    flights.set(this.path, flight);
    return roamingJobSummary(job);
  }

  pause(id: string, cancel = false) {
    const job = this.job(id);
    if (job.status === 'completed' || job.status === 'cancelled') return roamingJobSummary(job);
    job.status = this.active === id && !cancel ? 'pausing' : cancel ? 'cancelled' : 'paused';
    job.note =
      this.active === id
        ? '停止派发新请求，等待在途请求落盘。'
        : '任务已停止，可查看已取得的记录。';
    job.updatedAt = Date.now();
    if (this.active === id) this.control?.abort();
    this.save();
    return roamingJobSummary(job);
  }

  remove(id: string): void {
    this.idle();
    if (!this.jobs.some((job) => job.id === id)) throw new Error('任务不存在。');
    const previous = this.jobs;
    this.jobs = this.jobs.filter((job) => job.id !== id);
    try {
      this.save();
    } catch (e) {
      this.jobs = previous;
      throw e;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.active) this.pause(this.active);
  }

  private async run(job: RoamingJob, signal: AbortSignal): Promise<void> {
    let runRequests = 0;
    try {
      for (const target of job.targets) {
        if (signal.aborted) break;
        const local = sequencePlan(await this.deps.listSeqWindow(target, job.options.range), false);
        if (target.snapshot.count > 0 && local.seqs.length === 0)
          throw new Error('原计划的本地锚点已不可读，请重新扫描创建任务。');
        if (target.snapshot.hash !== local.snapshot.hash) {
          const full = sequencePlan(await this.deps.listSeqWindow(target), false);
          const present = new Set(full.seqs.map(String));
          if (
            [target.snapshot.oldest, target.snapshot.newest].some(
              (anchor) => anchor !== null && !present.has(anchor),
            )
          )
            throw new Error('原计划的边界锚点已变化，未继续拉取；请重新扫描创建任务。');
        }
        const localCoverage = local.seqs.map((seq) => ({ start: Number(seq), end: Number(seq) }));
        target.remaining = subtractRoamingIntervals(target.remaining, localCoverage);
        target.pending = subtractRoamingIntervals(target.pending, localCoverage);
        this.save();
        while (target.pending.length && !signal.aborted) {
          this.assertSupportedTransport(job);
          const tail = target.pending.at(-1)!;
          const window = {
            start: Math.max(tail.start, tail.end - 29),
            end: tail.end,
          };
          let examined = window;
          const cached = await this.deps.cached(target, window.start, window.end);
          const known = this.validRows(target, window, cached);
          const cachedCoverage = known.map((row) => ({
            start: Number(row.msgSeq),
            end: Number(row.msgSeq),
          }));
          const missing = subtractRoamingIntervals([window], cachedCoverage);
          let rows = known;
          let unresolved = 0;
          let network = false;
          let outcome: RoamingAttempt['outcome'] = 'cache';
          if (missing.length) {
            if (signal.aborted) break;
            try {
              this.deps.checkOnline(job.options.transport);
            } catch (error) {
              job.status = 'paused';
              job.note = error instanceof Error ? error.message : String(error);
              this.save();
              return;
            }
            let reserved = false;
            const result = await this.deps.fetch(
              target,
              window.start,
              window.end,
              signal,
              job.options.intervalMs,
              () => {
                if (reserved) throw Error('同一小窗重复预约，未派发请求。');
                const previous = job.inFlight;
                job.inFlight = { target: key(target), ...window, at: Date.now() };
                job.requests++;
                runRequests++;
                try {
                  this.save();
                } catch (error) {
                  job.requests--;
                  runRequests--;
                  job.inFlight = previous;
                  throw error;
                }
                reserved = true;
              },
            );
            network = result.networkRequested !== false;
            if (network !== reserved) throw Error('SSO 请求回执与预约不一致，窗口保留。');
            if (result.ok) {
              if (result.examinedStart !== undefined) {
                if (
                  !Number.isSafeInteger(result.examinedStart) ||
                  result.examinedStart < window.start ||
                  result.examinedStart > window.end
                )
                  throw Error('SSO 小窗检查边界无效，未推进窗口。');
                examined = { start: result.examinedStart, end: window.end };
              }
              if (result.unresolvedRecords !== undefined && !validCount(result.unresolvedRecords))
                throw Error('SSO 不完整观察计数无效，未推进窗口。');
              unresolved = result.unresolvedRecords ?? 0;
              const scope = window;
              const verified = this.validRows(target, scope, result.messages);
              if (result.messages.some((row) => this.validRows(target, scope, [row]).length !== 1))
                throw new Error('响应中存在会话、序号或身份未通过核验的记录，未推进窗口。');
              // A cache write must succeed before coverage or the task cursor advances.
              await this.deps.retain(verified);
              rows = this.validRows(target, scope, [...known, ...verified]);
              outcome = network ? (rows.length ? 'observed' : 'empty') : 'cache';
              if (!network) job.cacheWindows++;
              if (result.networkError) throw new Error(result.networkError);
            } else {
              if (signal.aborted && !network) {
                if (job.status !== 'cancelled') job.status = 'paused';
                job.note = '已停止；排队请求未发送，窗口保留。';
                delete job.inFlight;
                this.save();
                return;
              }
              if (!signal.aborted || network) job.errors++;
              if (job.status !== 'cancelled')
                job.status = result.reason === 'offline' || signal.aborted ? 'paused' : 'failed';
              job.note = result.message;
              job.attempts.push({
                id: randomUUID(),
                at: Date.now(),
                target: key(target),
                ...window,
                outcome: 'error',
                observed: 0,
                network,
                detail: result.message.slice(0, 500),
              });
              job.attempts = job.attempts.slice(-200);
              if (!result.unknown) delete job.inFlight;
              this.save();
              return;
            }
          } else {
            job.cacheWindows++;
          }
          const covered = rows.map((row) => ({
            start: Number(row.msgSeq),
            end: Number(row.msgSeq),
          }));
          const previous = count(target.remaining);
          job.unparsedOrEmpty += unresolved;
          job.unparsedOrEmpty += rows.filter(
            (row) =>
              (row.elements.length === 0 ||
                row.elements.some((element) => element.type === 'unknown')) &&
              target.remaining.some(
                (r) => Number(row.msgSeq) >= r.start && Number(row.msgSeq) <= r.end,
              ),
          ).length;
          target.remaining = subtractRoamingIntervals(target.remaining, covered);
          job.observed += previous - count(target.remaining);
          target.pending = subtractRoamingIntervals(
            subtractRoamingIntervals(target.pending, [examined]),
            covered,
          );
          delete job.inFlight;
          job.checkedWindows++;
          job.updatedAt = Date.now();
          job.attempts.push({
            id: randomUUID(),
            at: job.updatedAt,
            target: key(target),
            ...window,
            outcome,
            observed: rows.length,
            network,
          });
          job.attempts = job.attempts.slice(-200);
          this.save();
          if (rows.length) {
            try {
              this.deps.onMessages?.(target, rows);
            } catch {
              /* UI signals do not change committed coverage. */
            }
          }
          if (job.status === 'paused') return;
          await yieldToEventLoop();
        }
      }
      if (job.status !== 'cancelled') {
        job.status = signal.aborted
          ? 'paused'
          : job.targets.some((t) => t.remaining.length)
            ? 'partial'
            : 'completed';
        job.note = signal.aborted
          ? '任务已暂停，在途结果已保存。'
          : job.status === 'partial'
            ? '本轮检查结束，仍有未取得或失败的候选区间；不代表服务器不存在这些消息。'
            : '计划中的候选缺口已由实际记录覆盖；不代表全部历史完整。';
        if (job.unparsedOrEmpty) job.note += ` 内容为空或未解析的记录 ${job.unparsedOrEmpty} 条。`;
      } else job.note = '任务已取消；已取得的记录保留，未完成区间未视为补齐。';
      this.save();
    } catch (error) {
      if (runRequests > 0 && job.inFlight) {
        job.attempts.push({
          id: randomUUID(),
          ...job.inFlight,
          at: Date.now(),
          outcome: 'error',
          observed: 0,
          network: true,
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
        job.attempts = job.attempts.slice(-200);
      }
      if (signal.aborted) {
        if (job.status !== 'cancelled') job.status = 'paused';
        job.note =
          job.status === 'cancelled'
            ? '任务已取消；未确认的窗口与已取得记录均保留。'
            : '已停止；未确认的窗口保留，继续时先复核缓存。';
      } else if (job.status !== 'paused') {
        job.status = 'failed';
        job.errors++;
        job.note = error instanceof Error ? error.message : String(error);
      }
      try {
        this.save();
      } catch (failure) {
        job.note = `断点保存失败：${String(failure)}`;
      }
    }
  }

  private validRows(target: RoamingTarget, window: RoamingInterval, rows: GapFetchedMessage[]) {
    const bySeq = new Map<string, GapFetchedMessage>();
    for (const row of rows) {
      const seq = /^\d+$/.test(row.msgSeq) ? Number(row.msgSeq) : 0;
      if (
        row.kind === target.kind &&
        row.conv === target.conv &&
        Number.isSafeInteger(seq) &&
        seq >= window.start &&
        seq <= window.end &&
        (target.kind === 'group' || row.ntSeqVerified === true)
      )
        bySeq.set(row.sourceFormat ? `${seq}:${row.msgId}` : String(seq), row);
    }
    return [...bySeq.values()];
  }

  private assertSupportedTransport(job: RoamingJob): void {
    if (job.options.transport === 'native500')
      throw Error('SDK 历史通道已移除，旧任务仅保留记录；请新建纯协议任务。');
    if (job.options.transport === 'sso500')
      throw Error('500 条聚合通道已移除，旧任务与缓存保留；请新建 SSO 任务。');
  }
}
