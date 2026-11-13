import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useContactOnlineStatuses } from '../src/renderer/src/hooks/useContactOnlineStatuses';
import { scheduleBackgroundLoad } from '../src/renderer/src/lib/backgroundLoad';

const query = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { getOnlineStatus: { query } } },
}));
const buddies = Array.from({ length: 301 }, (_, i) => ({ uid: `synthetic-${i}` }));
let root: Root;
let host: HTMLDivElement;
function Contacts({ active }: { active: boolean }) {
  useContactOnlineStatuses(buddies, active);
  return null;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  query.mockReset().mockResolvedValue(null);
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('启动不扫描好友，联系人页打开才查询；短时间重进不重复扫描', async () => {
  await act(async () => root.render(createElement(Contacts, { active: false })));
  expect(query).not.toHaveBeenCalled();
  await act(async () => root.render(createElement(Contacts, { active: true })));
  expect(query).toHaveBeenCalledTimes(300);
  await act(async () => root.render(createElement(Contacts, { active: false })));
  await act(async () => root.render(createElement(Contacts, { active: true })));
  expect(query).toHaveBeenCalledTimes(300);
});
it('离开联系人页后不再发后续批次', async () => {
  const finish: (() => void)[] = [];
  query.mockImplementation(() => new Promise((resolve) => finish.push(() => resolve(null))));
  await act(async () => root.render(createElement(Contacts, { active: true })));
  expect(query).toHaveBeenCalledTimes(12);
  await act(async () => root.render(createElement(Contacts, { active: false })));
  await act(async () => {
    for (const resolve of finish) resolve();
  });
  expect(query).toHaveBeenCalledTimes(12);
});
it('目录补页让出首屏时间并支持取消排队任务', () => {
  vi.useFakeTimers();
  const run = vi.fn();
  const idle = vi.fn(() => 123);
  const cancel = vi.fn();
  vi.stubGlobal('requestIdleCallback', idle);
  vi.stubGlobal('cancelIdleCallback', cancel);
  const stop = scheduleBackgroundLoad(run);
  vi.advanceTimersByTime(299);
  expect(idle).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(idle).toHaveBeenCalledOnce();
  expect(run).not.toHaveBeenCalled();
  stop();
  expect(cancel).toHaveBeenCalledWith(123);
});
