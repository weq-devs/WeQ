import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Loader2, Minus } from 'lucide-react';
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
    ({ pages: '页', tables: '张表', fields: '个字段' } as Record<string, string>)[
      step.unit ?? ''
    ] ?? '';
  return `${count(step.completed)}${step.total === undefined ? '' : ` / ${count(step.total)}`}${suffix ? ` ${suffix}` : ''}`;
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
  const running = progress.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const step = progress.current;
  const at = running ? Math.max(now, step.updatedAt) : (step.finishedAt ?? progress.updatedAt);
  const pct = databaseStepPercent(step);
  const count = countText(step);
  const groups = progress.kind === 'repair' ? REPAIR_GROUPS : CHECKUP_GROUPS;
  const indexFor = progress.kind === 'repair' ? groupIndex : checkupGroupIndex;
  const group = indexFor(step);
  const quiet = Math.max(0, at - step.updatedAt);
  const finishedSteps = progress.steps.filter((item) => item.status === 'completed').length;
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
        <span>
          {statusLabel} · 已用 {duration(at - progress.startedAt)}
        </span>
      </header>
      <ol
        className="weq-db-progress-groups"
        aria-label={progress.kind === 'repair' ? '修复阶段' : '体检阶段'}
      >
        {groups.map((label, index) => (
          <li
            key={label}
            aria-current={index === group ? 'step' : undefined}
            className={
              index === group
                ? 'is-current'
                : index < group || progress.status === 'completed'
                  ? 'is-done'
                  : ''
            }
          >
            {progress.steps.some((item) => indexFor(item) === index && item.status === 'failed') ? (
              <AlertTriangle size={12} aria-label="此阶段未完成" />
            ) : index < group || progress.status === 'completed' ? (
              <Check size={12} aria-hidden />
            ) : null}
            {label}
          </li>
        ))}
      </ol>
      <p className="weq-db-progress-mobile-phase">
        {groups[group]} · 阶段 {group + 1}/{groups.length}
      </p>
      <div className="weq-db-progress-step">
        <span role="status">{step.message}</span>
        <strong>
          {connectionError
            ? '连接中断'
            : !running
              ? statusLabel
              : pct === undefined
                ? '处理中'
                : `${pct.toFixed(1)}%`}
        </strong>
      </div>
      {step.objectName ? <p className="weq-db-progress-object">{step.objectName}</p> : null}
      <TaskProgressBar
        value={progress.status === 'completed' ? 100 : pct}
        status={connectionError ? 'paused' : progress.status}
        label={`${step.message}进度`}
        valueText={count ?? (running ? step.message : statusLabel)}
      />
      <div className="weq-db-progress-readouts">
        <span>{count ?? (running ? '正在处理当前步骤' : `已完成 ${finishedSteps} 个步骤`)}</span>
        {step.badPages !== undefined ? (
          <span>已发现 {step.badPages.toLocaleString('zh-CN')} 个坏页</span>
        ) : null}
        {step.zeroPages ? <span>{step.zeroPages.toLocaleString('zh-CN')} 个全零页</span> : null}
        {rate ? <span>近期速度 {rate}</span> : null}
        <span>
          本步骤{running ? '已用' : '用时'} {duration(at - step.startedAt)}
        </span>
      </div>
      {connectionError ? (
        <p className="weq-db-progress-warning" role="alert">
          进度连接中断，正在重新连接；任务结果尚未确认。
        </p>
      ) : running && quiet >= 10_000 ? (
        <p className="weq-db-progress-activity">
          本步骤持续 {duration(at - step.startedAt)}，最近一次进度更新在 {duration(quiet)}前。
        </p>
      ) : null}
      <details
        className="weq-db-progress-history"
        open={progress.status === 'failed' ? true : undefined}
      >
        <summary>
          <ChevronDown size={13} aria-hidden />
          <span>
            {compact ? '步骤详情' : progress.kind === 'checkup' ? '检查过程' : '执行过程'}
          </span>
          <span>已完成 {finishedSteps} 个步骤</span>
        </summary>
        <ol>
          {progress.steps.map((item) => {
            const Icon =
              item.status === 'failed'
                ? AlertTriangle
                : item.status === 'completed'
                  ? Check
                  : item.status === 'skipped'
                    ? Minus
                    : Loader2;
            return (
              <li
                key={`${item.phase}:${item.step}:${item.startedAt}`}
                className={`is-${item.status ?? 'running'}`}
              >
                <Icon
                  size={13}
                  aria-hidden
                  className={item.status === 'running' && !connectionError ? 'weq-spin' : undefined}
                />
                <div>
                  <span>{item.message}</span>
                  {item.objectName ? (
                    <span className="weq-db-progress-history-object">{item.objectName}</span>
                  ) : null}
                  <span className="weq-db-progress-history-count">
                    {countText(item)}
                    {item.status === 'skipped'
                      ? progress.status === 'cancelled' && item === progress.current
                        ? ' · 已停止'
                        : ' · 已跳过'
                      : ''}
                  </span>
                </div>
                <span>{duration((item.finishedAt ?? at) - item.startedAt)}</span>
              </li>
            );
          })}
        </ol>
      </details>
    </section>
  );
}
