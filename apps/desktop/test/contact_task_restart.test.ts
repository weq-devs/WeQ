import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TaskList, type UiTask } from '../src/renderer/src/views/export/TaskList';

it('联系人暂停恢复明确显示重新执行，消息断点仍显示继续导出', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const resume = vi.fn();
  const task: UiTask = {
    id: 'fixture-contact',
    name: '合成精确联系人',
    kind: 'c2c',
    format: 'json',
    status: 'paused',
    current: 1,
    total: 1,
    progress: 0,
    canResume: true,
    resumeMode: 'restart',
    isContacts: true,
    stages: [],
    logs: [],
  };
  const render = (item: UiTask) =>
    act(() =>
      root.render(
        createElement(TaskList, {
          tasks: [item],
          isExpanded: true,
          onPause: vi.fn(),
          onResume: resume,
          onCancel: vi.fn(),
          onDownload: vi.fn(),
          onDelete: vi.fn(),
          onShowFailures: vi.fn(),
        }),
      ),
    );
  try {
    render({ ...task, canResume: false });
    expect(host.textContent).toContain('暂停收尾中');
    expect(host.querySelector('[aria-label="重新执行导出"]')).toBeNull();
    render(task);
    expect(host.querySelector('[aria-label="继续导出"]')).toBeNull();
    expect(host.querySelector('.weq-exp-detail-meta')?.textContent).toMatch(/1\s*\/\s*1\s*位/);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="重新执行导出"]')!.click());
    expect(resume).toHaveBeenCalledWith(task);
    render({ ...task, id: 'fixture-message', isContacts: false, resumeMode: 'checkpoint' });
    expect(host.querySelector('[aria-label="重新执行导出"]')).toBeNull();
    expect(host.querySelector('[aria-label="继续导出"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
