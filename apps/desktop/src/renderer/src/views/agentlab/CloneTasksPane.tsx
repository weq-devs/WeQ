import { useState, useSyncExternalStore } from 'react';
import { Eye, Trash2 } from 'lucide-react';
import { QqAvatar } from '../../components/QqAvatar';
import { useViewState } from '../../state/view';
import { CloneProgressModal } from './CloneProgressModal';
import { dismissCloneTask, getCloneTasks, subscribeCloneTasks } from './cloneTaskStore';
import '../../styles/clone-tasks.css';

export function CloneTasksPane({ onOpenPersona }: { onOpenPersona?: (id: string) => void }) {
  const accountId = useViewState((state) => state.openedUin);
  const allTasks = useSyncExternalStore(subscribeCloneTasks, getCloneTasks);
  const tasks = allTasks.filter((task) => task.accountId === accountId);
  const [selected, setSelected] = useState<string | null>(null);
  const viewing = tasks.find((task) => task.personaId === selected);
  return (
    <div className="weq-clone-tasks">
      {tasks.length === 0 ? (
        <div className="weq-exp-sched-empty">
          <strong>暂无克隆任务</strong>
        </div>
      ) : (
        tasks.map((task) => (
          <div className="weq-clone-task-row" key={task.personaId}>
            <QqAvatar uin={task.uin} size={34} />
            <button
              type="button"
              className="weq-clone-task-summary"
              onClick={() => setSelected(task.personaId)}
            >
              <strong>{task.name}</strong>
              <span>
                {task.status === 'running'
                  ? `${task.phase} · ${Math.round(task.percent)}%`
                  : task.status === 'done'
                    ? '克隆完成'
                    : task.error || '克隆失败'}
              </span>
              {task.status === 'running' ? (
                <progress max={100} value={task.percent} aria-label={`${task.name}克隆进度`} />
              ) : null}
            </button>
            <button
              type="button"
              className="weq-set-iconbtn"
              title="查看克隆进度"
              aria-label={`查看${task.name}的克隆进度`}
              onClick={() => setSelected(task.personaId)}
            >
              <Eye size={16} />
            </button>
            <button
              type="button"
              className="weq-set-iconbtn"
              title="移除任务"
              aria-label={`移除${task.name}的克隆任务`}
              disabled={task.status === 'running'}
              onClick={() => dismissCloneTask(task.personaId)}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))
      )}
      {viewing ? (
        <CloneProgressModal
          task={viewing}
          onHide={() => setSelected(null)}
          onDismiss={(id) => {
            dismissCloneTask(id);
            setSelected(null);
          }}
          onOpenPersona={(id) => {
            setSelected(null);
            onOpenPersona?.(id);
          }}
        />
      ) : null}
    </div>
  );
}
