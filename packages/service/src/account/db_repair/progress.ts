import type { DatabaseProgress } from '@weq/native';

export type DatabaseWorkProgress = DatabaseProgress & {
  status?: 'running' | 'completed' | 'failed' | 'skipped';
};

export interface DatabaseStepProgress extends DatabaseWorkProgress {
  phase: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  rate?: number;
}

export interface DatabaseTaskProgress {
  kind: 'checkup' | 'repair';
  dbName: string;
  startedAt: number;
  updatedAt: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  current: DatabaseStepProgress;
  steps: DatabaseStepProgress[];
}

/** 仅计算当前步骤的进度，不把页号、字段数或步骤数量当作整体百分比。 */
export function databaseStepPercent(step: DatabaseWorkProgress): number | undefined {
  if (
    !Number.isFinite(step.completed) ||
    !Number.isFinite(step.total) ||
    step.completed! < 0 ||
    step.total! <= 0
  )
    return undefined;
  return Math.min(100, Math.max(0, (step.completed! / step.total!) * 100));
}

/** 体检、修复和任务中心使用同一份有界的步骤快照。 */
export class DatabaseProgressTracker {
  private snapshot: DatabaseTaskProgress | undefined;

  constructor(
    private readonly kind: DatabaseTaskProgress['kind'],
    private readonly dbName: string,
    private readonly now: () => number = Date.now,
  ) {}

  update(phase: string, tick: DatabaseWorkProgress): DatabaseTaskProgress {
    if (this.snapshot && this.snapshot.status !== 'running') return this.snapshot;
    const at = this.now();
    const old = this.snapshot;
    const same = old?.current.phase === phase && old.current.step === tick.step;
    const previous = same ? old.current : undefined;
    const delta = previous ? at - previous.updatedAt : 0;
    const count = Number.isFinite(tick.completed) ? tick.completed : undefined;
    const total = Number.isFinite(tick.total) && tick.total! >= 0 ? tick.total : undefined;
    const rate =
      previous &&
      count !== undefined &&
      previous.completed !== undefined &&
      count >= previous.completed &&
      delta >= 100
        ? ((count - previous.completed) * 1000) / delta
        : previous?.rate;
    const current: DatabaseStepProgress = {
      ...previous,
      ...tick,
      completed: count ?? previous?.completed,
      total: total ?? previous?.total,
      phase,
      status: tick.status ?? 'running',
      startedAt: previous?.startedAt ?? at,
      updatedAt: at,
      rate: rate && Number.isFinite(rate) ? rate : undefined,
      finishedAt: tick.status && tick.status !== 'running' ? at : undefined,
    };
    const steps = old ? (same ? old.steps.slice(0, -1) : [...old.steps]) : [];
    if (!same && steps.length) {
      const last = steps[steps.length - 1]!;
      steps[steps.length - 1] = {
        ...last,
        status: last.status === 'running' ? 'completed' : last.status,
        finishedAt: last.finishedAt ?? at,
      };
    }
    this.snapshot = {
      kind: this.kind,
      dbName: this.dbName,
      startedAt: old?.startedAt ?? at,
      updatedAt: at,
      status: 'running',
      current,
      steps: [...steps.slice(-63), current],
    };
    return this.snapshot;
  }

  finish(
    status: Exclude<DatabaseTaskProgress['status'], 'running'>,
  ): DatabaseTaskProgress | undefined {
    if (!this.snapshot) return undefined;
    const at = this.now();
    const current = {
      ...this.snapshot.current,
      status:
        status === 'cancelled'
          ? ('skipped' as const)
          : status === 'completed' && this.snapshot.current.status !== 'running'
            ? this.snapshot.current.status
            : status,
      finishedAt: at,
    };
    this.snapshot = {
      ...this.snapshot,
      status,
      updatedAt: at,
      current,
      steps: [...this.snapshot.steps.slice(0, -1), current],
    };
    return this.snapshot;
  }
}
