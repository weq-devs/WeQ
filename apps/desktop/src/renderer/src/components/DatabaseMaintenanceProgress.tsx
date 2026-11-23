import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Circle,
  Loader2,
  LockKeyhole,
  Minus,
} from 'lucide-react';
import {
  databaseStepPercent,
  type DatabaseTaskProgress,
  type DatabaseStepProgress,
} from '@weq/service/db-progress';
import {
  databaseMaintenanceStatusLabel,
  type DatabaseMaintenanceOperation,
} from '@weq/service/db-checkup';
import { formatBytesOrUnknown } from '../lib/format';
import { NumericText } from './NumericText';
import { TaskProgressBar } from './tasks/TaskProgressBar';
import '../styles/database-maintenance-progress.css';

const stages = {
  scan: [
    ['prepare', '准备扫描'],
    ['pages', '页扫描'],
  ],
  checkup: [
    ['prepare', '准备扫描'],
    ['pages', '页扫描'],
    ['integrity', '结构体检'],
  ],
  repair: [
    ['prepare', '修复准备'],
    ['decrypt', '解密源库'],
    ['rebuild', '数据重建'],
    ['output', '生成与检查产物'],
    ['commit', '替换数据库'],
    ['verify', '最终复核'],
  ],
} as const;
function stageKey(step: DatabaseStepProgress, kind: DatabaseTaskProgress['kind']): string {
  if (kind !== 'repair')
    return step.step.startsWith('integrity')
      ? 'integrity'
      : step.step === 'mapping'
        ? 'mapping'
        : step.step === 'pages'
          ? 'pages'
          : 'prepare';
  if (['wal', 'backup', 'preparing'].includes(step.phase)) return 'prepare';
  if (['Scan', 'Decrypt'].includes(step.phase)) return 'decrypt';
  if (step.phase === 'Repair') return 'rebuild';
  if (['Encrypt', 'Restore', 'Verify'].includes(step.phase)) return 'output';
  if (['source-check', 'swapping'].includes(step.phase)) return 'commit';
  return 'verify';
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
function attention(step: DatabaseStepProgress): boolean {
  return (
    step.status === 'failed' ||
    step.status === 'incomplete' ||
    step.status === 'skipped' ||
    step.outcome === 'abnormal' ||
    step.outcome === 'unverified'
  );
}
function label(step: DatabaseStepProgress, cancelled: boolean): string {
  if (step.status === 'incomplete') return '提前结束';
  if (step.status === 'failed') return step.outcome === 'abnormal' ? '异常 · 检查中断' : '未完成';
  if (step.status === 'skipped')
    return cancelled ? '已停止' : step.outcome === 'unverified' ? '无法校验' : '已跳过';
  if (step.status === 'completed')
    return step.outcome
      ? { normal: '正常', abnormal: '发现异常', unverified: '未判定' }[step.outcome]
      : '已完成';
  const percent = databaseStepPercent(step);
  return `${percent === undefined ? '处理中' : `${percent.toFixed(1)}%`}${step.outcome === 'abnormal' ? ' · 异常' : ''}`;
}

function groupIntegritySteps(steps: DatabaseStepProgress[]) {
  const standalone: DatabaseStepProgress[] = [];
  const groups = new Map<string, { title: string; steps: DatabaseStepProgress[] }>();
  for (const step of steps) {
    const isIndex = step.step.startsWith('integrity-index-');
    const tableName = isIndex
      ? step.tableName
      : step.step.startsWith('integrity-records-')
        ? step.objectName
        : undefined;
    if (!tableName && !isIndex) {
      standalone.push(step);
      continue;
    }
    const key = tableName ? `table:${tableName}` : 'indexes';
    let group = groups.get(key);
    if (!group) {
      group = { title: tableName ?? '索引核对', steps: [] };
      groups.set(key, group);
    }
    group.steps.push(step);
  }
  return { standalone, groups: [...groups].reverse() };
}

export function DatabaseMaintenanceProgress({
  progress,
  batch,
  connectionError,
  compact = false,
  showBatch = true,
  showBatchError = true,
  showMaintained = true,
  actions,
}: {
  progress: DatabaseTaskProgress;
  batch?: DatabaseMaintenanceOperation & { locked: boolean };
  connectionError?: boolean;
  compact?: boolean;
  /** 批次摘要已由外层页头表达时关闭，避免同一条计数出现两次。 */
  showBatch?: boolean;
  /** 外层报告已经展示批次错误时关闭。 */
  showBatchError?: boolean;
  /** 维护锁提示由外层状态卡表达时关闭。 */
  showMaintained?: boolean;
  actions?: ReactNode;
}) {
  const [now, setNow] = useState(Date.now);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const running = progress.status === 'running';
  const timing = batch ? batch.status === 'running' : running;
  useEffect(() => {
    if (!timing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timing]);
  const elapsed = batch
    ? batch.status === 'running'
      ? Math.max(now - batch.startedAt, batch.elapsedMs)
      : batch.elapsedMs
    : (running ? Math.max(now, progress.updatedAt) : progress.updatedAt) - progress.startedAt;
  const currentKey = stageKey(progress.current, progress.kind);
  const detailedPhases = new Set(
    progress.steps.filter((step) => step.step !== step.phase).map((step) => step.phase),
  );
  // 原生阶段起止回执不是额外工作步骤；保留带诊断、对象或计数的回执。
  const visibleSteps = progress.steps.filter(
    (step) =>
      progress.kind !== 'repair' ||
      !['Scan', 'Decrypt', 'Repair', 'Encrypt', 'Restore', 'Verify'].includes(step.phase) ||
      step.step !== step.phase ||
      !detailedPhases.has(step.phase) ||
      attention(step) ||
      step.detail ||
      step.objectName ||
      step.completed !== undefined,
  );
  const currentStep = visibleSteps.at(-1);
  const renderStep = (step: DatabaseStepProgress, sharedHeading: boolean, grouped = false) => {
    const isCurrent = step === currentStep;
    const executing = isCurrent && running && step.status === 'running';
    const percent = databaseStepPercent(step);
    const count = countText(step);
    const rate =
      executing &&
      now - step.updatedAt < 5000 &&
      step.rate &&
      ['pages', 'bytes'].includes(step.unit ?? '')
        ? `${step.unit === 'bytes' ? formatBytesOrUnknown(step.rate) : `${Math.round(step.rate).toLocaleString('zh-CN')} 页`}/秒`
        : undefined;
    const state =
      connectionError && executing ? '连接中断' : label(step, progress.status === 'cancelled');
    return (
      <div
        key={`${step.phase}:${step.step}:${step.startedAt}`}
        className={`weq-db-progress-entry is-${step.status ?? 'running'}${step.outcome ? ` is-${step.outcome}` : ''}`}
        aria-current={executing ? 'step' : undefined}
      >
        <div className="weq-db-progress-entry-body">
          {!sharedHeading ? (
            <div className="weq-db-progress-step">
              <span role={executing ? 'status' : undefined}>{step.message}</span>
              <strong>{state}</strong>
            </div>
          ) : null}
          {step.objectName && !(grouped && step.step.startsWith('integrity-records-')) ? (
            <p className="weq-db-progress-object">{step.objectName}</p>
          ) : null}
          {step.detail ? <p className="weq-db-progress-detail">{step.detail}</p> : null}
          {isCurrent && (executing || percent !== undefined) ? (
            <TaskProgressBar
              value={percent}
              status={connectionError ? 'paused' : progress.status}
              label="当前步骤进度"
              valueText={count ?? state}
            />
          ) : null}
          {count || step.badPages !== undefined || step.zeroPages || rate ? (
            <div className="weq-db-progress-readouts">
              {count ? (
                <span>
                  <NumericText>{count}</NumericText>
                </span>
              ) : null}
              {step.badPages !== undefined ? (
                <span>
                  <NumericText>{`已发现 ${step.badPages.toLocaleString('zh-CN')} 个坏页`}</NumericText>
                </span>
              ) : null}
              {step.zeroPages ? (
                <span>
                  <NumericText>{`${step.zeroPages.toLocaleString('zh-CN')} 个全零页`}</NumericText>
                </span>
              ) : null}
              {rate ? (
                <span>
                  <NumericText>{`当前速度 ${rate}`}</NumericText>
                </span>
              ) : null}
            </div>
          ) : null}
          {step.status === 'skipped' && !step.detail ? <Minus size={12} aria-hidden /> : null}
        </div>
      </div>
    );
  };
  const basePlan = stages[progress.kind];
  const plan = progress.steps.some((step) => step.step === 'mapping')
    ? [...basePlan.slice(0, 2), ['mapping', '归属分析'] as const, ...basePlan.slice(2)]
    : basePlan;
  const currentIndex = plan.findIndex(([key]) => key === currentKey);
  const abnormal = progress.steps.filter((step) => step.outcome === 'abnormal').length;
  return (
    <section
      className={`weq-db-progress${compact ? ' is-compact' : ''} is-${progress.status}`}
      aria-label={`${progress.dbName}维护进度`}
    >
      <header className="weq-db-progress-heading">
        <strong>{progress.dbName}</strong>
        <span>
          <NumericText>{`总耗时 ${duration(elapsed)}`}</NumericText>
        </span>
      </header>
      {batch && showBatch ? (
        <div className="weq-db-progress-batch">
          <span>
            <NumericText>{`已完成 ${batch.completedDatabases} / ${batch.totalDatabases} 个数据库${batch.failedDatabases ? ` · ${batch.failedDatabases} 个未完成` : ''}`}</NumericText>
          </span>
          <span>
            {batch.stopping ? '停止收尾中' : databaseMaintenanceStatusLabel[batch.status]}
          </span>
        </div>
      ) : null}
      {actions}
      {abnormal ? <p className="weq-db-progress-warning">异常步骤 {abnormal}</p> : null}
      {showBatchError && batch?.error ? (
        <p className="weq-db-progress-warning" role="alert">
          {batch.error}
        </p>
      ) : null}
      <ol
        className="weq-db-progress-timeline"
        aria-label={`${{ scan: '扫描', checkup: '体检', repair: '修复' }[progress.kind]}阶段`}
      >
        {plan.map(([key, title], index) => {
          const steps = visibleSteps.filter((step) => stageKey(step, progress.kind) === key);
          if (!steps.length && (!running || index <= currentIndex)) return null;
          const { standalone, groups } =
            key === 'integrity' ? groupIntegritySteps(steps) : { standalone: steps, groups: [] };
          const active = running && currentKey === key;
          const needsAttention = steps.some(attention);
          const pending = !steps.length;
          const sharedHeading = steps.length === 1 && groups.length === 0;
          const open = active || needsAttention || (expanded[key] ?? false);
          const Icon = active ? Loader2 : needsAttention ? AlertTriangle : pending ? Circle : Check;
          return (
            <li
              key={key}
              className={`weq-db-progress-stage${active ? ' is-current' : ''}${pending ? ' is-pending' : ''}`}
            >
              <details
                open={open}
                onToggle={(event) => {
                  if (active || needsAttention) {
                    event.currentTarget.open = true;
                    return;
                  }
                  const value = event.currentTarget.open;
                  setExpanded((old) => (old[key] === value ? old : { ...old, [key]: value }));
                }}
              >
                <summary
                  aria-disabled={pending || undefined}
                  tabIndex={pending ? -1 : undefined}
                  onClick={(event) => {
                    if (pending) event.preventDefault();
                  }}
                >
                  <span className="weq-db-progress-node" aria-hidden>
                    <Icon
                      size={13}
                      className={active && !connectionError ? 'weq-spin' : undefined}
                    />
                  </span>
                  <span>{sharedHeading ? steps[0]!.message : title}</span>
                  <strong>
                    {sharedHeading
                      ? connectionError && active
                        ? '连接中断'
                        : label(steps[0]!, progress.status === 'cancelled')
                      : active
                        ? '进行中'
                        : pending
                          ? '待开始'
                          : needsAttention
                            ? '需查看'
                            : '已完成'}
                  </strong>
                  {!pending ? (
                    <ChevronRight className="weq-db-progress-chevron" size={14} aria-hidden />
                  ) : null}
                </summary>
                {standalone.map((step) => renderStep(step, sharedHeading))}
                {groups.map(([groupKey, group]) => {
                  const active =
                    running &&
                    currentStep?.status === 'running' &&
                    group.steps.includes(currentStep);
                  const needsAttention = group.steps.some(attention);
                  return (
                    <details
                      key={groupKey}
                      className="weq-db-progress-table"
                      open={active || needsAttention || undefined}
                    >
                      <summary>
                        <ChevronRight className="weq-db-progress-chevron" size={14} aria-hidden />
                        <span>{group.title}</span>
                        <strong>{active ? '进行中' : needsAttention ? '需查看' : '已完成'}</strong>
                      </summary>
                      {group.steps.map((step) => renderStep(step, false, true))}
                    </details>
                  );
                })}
              </details>
            </li>
          );
        })}
      </ol>
      {showMaintained && batch?.locked && batch.status !== 'running' ? (
        <p className="weq-db-progress-maintained" role="status">
          <LockKeyhole size={14} />
          数据库仍在维护中，等待决定
        </p>
      ) : null}
      {connectionError ? (
        <p className="weq-db-progress-warning" role="alert">
          进度连接中断，正在重新连接；任务结果尚未确认。
        </p>
      ) : null}
    </section>
  );
}
