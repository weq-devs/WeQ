import * as timeFormat from '@weq/time';
/**
 * Scheduled export manager.
 *
 * Owns user-created "run this export at this cadence" entries. On each due
 * time it materializes the saved template back into a {@link TaskManager} call
 * — i.e. one schedule → N export tasks (one per saved conversation). The
 * renderer therefore keeps a single source of truth (the live export task
 * list) for progress; the schedule list itself only carries the *recipe* and
 * its trigger history.
 *
 * Persistence is per-account JSON under `cacheDir/export/<configId>/`. Crashes
 * mid-tick (machine sleep, force-kill) are recovered on next start by walking
 * `nextRunAt <= now` once.
 *
 * Concurrency model: at most one timer (`setTimeout`) per scheduler instance.
 * `tick()` walks all schedules, fires each due one, then reschedules a single
 * wake for the earliest next-run.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportTaskManager, TaskProgress } from './task_manager';
import type { DressExportKinds } from './dress_export';
import type { ExportFormat, ExportTimeRange } from './types';
import { JsonStore } from '../../common/json_store';
import { getLogger } from '../../common/logger';
import { isRecord } from '../../common/client_preferences';

/** Cadence for a scheduled export. Mirrors the renderer's `Schedule`. */
export interface ScheduleConfig {
  mode: 'daily' | 'interval';
  /** HH:MM, Beijing time. Only meaningful when mode === 'daily'. */
  time: string;
  /** Hours between runs. Only meaningful when mode === 'interval'. */
  intervalHours: number;
}

/** Window presets the renderer exposes; re-resolved to concrete unix seconds
 *  at fire-time so "最近 7 天" actually rolls forward each run. */
export type ScheduleRangePreset = 'all' | 'today' | '7d' | '30d' | '1y' | 'custom';

/** Resolved window for a single scheduled run. `null` bounds = open-ended. */
export interface ScheduleRange {
  preset: ScheduleRangePreset;
  /** Only set when preset === 'custom'; otherwise recomputed per fire. */
  start: number | null;
  end: number | null;
}

/** Media / content switches baked into the schedule template. */
export interface ScheduleOptions {
  content?: import('../../common/export_content').ExportContentPolicy;
  completeAvatar?: boolean;
  completeDressKinds?: DressExportKinds;
  profile?: import('./archive').ExportProfile;
  incrementalSupport?: boolean;
  includeIntegrityReport?: boolean;
  savePolicy?: import('./save_output').ExportSavePolicy;
  range: ScheduleRange;
  exportMedia: boolean;
  /** 导出媒体时按类别筛选（图片 / 语音 / 视频 / 文件 / QQ 系统表情）。 */
  mediaKinds?: {
    image: boolean;
    voice: boolean;
    video: boolean;
    file: boolean;
    sysface: boolean;
  };
  /** 消息补全：扫描 seq 空窗，从 QQ 服务端拉取本机缺失的消息（需在线 QQ）。 */
  completeMessages: boolean;
  exportAvatar: boolean;
  completeMedia: boolean;
  downloadVideo: boolean;
  downloadFile: boolean;
  downloadPtt: boolean;
  /** 下载本地未缓存的装扮资源。 */
  completeDress?: boolean;
  transcribeVoice: boolean;
  /** 导出装扮资源（气泡 / 字体 / 挂件），全 false / 缺省 = 不导出。 */
  dress?: DressExportKinds;
  /** 导出完成后自动弹保存路径。 */
  autoSave?: boolean;
}

/** One conversation target — fully serialized (no renderer references). */
export interface ScheduleConversation {
  id: string;
  name: string;
  kind: 'group' | 'c2c';
  /** Snapshot of `total` from the picker; re-estimated at fire-time when
   *  the cache has new messages. */
  total: number;
}

export type ScheduleOutcome =
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'cancelled';

