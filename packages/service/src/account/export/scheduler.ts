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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportTaskManager, TaskProgress } from './task_manager';
import type { ExportFormat, ExportTimeRange } from './types';

/** Cadence for a scheduled export. Mirrors the renderer's `Schedule`. */
export interface ScheduleConfig {
  mode: 'daily' | 'interval';
  /** HH:MM, local time. Only meaningful when mode === 'daily'. */
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
  range: ScheduleRange;
  exportMedia: boolean;
  exportAvatar: boolean;
  completeMedia: boolean;
  downloadVideo: boolean;
  downloadFile: boolean;
  transcribeVoice: boolean;
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

export type ScheduleOutcome = 'completed' | 'partial' | 'failed' | 'skipped' | 'cancelled';

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
  id: string;
  name: string;
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

/** Input shape for `create` / `update` — server-side fields filled by the manager. */
export type ScheduleInput = Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'nextRunAt' | 'history'>;

/** Patch for `update` — every field optional. */
export type SchedulePatch = Partial<Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'nextRunAt' | 'history'>>;

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

export class ExportScheduler extends EventEmitter {
  private tasks = new Map<string, ScheduledTask>();
  private readonly path: string;
  private wakeHandle: NodeJS.Timeout | null = null;
  /** Set while a fire is mid-flight; new fires triggered by a tick that races
   *  with a still-running one bail out instead of stacking. */
  private firing = false;

  constructor(
    cacheDir: string,
    private deps: SchedulerDeps,
  ) {
    super();
    mkdirSync(cacheDir, { recursive: true });
    this.path = join(cacheDir, SCHEDULE_FILE);
    this.load();
    this.scheduleNextWake();
  }

