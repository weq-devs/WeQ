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

it('文件下载不提供假暂停，运行中和排队中均可取消，策略暂停可重新下载', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const resume = vi.fn(),
    cancel = vi.fn();
  const value: UiTask = {
    ...task,
    resource: { kind: 'media' },
    resumeMode: 'restart',
    networkPaused: true,
    journalPath: undefined,
    partialReady: false,
  };
  const render = (value: UiTask) =>
    act(() =>
      root.render(
        h(TaskList, {
          tasks: [value],
          detailOnly: true,
          onResume: resume,
          onCancel: cancel,
          onPause: vi.fn(),
          onDownload: vi.fn(),
          onDelete: vi.fn(),
          onShowFailures: vi.fn(),
        }),
      ),
    );
  try {
    render(value);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="重新下载"]')!.click());
    expect(resume).toHaveBeenCalledWith(value);
    act(() => host.querySelector<HTMLButtonElement>('[title="取消下载"]')!.click());
    expect(cancel).toHaveBeenCalledWith(value);
    expect(host.querySelector('[aria-label="重新执行导出"]')).toBeNull();
    for (const status of ['running', 'pending'] as const) {
      const active = { ...value, status, canResume: false, networkPaused: false };
      render(active);
      expect(host.querySelector('[title="暂停"]')).toBeNull();
      expect(host.querySelector('[aria-label="重新下载"]')).toBeNull();
      act(() => host.querySelector<HTMLButtonElement>('[title="取消下载"]')!.click());
      expect(cancel).toHaveBeenLastCalledWith(active);
    }
  } finally {
    act(() => root.unmount());
  }
});

it.each([
  'database',
  'assistant-artifact',
  'annual-report',
  'analytics-report',
  'persona-bot',
  'composition',
] as const)('%s 详情运行时使用方形取消图标，不再显示暂停', (kind) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const cancel = vi.fn();
  const value: UiTask = {
    ...task,
    status: 'running',
    canPause: false,
    canResume: false,
    journalPath: undefined,
    partialReady: false,
    resource: { kind },
  };
  try {
    act(() =>
      root.render(
        h(TaskList, {
          tasks: [value],
          detailOnly: true,
          onPause: vi.fn(),
          onCancel: cancel,
          onDownload: vi.fn(),
          onDelete: vi.fn(),
          onShowFailures: vi.fn(),
        }),
      ),
    );
    expect(host.querySelector('[title="暂停"]')).toBeNull();
    const button = host.querySelector<HTMLButtonElement>('[aria-label="取消"]')!;
    expect(button.querySelector('svg.lucide-square')).not.toBeNull();
    act(() => button.click());
    expect(cancel).toHaveBeenCalledWith(value);
  } finally {
    act(() => root.unmount());
  }
});

it.each(['favorite-emoji', 'mail-messages'] as const)(
  '%s 按实际能力提供暂停和播放图标续作，不使用重新执行图标',
  (kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    const pause = vi.fn(),
      resume = vi.fn();
    const base: UiTask = {
      ...task,
      journalPath: undefined,
      partialReady: false,
      resource: { kind },
      canPause: true,
      canResume: false,
      status: 'running',
      resumeMode: 'checkpoint',
    };
    const render = (value: UiTask) =>
      act(() =>
        root.render(
          h(TaskList, {
            tasks: [value],
            detailOnly: true,
            onPause: pause,
            onResume: resume,
            onCancel: vi.fn(),
            onDownload: vi.fn(),
            onDelete: vi.fn(),
            onShowFailures: vi.fn(),
          }),
        ),
      );
    try {
      render(base);
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click());
      expect(pause).toHaveBeenCalledWith(base);
      const paused = { ...base, status: 'paused' as const, canResume: true };
      render(paused);
      const button = host.querySelector<HTMLButtonElement>('[aria-label="继续导出"]')!;
      expect(button.querySelector('svg.lucide-play')).not.toBeNull();
      expect(host.querySelector('[aria-label="重新执行"]')).toBeNull();
      act(() => button.click());
      expect(resume).toHaveBeenCalledWith(paused);
    } finally {
      act(() => root.unmount());
    }
  },
);
