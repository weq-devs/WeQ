import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskList, type UiTask } from '../src/renderer/src/views/export/TaskList';

afterEach(() => vi.unstubAllGlobals());
it.each([
  ['market-image', '商城单张表情保存'],
  ['mail-attachment', '邮件附件保存'],
  ['decoration', '装扮资源保存'],
  ['qzone-albums', '空间相册导出'],
  ['annual-report', '年度报告导出'],
  ['media', '媒体文件保存'],
] as const)('独立资源 %s 展示真实任务类型', (kind, label) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    noop = vi.fn();
  try {
    act(() =>
      root.render(
        h(TaskList, {
          tasks: [
            {
              id: 'fixture',
              kind: 'c2c',
              name: '合成资源',
              format: 'json',
              status: 'completed',
              progress: 100,
              current: 1,
              total: 1,
              resource: { kind },
            },
          ],
          isExpanded: true,
          onPause: noop,
          onCancel: noop,
          onDownload: noop,
          onDelete: noop,
          onShowFailures: noop,
        }),
      ),
    );
    expect(host.textContent).toContain(label);
    expect(host.textContent).not.toContain('群文件导出');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
it('资源任务不伪装为 JSON 消息导出，部分下载失败仍展示保存入口与缺失状态', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const noop = vi.fn();
  const task: UiTask = {
    id: 'resource',
    kind: 'c2c',
    name: '合成群文件',
    format: 'json',
    status: 'completed',
    progress: 100,
    current: 1,
    total: 2,
    bundleDir: '/synthetic/cache',
    resource: { kind: 'group-files', failed: 1 },
    stages: [
      {
        key: 'file',
        label: '下载资源',
        status: 'completed',
        current: 1,
        total: 2,
        failed: 1,
        failures: [{ stage: 'file', fileName: 'missing.bin', error: 'synthetic' }],
      },
    ],
    save: { policy: { mode: 'after' }, status: 'pending' },
  };
  try {
    act(() =>
      root.render(
        h(TaskList, {
          tasks: [task],
          isExpanded: true,
          onPause: noop,
          onCancel: noop,
          onDownload: noop,
          onDelete: noop,
          onShowFailures: noop,
        }),
      ),
    );
    expect(host.textContent).toContain('群文件导出');
    expect(host.textContent).toContain('已完成 · 资源缺失');
    expect(host.textContent).toContain('个文件');
    expect(host.textContent).not.toContain('JSON');
    expect(host.querySelector('[title="保存到…"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
it('保存位置存在时提供打开与文件夹定位，另存失败仍能打开上次结果', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const task: UiTask = {
    id: 'fixture',
    kind: 'c2c',
    name: '合成结果',
    format: 'json',
    status: 'completed',
    progress: 100,
    current: 1,
    total: 1,
    save: { policy: { mode: 'after' }, status: 'saved', path: '/saved/fixture.json' },
  };
  const open = vi.fn(),
    noop = vi.fn();
  const render = () =>
    act(() =>
      root.render(
        h(TaskList, {
          tasks: [task],
          isExpanded: true,
          onPause: noop,
          onCancel: noop,
          onDownload: noop,
          onDelete: noop,
          onShowFailures: noop,
          onOpenSaved: open,
        }),
      ),
    );
  try {
    render();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="打开保存结果"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="在文件夹中显示"]')!.click());
    expect(open.mock.calls).toEqual([
      [task, false],
      [task, true],
    ]);
    task.save = { ...task.save!, status: 'failed', error: '本次目录不可用' };
    render();
    expect(host.querySelector('[aria-label="打开保存结果"]')).not.toBeNull();
    expect(host.textContent).toContain('上次保存：/saved/fixture.json');
    expect(host.textContent).not.toContain('尚未保存');
    task.save = { policy: { mode: 'after' }, status: 'pending' };
    render();
    expect(host.querySelector('[aria-label="打开保存结果"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