/** One firing of a schedule — written into the history ring. */
export interface ScheduleTrigger {
  /** Unix seconds. */
  at: number;
  /** Task ids generated for this trigger. */
  taskIds: string[];
  /** Aggregate outcome across the batch. */
  outcome: ScheduleOutcome;
  /** Only set when outcome === 'skipped' (offline, conflict, disabled…). */
  skipReason?: string;
  /** Best-effort human-readable summary; for failed outcomes, the first error. */
  note?: string;
}

/** A persisted scheduled export. */
export interface ScheduledTask {
  archives?: Record<string, string>;
  id: string;
  name: string;
  /** 灯箱多选的导出格式（缺省 = [format]）。 */
  formats?: ExportFormat[];
  /** Export options snapshot. */
  options: ScheduleOptions;
  /** Output format (mirrors `account.startExport`). */
  format: ExportFormat;
  /** Conversations to run on each trigger. */
  conversations: ScheduleConversation[];
  /** ChatLab interchange (json/jsonl only). */
  chatlab?: boolean;
  schedule: ScheduleConfig;
  /** Master enable. Disabled schedules still load + persist; they just don't fire. */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Next planned fire, unix seconds. `null` when no future run scheduled
   *  (e.g. legacy entry without schedule fields, or after delete). */
  nextRunAt: number | null;
  /** Last N triggers, newest first; capped at {@link MAX_HISTORY}. */
  history: ScheduleTrigger[];
}

const MAX_HISTORY = 20;
const SCHEDULE_FILE = 'schedules.json';
const RETRY_SECONDS = 60;
function normalizeSchedules(raw: unknown): ScheduledTask[] {
  if (!Array.isArray(raw)) throw new Error('定时任务文件不是数组，原件已保留');
  const ids = new Set<string>();
  return raw.map((value: unknown) => {
    const invalid = (): never => {
      throw new Error('定时任务记录损坏，原件已保留');
    };
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id || ids.has(value.id))
      return invalid();
    ids.add(value.id);
    for (const key of ['name', 'format'])
      if (value[key] !== undefined && typeof value[key] !== 'string') invalid();
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') invalid();
    for (const key of ['createdAt', 'updatedAt', 'nextRunAt'])
      if (
        value[key] !== undefined &&
        !(key === 'nextRunAt' && value[key] === null) &&
        (typeof value[key] !== 'number' || !Number.isFinite(value[key]))
      )
        invalid();
    const schedule = value.schedule ?? { mode: 'daily', time: '03:00', intervalHours: 6 };
    if (
      !isRecord(schedule) ||
      typeof schedule.mode !== 'string' ||
      !['daily', 'interval'].includes(schedule.mode) ||
      typeof schedule.time !== 'string' ||
      typeof schedule.intervalHours !== 'number' ||
      !Number.isFinite(schedule.intervalHours)
    )
      invalid();
    const conversations = value.conversations ?? [];
    if (
      !Array.isArray(conversations) ||
      conversations.some(
        (row) =>
          !isRecord(row) ||
          typeof row.id !== 'string' ||
          typeof row.name !== 'string' ||
          typeof row.kind !== 'string' ||
          !['group', 'c2c'].includes(row.kind) ||
          typeof row.total !== 'number' ||
          !Number.isFinite(row.total),
      )
    )
      invalid();
    const history = value.history ?? [];
    if (
      !Array.isArray(history) ||
      history.some(
        (row) =>
          !isRecord(row) ||
          typeof row.at !== 'number' ||
          !Number.isFinite(row.at) ||
          !Array.isArray(row.taskIds) ||
          row.taskIds.some((id) => typeof id !== 'string') ||
          typeof row.outcome !== 'string' ||
          !['running', 'completed', 'partial', 'failed', 'skipped', 'cancelled'].includes(
            row.outcome,
          ),
      )
    )
      invalid();
    const options: unknown = value.options ?? defaultOptions();
    if (
      !isRecord(options) ||
      !isRecord(options.range) ||
      typeof options.range.preset !== 'string' ||
      !['all', 'today', '7d', '30d', '1y', 'custom'].includes(options.range.preset)
    )
      return invalid();
    for (const key of ['start', 'end']) {
      const bound = options.range[key];
      if (bound !== null && (typeof bound !== 'number' || !Number.isFinite(bound))) invalid();
    }
    for (const [key, defaultValue] of Object.entries(defaultOptions()))
      if (
        typeof defaultValue === 'boolean' &&
        options[key] !== undefined &&
        typeof options[key] !== 'boolean'
      )
        invalid();
    return {
      name: '',
      enabled: false,
      format: 'txt',
      createdAt: 0,
      updatedAt: 0,
      nextRunAt: null,
      ...value,
      schedule,
      conversations,
      history,
      options: { ...defaultOptions(), ...options },
    } as ScheduledTask;
  });
}

