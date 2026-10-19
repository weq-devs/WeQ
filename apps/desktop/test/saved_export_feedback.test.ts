import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskList, type UiTask } from '../src/renderer/src/views/export/TaskList';

afterEach(() => vi.unstubAllGlobals());
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
