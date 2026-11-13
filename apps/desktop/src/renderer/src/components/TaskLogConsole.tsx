import { TimeLabel } from './TimeLabel';
import { preciseClockFormatter } from '@weq/time';
import { useLayoutEffect, useRef, type ReactElement } from 'react';
import '../styles/task-log-console.css';
export interface TaskLogLine {
  ts: number;
  seq: number;
  stage: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

const logTimeFormat = preciseClockFormatter;
function fmtLogTime(ts: number): string {
  return logTimeFormat.format(ts);
}

const MAX_VISIBLE_LOGS = 5;

export function TaskLogConsole({
  lines,
  collapsed,
  history = false,
  scrollable = false,
  appearance = 'default',
  autoFollow = true,
}: {
  lines: readonly TaskLogLine[];
  collapsed: boolean;
  history?: boolean;
  scrollable?: boolean;
  appearance?: 'default' | 'export';
  autoFollow?: boolean;
}): ReactElement {
  const canScroll = scrollable || appearance === 'export';
  const visible = canScroll ? lines : lines.slice(-MAX_VISIBLE_LOGS);
  const terminal = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const lastSequence = lines.at(-1)?.seq;
  useLayoutEffect(() => {
    if (
      autoFollow &&
      !collapsed &&
      (history || canScroll) &&
      followTail.current &&
      terminal.current
    )
      terminal.current.scrollTop = terminal.current.scrollHeight;
  }, [lastSequence, collapsed, history, canScroll, autoFollow]);
  return (
    <div
      ref={terminal}
      className={`weq-exp-log${canScroll ? (appearance === 'export' ? ' is-export-scrollable' : ' is-scrollable') : ''}${collapsed ? ' is-hidden' : ''}`}
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
            <TimeLabel className="weq-exp-log-time" value={l.ts} precision="millisecond">
              {fmtLogTime(l.ts)}
            </TimeLabel>
            <span className="weq-exp-log-text">{l.text}</span>
          </div>
        ))
      )}
    </div>
  );
}
