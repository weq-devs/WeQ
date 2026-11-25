import type { DatabaseProgress } from '@weq/native';

export type DatabaseWorkProgress = DatabaseProgress & {
  /** 结构体检中，当前索引所属的表。旧报告可能没有此字段。 */
  tableName?: string;
  status?: 'running' | 'completed' | 'incomplete' | 'failed' | 'skipped';
  /** 执行结束不等于检查正常；只有实际检查结果才能给出结论。 */
  outcome?: 'normal' | 'abnormal' | 'unverified';
  detail?: string;
};

export interface DatabaseStepProgress extends DatabaseWorkProgress {
  phase: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  rate?: number;
}

export interface DatabaseTaskProgress {
  kind: 'scan' | 'checkup' | 'repair';
  dbName: string;
  startedAt: number;
  updatedAt: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  current: DatabaseStepProgress;
  steps: DatabaseStepProgress[];
}

/** 兼容仍在运行的旧主进程和旧报告，其中每次重建计数都可能被记录为独立步骤。 */
export function databaseProgressDisplaySteps(
  progress: DatabaseTaskProgress,
): DatabaseStepProgress[] {
  const { kind, current, steps } = progress;
  if (kind !== 'repair') return steps;
  const isRecovery = (step: DatabaseStepProgress) =>
    step.phase === 'Repair' && step.step === 'recover-data';
  const latestIndex = steps.findLastIndex(isRecovery);
  if (latestIndex < 0) return steps;
  const currentIsSummary = current.phase === 'Repair' && current.step === 'Repair';
  if (!currentIsSummary && steps.findIndex(isRecovery) === latestIndex) return steps;

  return steps.flatMap((step, index) => {
    if (currentIsSummary && index === steps.length - 1) return [];
    if (!isRecovery(step)) return [step];
    if (index !== latestIndex) return [];
    // 旧进程可能在最后一次计数后只发阶段摘要，再以该摘要记录停止或失败。
    return [
      currentIsSummary ? { ...step, status: current.status, finishedAt: current.finishedAt } : step,
    ];
  });
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

function finalIntegrityStep(step: DatabaseStepProgress): boolean {
  return step.phase === 'final-check' && step.step.startsWith('integrity-');
}

function closeCheckupStep(step: DatabaseStepProgress, at: number): DatabaseStepProgress {
  if (step.status !== 'running') return step;
  const incomplete = databaseStepPercent(step) !== undefined && step.completed! < step.total!;
  return {
    ...step,
    status: incomplete ? 'incomplete' : 'completed',
    outcome: step.outcome ?? (incomplete ? 'unverified' : undefined),
    detail: step.detail ?? (incomplete ? '未处理完全部项目，已转入后续检查。' : undefined),
    finishedAt: at,
  };
}

/** 体检、修复和任务中心使用同一份有界的步骤快照。 */
export class DatabaseProgressTracker {
  private snapshot: DatabaseTaskProgress | undefined;

  constructor(
    private readonly kind: DatabaseTaskProgress['kind'],
    private readonly dbName: string,
    private readonly now: () => number = Date.now,
    seed?: DatabaseTaskProgress,
  ) {
    if (seed) this.snapshot = { ...seed, kind, status: 'running', steps: [...seed.steps] };
  }

  update(phase: string, work: DatabaseWorkProgress): DatabaseTaskProgress {
    const tick: DatabaseWorkProgress =
      work.step === 'integrity-unverified' || work.step.endsWith('-integrity-unverified')
        ? {
            ...work,
            status: work.status ?? 'skipped',
            outcome: work.outcome ?? 'unverified',
            detail: work.detail ?? 'QQ 专用分词器不可用，相关虚拟表未完成核验。',
          }
        : work;
    if (this.snapshot && this.snapshot.status !== 'running') return this.snapshot;
    // 深度修复交替上报原生阶段摘要与 recover-data 的累计计数。
    // 同阶段摘要不能结束正在恢复的数据步骤。
    if (
      this.kind === 'repair' &&
      phase === 'Repair' &&
      tick.step === phase &&
      tick.status === undefined &&
      this.snapshot?.current.phase === phase &&
      this.snapshot.current.step === 'recover-data'
    )
      return this.snapshot;
    const at = this.now();
    const old = this.snapshot;
    // 整体结构检查包住多个原生子阶段，最终结果回填原行，不新增一个同名步骤。
    const summaryIndex =
      this.kind === 'checkup' && tick.step === 'integrity'
        ? (old?.steps.findIndex((step) => step.phase === phase && step.step === 'integrity') ?? -1)
        : -1;
    if (old && summaryIndex >= 0) {
      const terminal = tick.status !== undefined && tick.status !== 'running';
      const steps = old.steps.map((step, index) => {
        if (index === summaryIndex)
          return { ...step, ...tick, updatedAt: at, finishedAt: terminal ? at : undefined };
        if (!terminal || step.phase !== phase || !step.step.startsWith('integrity-')) return step;
        const closed = closeCheckupStep(step, at);
        return {
          ...closed,
          outcome:
            closed.outcome ??
            (tick.outcome === 'normal' && closed.status === 'completed' ? 'normal' : 'unverified'),
        };
      });
      this.snapshot = { ...old, updatedAt: at, steps, current: steps[steps.length - 1]! };
      return this.snapshot;
    }
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
      if (this.kind === 'checkup') {
        if (last.step !== 'integrity' || !tick.step.startsWith('integrity-'))
          steps[steps.length - 1] = closeCheckupStep(last, at);
      } else if (finalIntegrityStep(last)) {
        steps[steps.length - 1] = closeCheckupStep(last, at);
      } else {
        steps[steps.length - 1] = {
          ...last,
          status: last.status === 'running' ? 'completed' : last.status,
          finishedAt: last.finishedAt ?? at,
        };
      }
    }
    if (
      this.kind === 'checkup' &&
      tick.step === 'integrity-tables' &&
      tick.outcome === 'abnormal'
    ) {
      const index = steps.findIndex((step) => step.step === 'integrity');
      if (index >= 0) steps[index] = { ...steps[index]!, outcome: 'abnormal' };
    }
    const retained = steps.filter(
      (step, index) =>
        index >= steps.length - 63 ||
        step.status === 'failed' ||
        step.status === 'incomplete' ||
        step.outcome === 'abnormal' ||
        step.status === 'skipped' ||
        step.outcome === 'unverified',
    );
    const summary = steps.find((step) => step.step === 'integrity');
    if (this.kind === 'checkup' && summary && !retained.includes(summary)) retained[0] = summary;
    this.snapshot = {
      kind: this.kind,
      dbName: this.dbName,
      startedAt: old?.startedAt ?? at,
      updatedAt: at,
      status: 'running',
      current,
      steps: [...retained, current],
    };
    return this.snapshot;
  }

  finish(
    status: Exclude<DatabaseTaskProgress['status'], 'running'>,
  ): DatabaseTaskProgress | undefined {
    if (!this.snapshot) return undefined;
    const at = this.now();
    const last =
      status === 'completed' &&
      (this.kind === 'checkup' || finalIntegrityStep(this.snapshot.current))
        ? closeCheckupStep(this.snapshot.current, at)
        : this.snapshot.current;
    const current = {
      ...last,
      status:
        last.step === 'rollback-fingerprint' && last.status === 'completed'
          ? last.status
          : status === 'cancelled'
            ? ('skipped' as const)
            : status === 'completed' && last.status !== 'running'
              ? last.status
              : status,
      finishedAt: at,
    };
    this.snapshot = {
      ...this.snapshot,
      status,
      updatedAt: at,
      current,
      steps: [
        ...this.snapshot.steps
          .slice(0, -1)
          .map((step) =>
            this.kind === 'checkup' && step.status === 'running'
              ? status === 'completed'
                ? closeCheckupStep(step, at)
                : { ...step, status: current.status, finishedAt: at }
              : step,
          ),
        current,
      ],
    };
    return this.snapshot;
  }
}
