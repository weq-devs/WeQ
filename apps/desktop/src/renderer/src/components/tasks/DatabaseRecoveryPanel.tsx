import { useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, SkipForward, Square, Wrench } from 'lucide-react';
import type { ExportTask } from '@weq/service';
import '../../styles/database-recovery.css';

export type RecoveryDecision = 'skip' | 'repair' | 'stop';

export function DatabaseRecoveryPanel({
  request,
  name,
  onDecision,
}: {
  request: NonNullable<ExportTask['databaseRecovery']>;
  name: string;
  onDecision: (decision: RecoveryDecision, skipRemaining: boolean) => Promise<void>;
}) {
  const [skipRemaining, setSkipRemaining] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const ranges = request.kind === 'ranges';
  const table = request.kind === 'table';
  const disabled = busy || Boolean(request.decisionPending);
  async function decide(decision: RecoveryDecision) {
    if (inFlight.current || request.decisionPending) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await onDecision(decision, ranges && skipRemaining);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="weq-database-recovery" aria-label="数据库异常处理" aria-busy={disabled}>
      <h4>
        <AlertTriangle size={17} aria-hidden />
        {ranges ? '部分消息暂时无法读取' : table ? '这张表无法继续读取' : '数据库读取未完成'}
      </h4>
      <p>
        {ranges
          ? '已自动尝试其他读取方式，仍有一段数据无法读取。可以跳过这段消息继续导出，或先尝试修复数据库。'
          : table
            ? '分块读取仍未完成。结束此表的读取会略过剩余内容，包括其中可能完好的消息。'
            : '当前读取无法跳过损坏部分。可以先检查并尝试修复数据库，再重试任务。'}
      </p>
      <p>
        影响范围：本次「{name}」任务。
        {request.canSkip
          ? '已有记录保留；跳过后的结果标记为部分导出。'
          : '已有记录保留，不影响其他任务。'}
      </p>
      {ranges && (
        <label className="weq-database-recovery-check">
          <input
            type="checkbox"
            checked={skipRemaining}
            disabled={disabled}
            onChange={(event) => setSkipRemaining(event.target.checked)}
          />
          本次任务遇到其他损坏区间时，也跳过并继续
        </label>
      )}
      <details>
        <summary>
          <ChevronDown size={13} aria-hidden />
          读取详情
        </summary>
        {request.dbPath && <p>{request.dbPath}</p>}
        {request.table && <p>表：{request.table}</p>}
        {request.ranges?.map((range) => (
          <p key={`${range.lo}:${range.hi}`}>
            未读
            {request.keyAxis === 'rowid'
              ? '数据库行标识'
              : request.keyAxis === 'seq'
                ? '消息序号'
                : '键'}
            区间：({range.lo}, {range.hi}]，区间内消息条数未知
          </p>
        ))}
        {request.error && <p>{request.error}</p>}
      </details>
      {error && <p role="alert">{error}</p>}
      {request.decisionPending && <p role="status">已确认，正在等待当前导出让出执行位置。</p>}
      <div className="weq-database-recovery-actions">
        <button
          type="button"
          className={ranges ? 'weq-action-soft' : 'weq-action-primary'}
          disabled={disabled}
          onClick={() => void decide('repair')}
        >
          <Wrench size={14} aria-hidden />
          尝试修复…
        </button>
        {request.canSkip && (
          <button
            type="button"
            className={ranges ? 'weq-action-primary' : 'weq-action-soft'}
            disabled={disabled}
            onClick={() => void decide('skip')}
          >
            <SkipForward size={14} aria-hidden />
            {ranges ? '跳过此区间并继续' : '结束此表并保留已有结果'}
          </button>
        )}
        <button
          type="button"
          className="weq-action-soft"
          disabled={disabled}
          onClick={() => void decide('stop')}
        >
          <Square size={14} aria-hidden />
          结束任务
        </button>
      </div>
    </section>
  );
}
