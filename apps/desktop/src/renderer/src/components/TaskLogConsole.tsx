import { useLayoutEffect, useRef, type ReactElement } from 'react';
import '../styles/task-log-console.css';
export interface TaskLogLine {
  ts: number;
  seq: number;
  stage: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

const logTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
});
function fmtLogTime(ts: number): string {
  return logTimeFormat.format(ts);
}

const MAX_VISIBLE_LOGS = 5;

export function TaskLogConsole({
  lines,
  collapsed,
  history = false,
  appearance = 'default',
}: {
  lines: readonly TaskLogLine[];
  collapsed: boolean;
  history?: boolean;
  appearance?: 'default' | 'export';
}): ReactElement {
  const canScroll = appearance === 'export';
  const visible = canScroll ? lines : lines.slice(-MAX_VISIBLE_LOGS);
  const terminal = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const lastSequence = lines.at(-1)?.seq;
  useLayoutEffect(() => {
    if (!collapsed && (history || canScroll) && followTail.current && terminal.current)
      terminal.current.scrollTop = terminal.current.scrollHeight;
  }, [lastSequence, collapsed, history, canScroll]);
  return (
    <div
      ref={terminal}
      className={`weq-exp-log${canScroll ? ' is-export-scrollable' : ''}${collapsed ? ' is-hidden' : ''}`}
      aria-hidden={collapsed}
      role={canScroll ? 'log' : undefined}
      aria-label={canScroll ? '任务日志' : undefined}
      tabIndex={canScroll && !collapsed ? 0 : undefined}
      onScroll={
        canScroll
          ? (event) => {
              const element = event.currentTarget;
              followTail.current =
                element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
            }
          : undefined
      }
    >
      {visible.length === 0 ? (
        <div className="weq-exp-log-empty">— 暂无日志 —</div>
      ) : (
        visible.map((l) => (
          <div key={l.seq} className={`weq-exp-log-line is-${l.level}`}>
            <span className="weq-exp-log-time">{fmtLogTime(l.ts)}</span>
            <span className="weq-exp-log-text">{l.text}</span>
          </div>
        ))
      )}
    </div>
  );
}
