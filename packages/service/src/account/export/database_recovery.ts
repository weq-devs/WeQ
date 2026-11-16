import { randomUUID } from 'node:crypto';
import type { SalvageBindingOptions } from '@weq/db';

export interface DatabaseRecoveryRequest {
  id: string;
  kind: 'ranges' | 'table' | 'read';
  dbPath: string;
  table?: string;
  error?: string;
  ranges?: Array<{ lo: string; hi: string }>;
  keyAxis?: 'seq' | 'rowid';
  canSkip: boolean;
  decisionPending?: boolean;
}

export interface DatabaseRecoveryRecord {
  kind: 'ranges' | 'table';
  dbPath: string;
  table?: string;
  ranges?: Array<{ lo: string; hi: string }>;
  keyAxis?: 'seq' | 'rowid';
  sqlFingerprint?: string;
}

export type DatabaseRecoveryDecision = 'skip' | 'repair' | 'stop';

export class DatabaseRecoveryStopped extends Error {
  constructor(readonly repair: boolean) {
    super(repair ? '任务已暂停，修复后可重新校验并重试。' : '任务已结束，已有结果保留。');
  }
}

/** 一个执行周期一份；授权不落盘，不影响同账号的其它任务。 */
export class DatabaseRecoveryGate {
  private tail: Promise<unknown> = Promise.resolve();
  private answer?: (value: { decision: DatabaseRecoveryDecision; skipRemaining: boolean }) => void;
  private pending?: DatabaseRecoveryRequest;
  private skipRemaining = false;
  private skippedTable = false;
  private approved = new Set<string>();
  private stopped?: DatabaseRecoveryStopped;

  constructor(
    private signal: AbortSignal,
    private changed: (request: DatabaseRecoveryRequest | undefined) => void,
    private recorded: (record: DatabaseRecoveryRecord) => void,
    private canKeepPartial: () => boolean,
  ) {}

  get tableSkipped(): boolean {
    return this.skippedTable;
  }

  respond(id: string, decision: DatabaseRecoveryDecision, skipRemaining = false): boolean {
    if (!this.pending || this.pending.id !== id || !this.answer) return false;
    if (decision === 'skip' && !this.pending.canSkip) return false;
    const resolve = this.answer;
    this.answer = undefined;
    resolve({ decision, skipRemaining });
    return true;
  }

  readonly beforeSkip: NonNullable<SalvageBindingOptions['beforeSkip']> = (input) =>
    this.serial(async () => {
      this.signal.throwIfAborted();
      if (this.skippedTable) return;
      const ranges = input.ranges.map(({ lo, hi }) => ({ lo: String(lo), hi: String(hi) }));
      const signature = JSON.stringify([input.dbPath, input.sqlFingerprint, ranges]);
      if (this.approved.has(signature)) return;
      if (!this.skipRemaining) {
        const answer = await this.ask({
          kind: 'ranges',
          dbPath: input.dbPath,
          table: input.table ?? undefined,
          ranges,
          keyAxis: input.keyAxis,
          canSkip: true,
        });
        this.skipRemaining = answer.skipRemaining;
      }
      this.approved.add(signature);
      this.recorded({
        kind: 'ranges',
        dbPath: input.dbPath,
        table: input.table ?? undefined,
        ranges,
        keyAxis: input.keyAxis,
        sqlFingerprint: input.sqlFingerprint,
      });
    });

  unreadable(dbPath: string, table: string, error: unknown): Promise<void> {
    return this.serial(async () => {
      if (this.skippedTable) return;
      await this.ask({
        kind: 'table',
        dbPath,
        table,
        error: error instanceof Error ? error.message : String(error),
        canSkip: this.canKeepPartial(),
      });
      this.skippedTable = true;
      this.recorded({ kind: 'table', dbPath, table });
    });
  }

  failedRead(error: unknown): Promise<void> {
    return this.serial(async () => {
      await this.ask({
        kind: 'read',
        dbPath:
          error &&
          typeof error === 'object' &&
          'dbPath' in error &&
          typeof error.dbPath === 'string'
            ? error.dbPath
            : '',
        error: error instanceof Error ? error.message : String(error),
        canSkip: false,
      });
    });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.stopped) throw this.stopped;
      return run();
    });
    // 并行扫描共享一个决策队列；失败不会变成未处理的 Promise rejection。
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async ask(input: Omit<DatabaseRecoveryRequest, 'id'>) {
    this.signal.throwIfAborted();
    const request = { ...input, id: randomUUID() };
    this.pending = request;
    const abort = () => this.answer?.({ decision: 'stop', skipRemaining: false });
    try {
      const answer = await new Promise<{
        decision: DatabaseRecoveryDecision;
        skipRemaining: boolean;
      }>((resolve) => {
        this.answer = resolve;
        this.signal.addEventListener('abort', abort, { once: true });
        this.changed(request);
      });
      this.signal.throwIfAborted();
      if (answer.decision !== 'skip') {
        this.stopped = new DatabaseRecoveryStopped(answer.decision === 'repair');
        throw this.stopped;
      }
      return answer;
    } finally {
      this.signal.removeEventListener('abort', abort);
      this.answer = undefined;
      this.pending = undefined;
      this.changed(undefined);
    }
  }
}