  // ---- persistence ----

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, 'utf-8').trim();
      if (!raw) return;
      const data = JSON.parse(raw) as ScheduledTask[];
      for (const t of data) {
        // Back-compat: legacy entries without history / nextRunAt.
        if (!Array.isArray(t.history)) t.history = [];
        if (!t.schedule) t.schedule = { mode: 'daily', time: '03:00', intervalHours: 6 };
        if (!t.options) t.options = defaultOptions();
        this.tasks.set(t.id, t);
      }
    } catch (e) {
      console.error('[ExportScheduler] failed to load schedules:', e);
    }
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify([...this.tasks.values()], null, 2), 'utf-8');
    } catch (e) {
      console.error('[ExportScheduler] failed to save schedules:', e);
    }
  }

  private notify(): void {
    this.emit('change', this.list());
  }

  // ---- public API ----

  list(): ScheduledTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): ScheduledTask | null {
    return this.tasks.get(id) ?? null;
  }

  /** Create a new schedule. `nextRunAt` is computed from now. */
  create(input: ScheduleInput): ScheduledTask {
    const now = Math.floor(Date.now() / 1000);
    const task: ScheduledTask = {
      ...input,
      id: `sched-${now}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
      nextRunAt: computeNextRun(input.schedule, now),
      history: [],
    };
    this.tasks.set(task.id, task);
    this.save();
    this.notify();
    this.scheduleNextWake();
    return task;
  }

  /** Patch an existing schedule. Re-computes `nextRunAt` when `schedule` changes
   *  (relative to `updatedAt`, i.e. now). */
  update(id: string, patch: SchedulePatch): ScheduledTask | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    const now = Math.floor(Date.now() / 1000);
    Object.assign(t, patch, { updatedAt: now });
    if (patch.schedule) t.nextRunAt = computeNextRun(t.schedule, now);
    this.save();
    this.notify();
    this.scheduleNextWake();
    return t;
  }

  setEnabled(id: string, enabled: boolean): ScheduledTask | null {
    return this.update(id, { enabled });
  }

  delete(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    this.tasks.delete(id);
    this.save();
    this.notify();
    this.scheduleNextWake();
    return true;
  }

  /** Wipe every persisted schedule + history. Useful for "reset". */
  clear(): void {
    this.tasks.clear();
    try {
      if (existsSync(this.path)) rmSync(this.path, { force: true });
    } catch {}
    this.notify();
    this.scheduleNextWake();
  }

  /** Run a schedule immediately (manual trigger). Returns the generated task
   *  ids; the call does NOT await the tasks themselves — they continue running
   *  in the background like any other export. */
  async runNow(id: string): Promise<string[]> {
    const t = this.tasks.get(id);
    if (!t) return [];
    const result = await this.fire(t, /* reason */ 'manual');
    // Manual triggers shouldn't reset the auto-schedule cadence.
    return result.taskIds;
  }

  /** Release the timer; called from `AppContext.clearAccount`. */
  stop(): void {
    if (this.wakeHandle) clearTimeout(this.wakeHandle);
    this.wakeHandle = null;
  }

  // ---- wake loop ----

  private scheduleNextWake(): void {
    if (this.wakeHandle) clearTimeout(this.wakeHandle);
    let soonest: number | null = null;
    for (const t of this.tasks.values()) {
      if (!t.enabled || t.nextRunAt == null) continue;
      if (soonest == null || t.nextRunAt < soonest) soonest = t.nextRunAt;
    }
    if (soonest == null) {
      this.wakeHandle = null;
      return;
    }
    const delayMs = Math.max(0, soonest * 1000 - Date.now());
    // Cap delay so a long sleep eventually re-checks the clock (recompute path
    // catches any triggers that piled up in the gap).
    const capped = Math.min(delayMs, 60 * 60 * 1000);
    this.wakeHandle = setTimeout(() => {
      void this.tickAndReschedule();
    }, capped);
  }

  private async tickAndReschedule(): Promise<void> {
    await this.tick();
    this.scheduleNextWake();
  }

  /** Walk every schedule; fire each whose `nextRunAt <= now`. */
  private async tick(): Promise<void> {
    if (this.firing) return;
    const now = Math.floor(Date.now() / 1000);
    const due: ScheduledTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.enabled && t.nextRunAt != null && t.nextRunAt <= now) due.push(t);
    }
    if (due.length === 0) return;

    this.firing = true;
    try {
      // Sequential: avoid hammering ExportTaskManager / QQ for many schedules
      // firing simultaneously (midnight = many "daily" tasks at once).
      for (const t of due) {
        await this.fire(t, 'scheduled');
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

    // --- guards (record skip in history, don't throw) ---
    if (t.enabled === false && reason === 'scheduled') {
      return this.recordOutcome(t, { at, taskIds, outcome: 'skipped', skipReason: '已暂停' });
    }
    // Conflict: a previous run for this same schedule still has live tasks.
    if (this.hasRunning(t.history[0]?.taskIds)) {
      return this.recordOutcome(t, { at, taskIds, outcome: 'skipped', skipReason: '上次任务未结束' });
    }
    if (!this.deps.isOnline()) {
      return this.recordOutcome(t, { at, taskIds, outcome: 'skipped', skipReason: 'QQ 离线' });
    }
    if (t.conversations.length === 0) {
      return this.recordOutcome(t, { at, taskIds, outcome: 'skipped', skipReason: '未选择会话' });
    }

    // --- run the template via ExportTaskManager.startTask ---
    const range = resolveRange(t.options.range, at);
    let firstError: string | null = null;
    for (const c of t.conversations) {
      try {
        const id = await this.deps.taskManager.startTask({
          kind: c.kind,
          conv: c.id,
          name: c.name,
          format: t.format,
          total: c.total,
          // startTask has `exportAvatar?: boolean` — always pass it explicitly so
          // ExportTask.exportAvatar mirrors the template, not "undefined".
          exportAvatar: Boolean(t.options.exportAvatar),
          ...(t.chatlab ? { chatlab: true } : {}),
          ...(t.options.exportMedia || t.options.exportAvatar || t.options.transcribeVoice
            ? {
                media: {
                  exportMedia: t.options.exportMedia,
                  completeMedia: t.options.exportMedia && t.options.completeMedia,
                  downloadVideo: t.options.exportMedia && t.options.completeMedia && t.options.downloadVideo,
                  downloadFile: t.options.exportMedia && t.options.completeMedia && t.options.downloadFile,
                  transcribeVoice: t.options.transcribeVoice,
                },
              }
            : {}),
          range,
        });
        taskIds.push(id);
      } catch (e: any) {
        if (!firstError) firstError = String(e?.message ?? e);
      }
    }

    if (taskIds.length === 0) {
      return this.recordOutcome(t, {
        at,
        taskIds,
        outcome: 'failed',
        note: firstError ?? '启动失败',
      });
    }

    // Watch the batch and aggregate an outcome into history once they settle.
    this.watchOutcome(t, taskIds, firstError);
    return { at, taskIds, outcome: 'partial' };
  }

  /** Subscribe to ExportTaskManager progress; on every task terminal event,
   *  record an aggregate outcome into the schedule's history (once). */
  private watchOutcome(t: ScheduledTask, taskIds: string[], firstError: string | null): void {
    const expected = new Set(taskIds);
    const states = new Map<string, 'completed' | 'failed' | 'cancelled'>();
    const onProgress = (p: TaskProgress): void => {
      if (!expected.has(p.taskId)) return;
      if (p.status === 'completed' || p.status === 'failed' || p.status === 'cancelled') {
        if (!states.has(p.taskId)) {
          states.set(p.taskId, p.status);
          if (states.size === expected.size) {
            this.deps.taskManager.off('progress', onProgress);
            const allDone = [...states.values()].every((s) => s === 'completed');
            const anyFailed = [...states.values()].some((s) => s === 'failed' || s === 'cancelled');
            const outcome: ScheduleOutcome = allDone ? 'completed' : anyFailed ? 'partial' : 'partial';
            this.recordOutcome(t, {
              at: Math.floor(Date.now() / 1000),
              taskIds: [...expected],
              outcome,
              ...(firstError && outcome !== 'completed' ? { note: firstError } : {}),
            });
          }
        }
      }
    };
    this.deps.taskManager.on('progress', onProgress);
  }

  /** Conflict check: are any of `taskIds` still 'running' in the task manager? */
  private hasRunning(taskIds: string[] | undefined): boolean {
    if (!taskIds || taskIds.length === 0) return false;
    for (const id of taskIds) {
      const t = this.deps.taskManager.getTask(id);
      if (t && t.status === 'running') return true;
    }
    return false;
  }

  /** Record a trigger into history (capped), reschedule, persist.
   *  Skips never advance `nextRunAt` — the schedule still owes the same run;
   *  the next tick will re-check the same instant. Other outcomes (success,
   *  partial, failed, manual) advance normally. */
  private recordOutcome(t: ScheduledTask, trigger: ScheduleTrigger): ScheduleTrigger {
    t.history.unshift(trigger);
    if (t.history.length > MAX_HISTORY) t.history.length = MAX_HISTORY;
    if (trigger.outcome !== 'skipped') {
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
    const d = new Date(fromSec * 1000);
    d.setHours(hh, mm, 0, 0);
    if (Math.floor(d.getTime() / 1000) <= fromSec) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
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
  const now = new Date(atSec * 1000);
  const startOfDay = (d: Date): number => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime() / 1000);
  const endOfDay = (d: Date): number => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime() / 1000);
  if (r.preset === 'all') return { start: null, end: null };
  if (r.preset === 'today') return { start: startOfDay(now), end: endOfDay(now) };
  const days = r.preset === '7d' ? 7 : r.preset === '30d' ? 30 : 365;
  const from = new Date(now);
  from.setDate(from.getDate() - (days - 1));
  return { start: startOfDay(from), end: endOfDay(now) };
}

function defaultOptions(): ScheduleOptions {
  return {
    range: { preset: 'all', start: null, end: null },
    exportMedia: true,
    exportAvatar: true,
    completeMedia: false,
    downloadVideo: false,
    downloadFile: false,
    transcribeVoice: false,
  };
}