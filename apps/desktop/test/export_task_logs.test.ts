import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskList, type UiTask } from '../src/renderer/src/views/export/TaskList';

const cleanup: Array<() => void> = [];
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.unstubAllGlobals();
});

function fixture(status: 'completed' | 'running' = 'completed'): UiTask {
  return {
    id: 'synthetic-task',
    kind: 'group',
    name: '合成导出任务',
    format: 'json',
    status,
    progress: 100,
    current: 1,
    total: 1,
    stages: [{ key: 'message', label: '导出消息', status, current: 1, total: 1 }],
    logs: [
      { ts: 1, seq: 1, stage: 'message', level: 'info', text: '合成消息导出完成' },
      { ts: 2, seq: 2, stage: 'task', level: 'info', text: '合成任务完成' },
    ],
  };
}

function mount(task: UiTask) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (value: UiTask) =>
    act(() =>
      root.render(
        h(TaskList, {
          tasks: [value],
          detailOnly: true,
          onPause: vi.fn(),
          onCancel: vi.fn(),
          onDownload: vi.fn(),
          onDelete: vi.fn(),
          onShowFailures: vi.fn(),
        }),
      ),
    );
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  render(task);
  return { host, render };
}

function expectToggle(container: Element, text: string) {
  const button = container.querySelector<HTMLButtonElement>('button')!;
  const log = container.querySelector('.weq-exp-log')!;
  expect(button).not.toBeNull();
  expect(button.disabled).toBe(false);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(log.getAttribute('aria-hidden')).toBe('true');
  act(() => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(log.getAttribute('aria-hidden')).toBe('false');
  expect(log.textContent).toContain(text);
  act(() => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(log.getAttribute('aria-hidden')).toBe('true');
}

it('已完成任务的阶段日志和任务日志均可反复展开与收起', () => {
  const { host } = mount(fixture());
  expectToggle(host.querySelector('.weq-exp-detail-stage')!, '合成消息导出完成');
  const taskLog = host.querySelector('.weq-exp-detail-tasklog');
  expect(taskLog).not.toBeNull();
  expectToggle(taskLog!, '合成任务完成');
});

it('运行结束自动收起日志，完成后仍可重新展开', () => {
  const { host, render } = mount(fixture('running'));
  for (const button of host.querySelectorAll<HTMLButtonElement>(
    '.weq-exp-detail-stage-toggle, .weq-exp-detail-tasklog-head',
  )) {
    act(() => button.click());
  }
  expect(host.querySelectorAll('.weq-exp-log[aria-hidden="false"]')).toHaveLength(2);
  render(fixture());
  expect(host.querySelectorAll('.weq-exp-log[aria-hidden="false"]')).toHaveLength(0);
  expectToggle(host.querySelector('.weq-exp-detail-stage')!, '合成消息导出完成');
  expectToggle(host.querySelector('.weq-exp-detail-tasklog')!, '合成任务完成');
});

it('已跳过的阶段可查看保留的日志，无日志的已完成任务也能展开', () => {
  const task = fixture();
  task.stages![0]!.status = 'skipped';
  const { host, render } = mount(task);
  expectToggle(host.querySelector('.weq-exp-detail-stage')!, '合成消息导出完成');
  render({ ...fixture(), logs: [] });
  expectToggle(host.querySelector('.weq-exp-detail-stage')!, '暂无日志');
  expectToggle(host.querySelector('.weq-exp-detail-tasklog')!, '暂无日志');
});