/** Input shape for `create` / `update` — server-side fields filled by the manager. */
export type ScheduleInput = Omit<
  ScheduledTask,
  'id' | 'createdAt' | 'updatedAt' | 'nextRunAt' | 'history' | 'archives'
>;

/** Patch for `update` — every field optional. */
export type SchedulePatch = Partial<
  Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'nextRunAt' | 'history' | 'archives'>
>;

/** Injected dependencies. `isOnline` is consulted at fire-time only — the
 *  scheduler doesn't subscribe to online-status changes itself. */
export interface SchedulerDeps {
  taskManager: ExportTaskManager;
  /** Resolves true when the open account has a live pid (so rkey/complete
   *  flows can run). Read at fire-time; cached for the duration of one fire. */
  isOnline: () => boolean;
}

/** Emitted on every persisted change. UI may subscribe to invalidate caches. */
export interface SchedulerEvents {
  change: (tasks: ScheduledTask[]) => void;
}

/** Public typed events for `EventEmitter`. */
export declare interface ExportScheduler {
  on<K extends keyof SchedulerEvents>(event: K, listener: SchedulerEvents[K]): this;
  off<K extends keyof SchedulerEvents>(event: K, listener: SchedulerEvents[K]): this;
  emit<K extends keyof SchedulerEvents>(event: K, ...args: Parameters<SchedulerEvents[K]>): boolean;
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: 与上方 interface 合并以给 EventEmitter 提供强类型事件签名
export class ExportScheduler extends EventEmitter {
  private tasks = new Map<string, ScheduledTask>();
  private readonly path: string;
  private readonly store: JsonStore<ScheduledTask[]>;
  private retries = new Map<string, number>();
  private wakeHandle: NodeJS.Timeout | null = null;
  /** Set while a fire is mid-flight; new fires triggered by a tick that races
   *  with a still-running one bail out instead of stacking. */
  private firing = false;
  private stopped = false;
  private startingBatches = new Set<string>();
  private settlingBatches = new Set<string>();
  private activeBatches = new Map<string, string[]>();
  private outcomeListeners = new Set<() => void>();

  constructor(
    cacheDir: string,
    private deps: SchedulerDeps,
  ) {
    super();
    mkdirSync(cacheDir, { recursive: true });
    this.path = join(cacheDir, SCHEDULE_FILE);
    this.store = new JsonStore(this.path, () => [], {
      pretty: true,
      normalize: normalizeSchedules,
    });
    this.load();
    this.scheduleNextWake();
  }

  // ---- persistence ----

  private load(): void {
    try {
      this.store.assertReadable();
      const data = structuredClone(this.store.data);
      const now = Math.floor(Date.now() / 1000);
      let rebased = false;
      for (const t of data) {
        // 已逾期记录沿用一次恢复；只重算尚未到期的每日计划。
        if (t.enabled && t.schedule.mode === 'daily' && t.nextRunAt !== null && t.nextRunAt > now) {
          const next = computeNextRun(t.schedule, now);
          rebased ||= next !== t.nextRunAt;
          t.nextRunAt = next;
        }
        this.tasks.set(t.id, t);
      }
      if (rebased) this.save();
    } catch (e) {
      console.error('[ExportScheduler] failed to load schedules:', e);
    }
  }

