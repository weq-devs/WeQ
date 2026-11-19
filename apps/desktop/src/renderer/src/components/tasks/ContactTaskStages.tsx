import type { ContactMetricsLaneKey } from '@weq/service';
import type { BackgroundTask } from '../../../../shared/background_task';
import { StageRow, type UiLogLine, type UiStage } from '../../views/export/TaskList';

export function ContactTaskStages({
  task,
  logs,
  onShowFailures,
}: {
  task: BackgroundTask;
  logs: UiLogLine[];
  onShowFailures: (lane: ContactMetricsLaneKey, label: string) => void;
}) {
  if (!task.subtasks?.length) return null;
  return (
    <div className="weq-exp-detail-stages weq-contact-task-stages" data-privacy-sensitive>
      {task.subtasks.map((lane) => {
        const key = lane.label === '好友' ? 'friends' : 'groups';
        const status: UiStage['status'] =
          lane.total === 0
            ? 'skipped'
            : lane.done >= lane.total
              ? lane.failed
                ? 'failed'
                : 'completed'
              : task.status === 'failed'
                ? 'failed'
                : 'running';
        return (
          <StageRow
            key={key}
            logMode="expanded"
            stage={{
              key,
              label: `${lane.label} ${lane.total ? `已处理 ${lane.done}/${lane.total}` : '无需更新'}`,
              current: lane.done,
              total: lane.total,
              status,
            }}
            logs={logs.filter((line) => line.stage === key)}
            paused={task.status !== 'running'}
            failureCount={lane.failed}
            onShowFailures={() => onShowFailures(key, lane.label)}
          />
        );
      })}
    </div>
  );
}
