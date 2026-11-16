import { TaskLogConsole, type TaskLogLine } from '../TaskLogConsole';

export function TaskActivityLog({
  lines,
  loading,
  error,
}: {
  lines: readonly TaskLogLine[];
  loading?: boolean;
  error?: string;
}) {
  return (
    <section className="weq-task-activity" aria-label="任务过程日志">
      <header>
        <strong>任务日志</strong>
        <span>{loading ? '读取中…' : `${lines.length} 条记录`}</span>
      </header>
      <TaskLogConsole lines={lines} collapsed={false} scrollable />
      {error ? <p role="alert">日志读取失败：{error}</p> : null}
    </section>
  );
}
