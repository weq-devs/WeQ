import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactTaskStages } from '../src/renderer/src/components/tasks/ContactTaskStages';
import type { BackgroundTask } from '../src/shared/background_task';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onShowFailures = vi.fn();
  const task: BackgroundTask = {
    id: 'synthetic-refresh',
    kind: 'contacts',
    name: '刷新联系人列表',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    actions: [],
    subtasks: [
      { label: '好友', done: 1, total: 4, failed: 0 },
      { label: '群聊', done: 3, total: 6, failed: 0 },
    ],
  };
  const logs = [
    { ts: 1, seq: 1, stage: 'friends', level: 'info' as const, text: '好友合成日志' },
    { ts: 2, seq: 2, stage: 'groups', level: 'error' as const, text: '失败：群聊合成错误' },
  ];
  const render = (patch: Partial<BackgroundTask> = {}) =>
    act(() =>
      root.render(h(ContactTaskStages, { task: { ...task, ...patch }, logs, onShowFailures })),
    );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, task, render, onShowFailures };
}

it('好友和群聊复用导出子任务样式，分别显示进度并独立完成', () => {
  const { host, render } = mount();
  render();
  const stages = host.querySelectorAll('.weq-exp-detail-stage');
  expect(stages).toHaveLength(2);
  expect(
    [...host.querySelectorAll('.weq-exp-detail-stage-pct')].map((node) => node.textContent),
  ).toEqual(['25%', '50%']);
  expect(host.querySelectorAll('.weq-exp-detail-stage-fill.is-active')).toHaveLength(2);
  render({
    subtasks: [
      { label: '好友', done: 1, total: 4, failed: 0 },
      { label: '群聊', done: 6, total: 6, failed: 0 },
    ],
  });
  expect(stages[0]?.classList.contains('is-running')).toBe(true);
  expect(stages[1]?.classList.contains('is-completed')).toBe(true);
  expect(host.querySelectorAll('.weq-exp-detail-stage-fill.is-active')).toHaveLength(1);
});

it('分项日志不混用，失败详情只包含对应群聊错误', () => {
  const { host, render, onShowFailures } = mount();
  render({
    subtasks: [
      { label: '好友', done: 1, total: 4, failed: 0 },
      { label: '群聊', done: 6, total: 6, failed: 1 },
    ],
  });
  const stages = host.querySelectorAll('.weq-exp-detail-stage');
  act(() => stages[0]!.querySelector<HTMLButtonElement>('.weq-exp-detail-stage-toggle')!.click());
  expect(stages[0]?.textContent).toContain('好友合成日志');
  expect(stages[0]?.textContent).not.toContain('群聊合成错误');
  act(() => stages[1]!.querySelector<HTMLButtonElement>('.weq-exp-detail-stage-toggle')!.click());
  expect(stages[1]?.textContent).toContain('群聊合成错误');
  expect(stages[1]?.textContent).not.toContain('好友合成日志');
  act(() => stages[1]!.querySelector<HTMLButtonElement>('.weq-exp-detail-stage-failures')!.click());
  expect(onShowFailures).toHaveBeenCalledWith('群聊', [
    { stage: 'groups', fileName: '群聊', error: '失败：群聊合成错误' },
  ]);
});

it.each(['paused', 'cancelled', 'failed'] as const)('%s 时停止未完成子任务动画', (status) => {
  const { host, render } = mount();
  render({ status });
  expect(host.querySelectorAll('.weq-exp-detail-stage-fill.is-active')).toHaveLength(0);
});

it('空分项显示跳过，不伪造进度；准备阶段没有分项时不显示空容器', () => {
  const { host, render } = mount();
  render({ subtasks: [{ label: '群聊', done: 0, total: 0, failed: 0 }] });
  expect(host.querySelector('.weq-exp-detail-stage.is-skipped')).not.toBeNull();
  render({ subtasks: undefined });
  expect(host.querySelector('.weq-exp-detail-stages')).toBeNull();
});
