import { useEffect, useState } from 'react';
import { formatDuration } from '@weq/time';
import { TimeLabel } from '../TimeLabel';
import { longTaskProgress, longTaskStatusLabel, type LongTaskStatus } from './LongTaskRow';
import { TaskProgressBar } from './TaskProgressBar';

export function TaskProgressDetails({
  name,
  status,
  statusLabel,
  progress: rawProgress,
  note,
  startedAt,
  finishedAt,
}: {
  name: string;
  status: LongTaskStatus;
  statusLabel?: string;
  progress?: number;
  note?: string;
  startedAt?: number;
  finishedAt?: number;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (status !== 'running' || !startedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status, startedAt]);
  const progress = longTaskProgress(rawProgress);
  const elapsed = startedAt && (finishedAt || (status === 'running' ? now : undefined));
  return (
    <section className={`weq-task-progress-details is-${status}`} aria-label={`${name}进度详情`}>
      <header>
        <strong>{name}</strong>
        <span>{statusLabel ?? longTaskStatusLabel(status)}</span>
      </header>
      <div className="weq-task-progress-metric">
        <span>任务进度</span>
        <strong>
          {progress !== undefined
            ? `${progress}%`
            : status === 'running'
              ? '处理中'
              : status === 'pending'
                ? '等待开始'
                : '未提供进度'}
        </strong>
      </div>
      <TaskProgressBar value={progress} label={`${name}进度`} status={status} />
      {note ? <p role={status === 'failed' ? 'alert' : undefined}>{note}</p> : null}
      {startedAt ? (
        <div className="weq-task-progress-times">
          <span>
            开始于 <TimeLabel value={startedAt} />
          </span>
          {elapsed ? (
            <span>
              耗时 {formatDuration(Math.max(0, Math.floor((elapsed - startedAt) / 1000)))}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
