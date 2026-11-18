import { NumericText } from '../NumericText';
import { useEffect, useState } from 'react';
import { formatDuration } from '@weq/time';
import { TimeLabel } from '../TimeLabel';
import { longTaskProgress, longTaskStatusLabel } from './LongTaskRow.shared';
import type { LongTaskStatus } from './LongTaskRow';
import { TaskProgressBar } from './TaskProgressBar';
import { taskDisplayTitle, type TaskDisplay } from '@weq/service/task-display';
import { TaskName, TaskOriginalName } from './TaskName';

export function TaskProgressDetails({
  name,
  display,
  status,
  statusLabel,
  progress: rawProgress,
  note,
  startedAt,
  finishedAt,
}: {
  name: string;
  display?: TaskDisplay;
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
    <section
      className={`weq-task-progress-details is-${status}`}
      aria-label={`${display ? taskDisplayTitle(display) : name}进度详情`}
    >
      <header>
        <strong>{display ? <TaskName display={display} /> : name}</strong>
        <span>{statusLabel ?? longTaskStatusLabel(status)}</span>
      </header>
      {display ? (
        <>
          <TaskOriginalName name={name} display={display} />
          {display.context ? <p>{display.context}</p> : null}
        </>
      ) : null}
      <div className="weq-task-progress-metric">
        <span>任务进度</span>
        <strong>
          {progress !== undefined ? (
            <NumericText>{`${progress}%`}</NumericText>
          ) : status === 'running' ? (
            '处理中'
          ) : status === 'pending' ? (
            '等待开始'
          ) : (
            '未提供进度'
          )}
        </strong>
      </div>
      <TaskProgressBar value={progress} label="任务进度" status={status} />
      {note ? <p role={status === 'failed' ? 'alert' : undefined}>{note}</p> : null}
      {startedAt ? (
        <div className="weq-task-progress-times">
          <span>
            开始于 <TimeLabel value={startedAt} />
          </span>
          {elapsed ? (
            <span>
              耗时{' '}
              <NumericText>
                {formatDuration(Math.max(0, Math.floor((elapsed - startedAt) / 1000)))}
              </NumericText>
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
