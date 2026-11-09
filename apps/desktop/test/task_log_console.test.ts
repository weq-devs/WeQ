import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TaskLogConsole } from '../src/renderer/src/components/TaskLogConsole';

it.each([false, true])('日志预览保留最近五条且不提供完整任务日志入口（history=%s）', (history) => {
  const lines = Array.from({ length: 8 }, (_, seq) => ({
    ts: 0,
    seq,
    stage: 'task',
    level: 'warn' as const,
    text: `批次 ${seq}`,
  }));
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    createElement(TaskLogConsole, { lines, collapsed: false, history }),
  );
  expect(host.querySelectorAll('.weq-exp-log-line')).toHaveLength(5);
  expect(host.querySelector('.weq-exp-log-text')?.textContent).toBe('批次 3');
  expect(host.querySelector('.weq-exp-log-time')?.textContent).toBe('08:00:00.000');
  expect(host.querySelector('.weq-exp-log-line')?.className).toContain('is-warn');
  expect(host.querySelector('details')).toBeNull();
  expect(host.textContent).not.toContain('完整任务日志');
});
