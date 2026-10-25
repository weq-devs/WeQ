import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskList, type UiTask } from '../src/renderer/src/views/export/TaskList';

afterEach(() => vi.unstubAllGlobals());
const task: UiTask = {
  id: 'fixture',
  kind: 'group',
  name: '合成会话',
  format: 'json',
  status: 'paused',
  progress: 40,
  current: 1000,
  total: 3000,
  filePath: '/synthetic/messages.json',
  journalPath: '/synthetic/messages.jsonl',
  canResume: true,
  partialReady: true,
  stages: [
    { key: 'message', label: '导出消息', status: 'running', current: 1000, total: 3000 },
    { key: 'avatar', label: '导出头像', status: 'pending', current: 0, total: 0 },
  ],
};
it('暂停收尾后可保存现有进度，完成后显示增量操作', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const save = vi.fn(),
    incremental = vi.fn(),
    finalize = vi.fn();
  const render = (value: UiTask) =>
    act(() =>
      root.render(
        h(TaskList, {
          tasks: [value],
          detailOnly: true,
          onPause: vi.fn(),
          onCancel: vi.fn(),
          onDownload: save,
          onDelete: vi.fn(),
          onShowFailures: vi.fn(),
          onIncremental: incremental,
          onFinalize: finalize,
        }),
      ),
    );
  try {
    render({ ...task, partialReady: false });
    expect(host.querySelector('[title="保存现有进度"]')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[title="收尾"]')!.click());
    expect(finalize).toHaveBeenCalledOnce();
    render({ ...task, partialReady: false, canResume: false, isFinalizing: true });
    expect(host.textContent).toContain('收尾中');
    expect(host.textContent).not.toContain('暂停收尾中');
    render(task);
    act(() => host.querySelector<HTMLButtonElement>('[title="保存现有进度"]')!.click());
    expect(save).toHaveBeenCalledWith(task);
    render({ ...task, canResume: false });
    expect(host.querySelector('[title="保存现有进度"]')).toBeNull();
    render({ ...task, status: 'completed', canResume: false });
    act(() => host.querySelector<HTMLButtonElement>('[title="增量导出"]')!.click());
    expect(incremental).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('独立阶段支持单项跳过，正文没有跳过按钮', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    skip = vi.fn();
  try {
    const value: UiTask = {
      ...task,
      stages: task.stages.map((stage) => ({ ...stage, status: 'running' })),
    };
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
          onSkipStage: skip,
        }),
      ),
    );
    expect(host.querySelector('[title="跳过导出消息"]')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[title="跳过导出头像"]')!.click());
    expect(skip).toHaveBeenCalledWith(value, 'avatar');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
