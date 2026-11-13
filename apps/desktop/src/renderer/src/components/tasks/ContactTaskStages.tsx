import type { BackgroundTask } from '../../../../shared/background_task';
import {
  StageRow,
  type UiFailure,
  type UiLogLine,
  type UiStage,
} from '../../views/export/TaskList';

export function ContactTaskStages({
  task,
  logs,
  onShowFailures,
}: {
  task: BackgroundTask;
  logs: UiLogLine[];
  onShowFailures: (label: string, failures: UiFailure[]) => void;
}) {
  if (!task.subtasks?.length) return null;
  return (
    <div className="weq-exp-detail-stages" data-privacy-sensitive>
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
        const laneLogs = logs.filter((line) => line.stage === key);
        const failures = lane.failed
          ? laneLogs
              .filter((line) => line.level === 'error' && line.text.startsWith('失败：'))
              .slice(-lane.failed)
              .map((line) => ({ stage: key, fileName: lane.label, error: line.text }))
          : [];
        return (
          <StageRow
            key={key}
            logMode="expanded"
            stage={{
              key,
              label: `${lane.label} ${lane.done}/${lane.total}`,
              current: lane.done,
              total: lane.total,
              failed: lane.failed,
              failures,
              status,
            }}
            logs={laneLogs}
            paused={task.status !== 'running'}
            onShowFailures={(items) => onShowFailures(lane.label, items)}
          />
        );
      })}
    </div>
  );
}