  private save(): void {
    try {
      this.store.replace(structuredClone([...this.tasks.values()]), true);
    } catch (error) {
      this.applyTasks(structuredClone(this.store.data));
      throw error;
    }
  }
  private applyTasks(next: ScheduledTask[]) {
    const previous = this.tasks;
    this.tasks = new Map(
      next.map((task) => {
        const current = previous.get(task.id);
        return [task.id, current ? Object.assign(current, task) : task];
      }),
    );
  }
  private replaceTasks(next: ScheduledTask[]) {
    this.store.replace(structuredClone(next), true);
    this.applyTasks(next);
  }

  private notify(): void {
    try {
      this.emit('change', this.list());
    } catch (error) {
      getLogger().child({ scope: 'export-scheduler' }).warn('任务已保存，订阅通知失败', { error });
    }
  }

  // ---- public API ----

  list(): ScheduledTask[] {
    this.store.assertReadable();
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): ScheduledTask | null {
    this.store.assertReadable();
    return this.tasks.get(id) ?? null;
  }

  /** Create a new schedule. `nextRunAt` is computed from now. */
  create(input: ScheduleInput): ScheduledTask {
    this.store.assertReadable();
    const now = Math.floor(Date.now() / 1000);
    const task: ScheduledTask = {
      ...structuredClone(input),
      id: `sched-${now}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
      nextRunAt: computeNextRun(input.schedule, now),
      history: [],
    };
    this.replaceTasks([...this.tasks.values(), task]);
    this.notify();
    this.scheduleNextWake();
    return task;
  }

  /** Patch an existing schedule. Re-computes `nextRunAt` when `schedule` changes
   *  (relative to `updatedAt`, i.e. now). */
  update(id: string, patch: SchedulePatch): ScheduledTask | null {
    this.store.assertReadable();
    const t = this.tasks.get(id);
    if (!t) return null;
    const now = Math.floor(Date.now() / 1000);
    const next = { ...t, ...structuredClone(patch), updatedAt: now };
    if (patch.schedule) next.nextRunAt = computeNextRun(next.schedule, now);
    this.replaceTasks([...this.tasks.values()].map((task) => (task.id === id ? next : task)));
    this.retries.delete(id);
    this.notify();
    this.scheduleNextWake();
    return t;
  }

  setEnabled(id: string, enabled: boolean): ScheduledTask | null {
    return this.update(id, { enabled });
  }

  delete(id: string): boolean {
    this.store.assertReadable();
    const t = this.tasks.get(id);
    if (!t) return false;
    this.replaceTasks([...this.tasks.values()].filter((task) => task.id !== id));
    this.retries.delete(id);
    this.notify();
    this.scheduleNextWake();
    return true;
  }

  /** Wipe every persisted schedule + history. Useful for "reset". */
  clear(): void {
    this.replaceTasks([]);
    this.retries.clear();
    this.notify();
    this.scheduleNextWake();
  }

  /** Run a schedule immediately (manual trigger). Returns the generated task
   *  ids; the call does NOT await the tasks themselves — they continue running
   *  in the background like any other export. */
  async runNow(id: string): Promise<string[]> {
    this.store.assertReadable();
    const t = this.tasks.get(id);
    if (!t) return [];
    const result = await this.fire(t, /* reason */ 'manual');
    // Manual triggers shouldn't reset the auto-schedule cadence.
    return result.taskIds;
  }

  /** Release the timer; called from `AppContext.clearAccount`. */
  stop(): void {
    this.stopped = true;
    if (this.wakeHandle) clearTimeout(this.wakeHandle);
    this.wakeHandle = null;
    for (const unsubscribe of this.outcomeListeners) unsubscribe();
    this.outcomeListeners.clear();
  }

  // ---- wake loop ----

  private scheduleNextWake(): void {
    if (this.wakeHandle) clearTimeout(this.wakeHandle);
    if (this.stopped) return;
    let soonest: number | null = null;
    for (const t of this.tasks.values()) {
      if (!t.enabled || t.nextRunAt == null) continue;
      const attemptAt = Math.max(t.nextRunAt, this.retries.get(t.id) ?? 0);
      if (soonest == null || attemptAt < soonest) soonest = attemptAt;
    }
    if (soonest == null) {
      this.wakeHandle = null;
      return;
    }
    // An offline/conflicting due run must not spin a zero-delay retry loop.
    const delayMs = Math.max(1000, soonest * 1000 - Date.now());
    // Cap delay so a long sleep eventually re-checks the clock (recompute path
    // catches any triggers that piled up in the gap).
    const capped = Math.min(delayMs, 60 * 60 * 1000);
    this.wakeHandle = setTimeout(() => {
      void this.tickAndReschedule();
    }, capped);
  }

  private async tickAndReschedule(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      getLogger()
        .child({ scope: 'export-scheduler' })
        .error('定时任务状态保存失败，稍后重试', { error });
    } finally {
      this.scheduleNextWake();
    }
  }

  /** Walk every schedule; fire each whose `nextRunAt <= now`. */
  private async tick(): Promise<void> {
    if (this.stopped || this.firing) return;
    const now = Math.floor(Date.now() / 1000);
    const due: ScheduledTask[] = [];
    for (const t of this.tasks.values()) {
      if (
        t.enabled &&
        t.nextRunAt != null &&
        t.nextRunAt <= now &&
        (this.retries.get(t.id) ?? 0) <= now
      )
        due.push(t);
    }
    if (due.length === 0) return;

    this.firing = true;
    try {
      // Sequential: avoid hammering ExportTaskManager / QQ for many schedules
      // firing simultaneously (midnight = many "daily" tasks at once).
      for (const t of due) {
        if (this.stopped) break;
        this.retries.set(t.id, now + RETRY_SECONDS);
        try {
          await this.fire(t, 'scheduled');
        } catch (error) {
          this.retries.set(t.id, now + RETRY_SECONDS);
          throw error;
        }
      }
    } finally {
      this.firing = false;
    }
  }

  /** Fire one schedule. Resolves to the trigger recorded; side effects:
   *  updates `history`, recomputes `nextRunAt`, persists. */
  private async fire(t: ScheduledTask, reason: 'scheduled' | 'manual'): Promise<ScheduleTrigger> {
    const at = Math.floor(Date.now() / 1000);
    const taskIds: string[] = [];
    if (this.stopped) return { at, taskIds, outcome: 'cancelled' };

    // --- guards (record skip in history, don't throw) ---
    if (t.enabled === false && reason === 'scheduled') {
      return this.recordOutcome(
        t,
        { at, taskIds, outcome: 'skipped', skipReason: '已暂停' },
        reason === 'scheduled',
      );
    }
    // Conflict: a previous run for this same schedule still has live tasks.
    if (
      this.startingBatches.has(t.id) ||
      this.settlingBatches.has(t.id) ||
      this.hasRunning(this.activeBatches.get(t.id)) ||
      t.history.some((trigger) => this.hasRunning(trigger.taskIds))
    ) {
      return this.recordOutcome(
        t,
        {
          at,
          taskIds,
          outcome: 'skipped',
          skipReason: '上次任务未结束',
        },
        reason === 'scheduled',
      );
    }
    const completeMessages = t.options.content
      ? t.options.content.messages === 'cloud'
      : t.options.completeMessages;
    if (completeMessages && !this.deps.isOnline()) {
      return this.recordOutcome(
        t,
        { at, taskIds, outcome: 'skipped', skipReason: 'QQ 离线' },
        reason === 'scheduled',
      );
    }
    if (t.conversations.length === 0) {
      return this.recordOutcome(
        t,
        { at, taskIds, outcome: 'skipped', skipReason: '未选择会话' },
        reason === 'scheduled',
      );
    }

    this.startingBatches.add(t.id);
    try {
      return await this.startBatch(t, reason, at);
    } finally {
      this.startingBatches.delete(t.id);
    }
  }

  private async startBatch(
    t: ScheduledTask,
    reason: 'scheduled' | 'manual',
    at: number,
  ): Promise<ScheduleTrigger> {
    const taskIds: string[] = [];

    // --- run the template via ExportTaskManager.startTask ---
    const range = resolveRange(t.options.range, at);
    const formats = t.formats ?? [t.format];
    let firstError: string | null = null;
    for (const c of t.conversations) {
      if (this.stopped) break;
      // 多格式在同一个任务里完成（同一 bundle，媒体 / 头像 / 装扮只带一份）。
      const carryResources = true;
      try {
        const id = await this.deps.taskManager.startTask({
          autoOpenTaskList: reason === 'manual',
          baselineDirectory:
            !t.chatlab &&
            formats.some(
              (format) => format === 'json' || format === 'jsonl' || format === 'jsonl.gz',
            )
              ? t.archives?.[`${c.kind}:${c.id}`]
              : undefined,
          content: t.options.content,
          completeAvatar: t.options.completeAvatar,
          profile: t.options.profile ?? 'basic',
          incrementalSupport: t.options.incrementalSupport ?? false,
          savePolicy: t.options.savePolicy,
          includeIntegrityReport: t.options.includeIntegrityReport,
          kind: c.kind,
          conv: c.id,
          name: c.name,
          scheduleName: t.name,
          format: formats[0] ?? t.format,
          formats,
          total: c.total,
          // startTask has `exportAvatar?: boolean` — always pass it explicitly so
          // ExportTask.exportAvatar mirrors the template, not "undefined".
          exportAvatar: carryResources && Boolean(t.options.exportAvatar),
          ...(carryResources && t.options.dress ? { dress: t.options.dress } : {}),
          ...(t.chatlab ? { chatlab: true } : {}),
          ...(carryResources &&
          (t.options.exportMedia ||
            t.options.exportAvatar ||
            t.options.transcribeVoice ||
            t.options.completeMessages)
            ? {
                media: {
                  exportMedia: t.options.exportMedia,
                  completeMessages: t.options.completeMessages,
                  completeMedia: t.options.exportMedia && t.options.completeMedia,
                  downloadVideo: t.options.exportMedia && t.options.downloadVideo,
                  downloadFile: t.options.exportMedia && t.options.downloadFile,
                  downloadPtt: t.options.exportMedia && t.options.downloadPtt,
                  transcribeVoice: t.options.transcribeVoice,
                  mediaKinds: t.options.mediaKinds,
                  completeDress: t.options.completeDress,
                  completeDressKinds: t.options.completeDressKinds,
                },
              }
            : {}),
          range,
        });
        taskIds.push(id);
        this.deps.taskManager.appendLog(
          id,
          'task',
          `由定时任务「${t.name}」触发（${reason === 'manual' ? '手动' : '定时'}）`,
        );
      } catch (e) {
        if (!firstError) firstError = String((e as Error)?.message ?? e);
      }
    }

    if (taskIds.length === 0) {
      return this.recordOutcome(
        t,
        {
          at,
          taskIds,
          outcome: 'failed',
          note: firstError ?? '启动失败',
        },
        reason === 'scheduled',
      );
    }

    // Persist the running batch and book the next cadence before yielding to the wake loop.
    this.activeBatches.set(t.id, taskIds);
    const trigger: ScheduleTrigger = { at, taskIds, outcome: 'running' };
    try {
      return this.recordOutcome(t, trigger, reason === 'scheduled');
    } finally {
      if (!this.stopped) this.watchOutcome(t, trigger, firstError, reason === 'scheduled');
    }
  }

  /** Subscribe to ExportTaskManager progress; on every task terminal event,
   *  record an aggregate outcome into the schedule's history (once). */
  private watchOutcome(
    t: ScheduledTask,
    trigger: ScheduleTrigger,
    firstError: string | null,
    advance: boolean,
  ): void {
    const taskIds = trigger.taskIds;
    const expected = new Set(taskIds);
    const states = new Map<string, 'completed' | 'failed' | 'cancelled'>();
    const archives: Record<string, string> = {};
    let retry: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = (): void => {
      clearTimeout(retry);
      this.settlingBatches.delete(t.id);
      this.deps.taskManager.off('progress', onProgress);
      this.outcomeListeners.delete(unsubscribe);
    };
    const finalize = () => {
      if (retry) return;
      const current = this.tasks.get(t.id);
      if (!current || this.stopped) {
        unsubscribe();
        return;
      }
      this.settlingBatches.add(t.id);
      const allDone = [...states.values()].every((state) => state === 'completed');
      const outcome: ScheduleOutcome = allDone && !firstError ? 'completed' : 'partial';
      const completed = {
        ...trigger,
        outcome,
        ...(firstError && outcome !== 'completed' ? { note: firstError } : {}),
      };
      const matches = (entry: ScheduleTrigger) =>
        entry.at === trigger.at && entry.taskIds.join(',') === taskIds.join(',');
      const history = current.history.some(matches)
        ? current.history.map((entry) => (matches(entry) ? completed : entry))
        : [completed, ...current.history].slice(0, MAX_HISTORY);
      const next = {
        ...current,
        history,
        updatedAt: Math.floor(Date.now() / 1000),
        ...(Object.keys(archives).length ? { archives: { ...current.archives, ...archives } } : {}),
        nextRunAt: advance
          ? Math.max(current.nextRunAt ?? 0, computeNextRun(current.schedule, trigger.at))
          : current.nextRunAt,
      };
      try {
        this.replaceTasks([...this.tasks.values()].map((task) => (task.id === t.id ? next : task)));
        unsubscribe();
        if (this.activeBatches.get(t.id) === taskIds) this.activeBatches.delete(t.id);
        this.notify();
      } catch (error) {
        getLogger()
          .child({ scope: 'export-scheduler' })
          .error('导出已结束，触发回执保存失败，稍后重试保存', { error });
        retry = setTimeout(() => {
          retry = undefined;
          finalize();
        }, RETRY_SECONDS * 1000);
      }
    };
    const onProgress = (p: TaskProgress): void => {
      if (!expected.has(p.taskId)) return;
      if (p.status === 'completed' || p.status === 'failed' || p.status === 'cancelled') {
        const task = this.deps.taskManager.getTask(p.taskId);
        if (
          p.status === 'completed' &&
          task?.save &&
          (task.save.status === 'pending' || task.save.status === 'saving')
        )
          return;
        const saveFailed = task?.save?.status === 'failed' || task?.save?.status === 'interrupted';
        if (p.status === 'completed' && !saveFailed && task?.archiveId) {
          const path = this.deps.taskManager.formalArchivePath(task.id);
          if (path) archives[`${task.kind}:${task.conv}`] = path;
        }
        if (saveFailed && !firstError) firstError = task?.save?.error ?? '导出已完成，结果未保存';
        if (!states.has(p.taskId)) {
          states.set(p.taskId, saveFailed ? 'failed' : p.status);
        }
        if (states.size === expected.size) finalize();
      }
    };
    this.deps.taskManager.on('progress', onProgress);
    this.outcomeListeners.add(unsubscribe);
    // A very small export may finish before its startup promise resolves.
    for (const taskId of taskIds) {
      const task = this.deps.taskManager.getTask(taskId);
      if (task)
        onProgress({
          taskId,
          status: task.status,
          progress: task.progress,
          current: task.current,
          message: '',
        });
    }
  }

  /** Conflict check: are any of `taskIds` still 'running' in the task manager? */
  private hasRunning(taskIds: string[] | undefined): boolean {
    if (!taskIds || taskIds.length === 0) return false;
    for (const id of taskIds) {
      const t = this.deps.taskManager.getTask(id);
      if (
        t &&
        (t.status === 'running' ||
          t.status === 'pending' ||
          t.save?.status === 'saving' ||
          (t.status === 'completed' && t.save?.status === 'pending'))
      )
        return true;
    }
    return false;
  }

  /** Record a trigger into history (capped), reschedule, persist.
   *  Skips never advance `nextRunAt` — the schedule still owes the same run;
   *  the next tick will re-check the same instant. Other outcomes (success,
   *  partial, failed) advance at startup; manual runs preserve the cadence. */
  private recordOutcome(
    t: ScheduledTask,
    trigger: ScheduleTrigger,
    advance = true,
  ): ScheduleTrigger {
    if (trigger.outcome === 'skipped' && advance) {
      this.retries.set(t.id, trigger.at + RETRY_SECONDS);
      const last = t.history[0];
      if (last?.outcome === 'skipped' && last.skipReason === trigger.skipReason) return last;
    } else if (advance) this.retries.delete(t.id);
    t.history.unshift(trigger);
    if (t.history.length > MAX_HISTORY) t.history.length = MAX_HISTORY;
    if (advance && trigger.outcome !== 'skipped') {
      t.nextRunAt = computeNextRun(t.schedule, trigger.at);
    }
    t.updatedAt = trigger.at;
    this.save();
    this.notify();
    return trigger;
  }
}

// ---- helpers ----

/** Next fire-time in unix seconds. `fromSec` is treated as "now" for the
 *  local-time conversion; daily mode rolls to the next day if today's slot
 *  has already passed. */
export function computeNextRun(s: ScheduleConfig, fromSec: number): number {
  if (s.mode === 'daily') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.time ?? '');
    const hh = m ? Math.min(23, Number(m[1])) : 3;
    const mm = m ? Math.min(59, Number(m[2])) : 0;
    const p = timeFormat.calendarParts(fromSec * 1000)!;
    const today = timeFormat.calendarStart(p.year, p.month, p.day) / 1000 + hh * 3600 + mm * 60;
    return today > fromSec ? today : today + 86400;
  }
  const hours = Math.max(1, Math.min(168, Math.floor(s.intervalHours || 6)));
  return fromSec + hours * 3600;
}

/** Re-resolve a stored range to concrete unix seconds at fire-time. Custom
 *  windows use the saved absolute bounds; presets always recompute so they
 *  always describe "now ± N days" rather than "the moment the user picked
 *  this preset, frozen forever". */
export function resolveRange(r: ScheduleRange, atSec: number): ExportTimeRange {
  if (r.preset === 'custom') return { start: r.start, end: r.end };
  if (r.preset === 'all') return { start: null, end: null };
  const p = timeFormat.calendarParts(atSec * 1000)!;
  const start = timeFormat.calendarStart(p.year, p.month, p.day) / 1000;
  const days = r.preset === 'today' ? 1 : r.preset === '7d' ? 7 : r.preset === '30d' ? 30 : 365;
  return { start: start - (days - 1) * 86400, end: start + 86400 - 1 };
}

function defaultOptions(): ScheduleOptions {
  return {
    range: { preset: 'all', start: null, end: null },
    exportMedia: true,
    completeMessages: false,
    exportAvatar: true,
    completeMedia: false,
    downloadVideo: false,
    downloadFile: false,
    downloadPtt: false,
    transcribeVoice: false,
  };
}
