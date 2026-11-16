import { ChevronDown } from 'lucide-react';
import { TaskLogConsole, type TaskLogLine } from './TaskLogConsole';
import '../styles/export.css';

export function TaskLogDisclosure({
  open,
  onOpenChange,
  lines,
  error,
  scrollable = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: readonly TaskLogLine[];
  error?: string;
  scrollable?: boolean;
}) {
  return (
    <div className="weq-exp-detail-tasklog">
      <button
        type="button"
        className="weq-exp-detail-tasklog-head"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span className="weq-exp-detail-tasklog-title">任务日志</span>
        <ChevronDown size={12} className={open ? 'is-open' : ''} />
      </button>
      {open ? (
        <>
          <TaskLogConsole lines={lines} collapsed={false} history scrollable={scrollable} />
          {error ? <p role="alert">日志读取失败：{error}</p> : null}
        </>
      ) : null}
    </div>
  );
}
