import { expect, it, vi } from 'vitest';
import type { DbWatchTask, DbChange } from '@weq/service';
import { mountGroupInfoWatch } from '../src/main/group_info_watch';

it('监听实际群资料库路径，并在换号和卸载后停止通知', () => {
  const emit = vi.fn();
  const unmount = vi.fn();
  let active = true;
  const mount = vi.fn((_task: DbWatchTask) => ({ unmount }));
  const handle = mountGroupInfoWatch(
    { mount },
    '/fixture/account/group_info.db',
    () => active,
    emit,
  );
  const task = mount.mock.calls[0]?.[0];
  expect(task?.dbPath).toBe('/fixture/account/group_info.db');
  const change: DbChange = {
    dbPath: '/fixture/account/group_info.db',
    at: 123,
    prevTotal: 0,
    total: 0,
    delta: 0,
    files: [],
  };
  task?.onDbFileChangeHook(change);
  expect(emit).toHaveBeenCalledWith(change);
  active = false;
  task?.onDbFileChangeHook(change);
  expect(emit).toHaveBeenCalledTimes(1);
  handle.unmount();
  active = true;
  task?.onDbFileChangeHook(change);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(unmount).toHaveBeenCalledOnce();
});
