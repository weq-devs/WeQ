import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TaskProgressBar } from '../src/renderer/src/components/tasks/TaskProgressBar';

it.each([
  [-10, '0'],
  [125, '100'],
  [42.5, '42.5'],
  [NaN, null],
  [Infinity, null],
  [undefined, null],
])('统一进度组件保留真实数值并处理异常值 %s', (value, expected) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(h(TaskProgressBar, { value, label: '任务进度' }));
  expect(host.querySelector('progress')?.getAttribute('value')).toBe(expected);
  expect(host.querySelector('progress')?.getAttribute('max')).toBe('100');
  expect(host.querySelector('.is-indeterminate') !== null).toBe(expected === null);
  expect(host.querySelector('progress')?.getAttribute('aria-label')).toBe('任务进度');
});

it.each(['running', 'paused', 'failed', 'completed', 'pending', 'cancelled'])(
  '%s 使用同一轨道与填充结构，仅按状态切换语义色',
  (status) => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(h(TaskProgressBar, { value: 42, label: '任务', status }));
    expect(host.querySelector(`.weq-task-progress-track.is-${status} > progress`)).not.toBeNull();
    expect(host.querySelector('progress')?.getAttribute('value')).toBe('42');
  },
);
