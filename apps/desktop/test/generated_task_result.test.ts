import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TaskList, type UiTask } from '../src/renderer/src/views/export/TaskList';

it('生成资源缺失在完成结果中可见并可查看明细，暂停收尾不会误显为可立即恢复', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const failures = [{ stage: 'media', fileName: 'missing.wav', error: '本地资源不存在' }];
  const show = vi.fn();
  const task: UiTask = {
    id: 'generated',
    name: '合成对话',
    kind: 'c2c',
    format: 'json',
    status: 'completed',
    current: 2,
    total: 2,
    progress: 100,
    isGenerated: true,
    generatedResources: { total: 3, copied: 2, missing: 1 },
    stages: [
      {
        key: 'media',
        label: '保存生成资源',
        status: 'completed',
        current: 3,
        total: 3,
        failed: 1,
        failures,
      },
    ],
  };
  const render = (item: UiTask) =>
    act(() =>
      root.render(
        createElement(TaskList, {
          tasks: [item],
          isExpanded: true,
          onPause: vi.fn(),
          onResume: vi.fn(),
          onCancel: vi.fn(),
          onDownload: vi.fn(),
          onDelete: vi.fn(),
          onShowFailures: show,
        }),
      ),
    );
  try {
    render(task);
    expect(host.querySelector('.weq-exp-detail-status')?.textContent).toContain('资源缺失');
    expect(host.textContent).toContain('已保存 2 项');
    expect(host.textContent).toContain('缺失 1 项');
    act(() => host.querySelector<HTMLButtonElement>('.weq-exp-detail-stage-failures')!.click());
    expect(show).toHaveBeenCalledWith(task, failures);
    render({ ...task, status: 'paused', canResume: false, resumeMode: 'restart' });
    expect(host.querySelector('.weq-exp-detail-status')?.textContent).toContain('暂停收尾中');
    expect(host.querySelector('[aria-label="重新执行导出"]')).toBeNull();
    render({ ...task, generatedResources: { total: 3, copied: 3, missing: 0 } });
    expect(host.querySelector('.weq-exp-detail-status')?.textContent).toBe('已完成');
    render({ ...task, status: 'paused', canResume: false, isGenerated: false, isCollection: true });
    expect(host.querySelector('.weq-exp-detail-status')?.textContent).toBe('暂停中');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
