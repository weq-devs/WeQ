import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronUp, Circle, Loader2, Minus } from 'lucide-react';
import {
  databaseStepPercent,
  type DatabaseTaskProgress,
  type DatabaseStepProgress,
} from '@weq/service/db-progress';
import { formatBytesOrUnknown } from '../lib/format';
import { TaskProgressBar } from './tasks/TaskProgressBar';
import '../styles/database-maintenance-progress.css';

const REPAIR_GROUPS = ['准备', '读取源库', '重建数据', '生成与检查', '替换', '最终复核'];
const CHECKUP_GROUPS = ['结构检查', '页签名检查', '归属分析'];

function groupIndex(step: DatabaseStepProgress): number {
  if (['wal', 'backup', 'preparing'].includes(step.phase)) return 0;
  if (['Scan', 'Decrypt'].includes(step.phase)) return 1;
  if (step.phase === 'Repair') return 2;
  if (['Encrypt', 'Restore', 'Verify'].includes(step.phase)) return 3;
  if (['source-check', 'swapping'].includes(step.phase)) return 4;
  return 5;
}

function checkupGroupIndex(step: DatabaseStepProgress): number {
  return step.step === 'mapping' ? 2 : step.step === 'pages' ? 1 : 0;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function countText(step: DatabaseStepProgress): string | undefined {
  if (step.completed === undefined) return undefined;
  const count = (value: number) =>
    step.unit === 'bytes' ? formatBytesOrUnknown(value) : Math.floor(value).toLocaleString('zh-CN');
  const suffix =
    (
      { pages: '页', tables: '张表', fields: '个字段', records: '条记录' } as Record<string, string>
    )[step.unit ?? ''] ?? '';
  return `${count(step.completed)}${step.total === undefined ? '' : ` / ${count(step.total)}`}${suffix ? ` ${suffix}` : ''}`;
}

function needsAttention(step: DatabaseStepProgress): boolean {
  return step.status === 'failed' || step.status === 'incomplete' || step.outcome === 'abnormal';
}

function stepLabel(step: DatabaseStepProgress, checkup: boolean, cancelled: boolean): string {
  const outcome =
    step.outcome && { normal: '正常', abnormal: '异常', unverified: '未判定' }[step.outcome];
  if (step.status === 'incomplete') return '提前结束';
  if (step.status === 'failed')
    return outcome === '异常' ? '异常 · 检查中断' : checkup ? '检查失败' : '未完成';
  if (step.status === 'skipped')
    return cancelled ? '已停止' : outcome === '未判定' ? '无法校验' : '已跳过';
  if (step.status === 'completed')
    return outcome ?? (checkup && step.step.startsWith('integrity-') ? '已检查' : '已完成');
  const pct = databaseStepPercent(step);
  const activity = pct === undefined ? '检查中' : `${pct.toFixed(1)}%`;
  return outcome === '异常'
    ? `${activity} · 异常`
    : pct === undefined && !checkup
      ? '处理中'
      : activity;
}

export function DatabaseMaintenanceProgress({
  progress,
  connectionError,
  compact = false,
}: {
  progress: DatabaseTaskProgress;
  connectionError?: boolean;
  compact?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const [showEarlier, setShowEarlier] = useState(false);
  const running = progress.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const step = progress.current;
  const at = running ? Math.max(now, step.updatedAt) : (step.finishedAt ?? progress.updatedAt);
  const groups = progress.kind === 'repair' ? REPAIR_GROUPS : CHECKUP_GROUPS;
  const indexFor = progress.kind === 'repair' ? groupIndex : checkupGroupIndex;
  const group = indexFor(step);
  const recentStart = Math.max(0, progress.steps.length - 4);
  const earlierCount = progress.steps
    .slice(0, recentStart)
    .filter((item) => !needsAttention(item) && item.status !== 'running').length;
  const visibleSteps = progress.steps.filter(
    (item, index) =>
      showEarlier || index >= recentStart || needsAttention(item) || item.status === 'running',
  );
  const quiet = Math.max(0, at - step.updatedAt);
  const statusLabel = {
    running: '进行中',
    completed: '已完成',
    failed: '未完成',
    cancelled: '已停止',
  }[progress.status];
  const rate =
    running && quiet < 5000 && step.rate && ['pages', 'bytes'].includes(step.unit ?? '')
      ? `${step.unit === 'bytes' ? formatBytesOrUnknown(step.rate) : `${Math.round(step.rate).toLocaleString('zh-CN')} 页`}/秒`
      : undefined;
  return (
    <section
      className={`weq-db-progress${compact ? ' is-compact' : ''} is-${progress.status}`}
      aria-label={`${progress.dbName}维护进度`}
    >
      <header className="weq-db-progress-heading">
        <strong>{progress.dbName}</strong>
        <span>已用 {duration(at - progress.startedAt)}</span>
      </header>
      <ol
        className="weq-db-progress-timeline"
        aria-label={progress.kind === 'repair' ? '修复步骤' : '体检步骤'}
      >
        {earlierCount > 0 ? (
          <li className="weq-db-progress-expand">
            <button
              type="button"
              aria-expanded={showEarlier}
              onClick={() => setShowEarlier((value) => !value)}
            >
              {showEarlier ? (
                <ChevronUp size={13} aria-hidden />
              ) : (
                <ChevronDown size={13} aria-hidden />
              )}
              {showEarlier ? '收起较早步骤' : `展开此前 ${earlierCount} 个步骤`}
            </button>
          </li>
        ) : null}
        {visibleSteps.map((item) => {
          const current = item === progress.steps[progress.steps.length - 1];
          const active = current && running && item.status === 'running';
          const pct = databaseStepPercent(item);
          const barPercent =
            progress.kind === 'repair' && progress.status === 'completed' ? 100 : pct;
          const count = countText(item);
          const Icon = needsAttention(item)
            ? AlertTriangle
            : item.status === 'completed' && item.outcome !== 'unverified'
              ? progress.kind === 'checkup' && item.step.startsWith('integrity') && !item.outcome
                ? Circle
                : Check
              : item.status === 'skipped' || item.outcome === 'unverified'
                ? Minus
                : Loader2;
          const label =
            current && connectionError
              ? '连接中断'
              : stepLabel(
                  item,
                  progress.kind === 'checkup',
                  current && progress.status === 'cancelled',
                );
          return (
            <li
              key={`${item.phase}:${item.step}:${item.startedAt}`}
              className={`weq-db-progress-entry is-${item.status ?? 'running'}${item.outcome ? ` is-${item.outcome}` : ''}${active ? ' is-current' : ''}`}
              aria-current={active ? 'step' : undefined}
            >
              <span className="weq-db-progress-node" aria-hidden>
                <Icon size={13} className={active && !connectionError ? 'weq-spin' : undefined} />
              </span>
              <div className="weq-db-progress-entry-body">
                <div className="weq-db-progress-step">
                  <span role={active ? 'status' : undefined}>{item.message}</span>
                  <strong>{label}</strong>
                </div>
                {item.objectName ? (
                  <p className="weq-db-progress-object">{item.objectName}</p>
                ) : null}
                {item.detail ? <p className="weq-db-progress-detail">{item.detail}</p> : null}
                {current && (running || barPercent !== undefined) ? (
                  <TaskProgressBar
                    value={barPercent}
                    status={connectionError ? 'paused' : progress.status}
                    label="当前步骤进度"
                    valueText={count ?? (running ? label : statusLabel)}
                  />
                ) : null}
                {count || item.badPages !== undefined || item.zeroPages || (active && rate) ? (
                  <div className="weq-db-progress-readouts">
                    {count ? <span>{count}</span> : null}
                    {item.badPages !== undefined ? (
                      <span>已发现 {item.badPages.toLocaleString('zh-CN')} 个坏页</span>
                    ) : null}
                    {item.zeroPages ? (
                      <span>{item.zeroPages.toLocaleString('zh-CN')} 个全零页</span>
                    ) : null}
                    {active && rate ? <span>近期速度 {rate}</span> : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
        {running
          ? groups.slice(group + 1).map((label) => (
              <li key={label} className="weq-db-progress-entry is-pending">
                <span className="weq-db-progress-node" aria-hidden>
                  <Circle size={8} />
                </span>
                <div className="weq-db-progress-entry-body">
                  <div className="weq-db-progress-step">
                    <span>{label}</span>
                    <strong>待开始</strong>
                  </div>
                </div>
              </li>
            ))
          : null}
      </ol>
      {connectionError ? (
        <p className="weq-db-progress-warning" role="alert">
          进度连接中断，正在重新连接；任务结果尚未确认。
        </p>
      ) : null}
    </section>
  );
}
