import { useEffect, useRef, type ReactElement } from 'react';
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
}: {
  lines: readonly TaskLogLine[];
  collapsed: boolean;
  history?: boolean;
}): ReactElement {
  const visible = lines.slice(-MAX_VISIBLE_LOGS);
  const terminal = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (history && terminal.current) terminal.current.scrollTop = terminal.current.scrollHeight;
  }, [lines, history]);
  return (
    <div
      ref={terminal}
      className={`weq-exp-log${collapsed ? ' is-hidden' : ''}`}
      aria-hidden={collapsed}
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
