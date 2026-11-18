import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeNotificationEvents } from '@weq/service/notification-settings';
import { ToastHost } from '../src/renderer/src/components/Toast';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import { useNotificationPolicy } from '../src/renderer/src/lib/notificationPolicy';
const rpc = vi.hoisted(() => ({ notify: vi.fn(async () => true) }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { bootstrap: { notifyConfiguredEvent: { mutate: rpc.notify } } },
  trpc: {},
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rpc.notify.mockClear();
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  useNotificationPolicy.getState().setEvents(normalizeNotificationEvents(undefined));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(h(ToastHost)));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
it('关闭进行中横幅保留任务推进，完成时按完成渠道展示，不取消任务', async () => {
  const policy = normalizeNotificationEvents(undefined);
  policy.progress.banner = false;
  useNotificationPolicy.getState().setEvents(policy);
  const host = mount();
  let id = 0;
  act(() => {
    id = useToast.getState().push({ loading: true, title: '合成任务进行中' });
  });
  expect(host.querySelector<HTMLElement>('.weq-toast')?.hidden).toBe(true);
  expect(useToast.getState().toasts).toHaveLength(1);
  await act(async () => {
    useToast.getState().update(id, { loading: false, tone: 'success', title: '合成任务完成' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.querySelector<HTMLElement>('.weq-toast')?.hidden).toBe(false);
  expect(useToast.getState().toasts[0]?.event).toBe('taskComplete');
  expect(rpc.notify).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'taskComplete', title: '合成任务完成' }),
  );
});
it('关闭操作失败横幅不再保留不可见常驻错误，普通警告按成功计时分类', () => {
  const policy = normalizeNotificationEvents(undefined);
  policy.failure.banner = false;
  useNotificationPolicy.getState().setEvents(policy);
  const host = mount();
  act(() => {
    useToast.getState().push({ tone: 'error', title: '合成失败' });
  });
  expect(host.querySelector('.weq-toast')).toBeNull();
  expect(useToast.getState().toasts).toHaveLength(0);
  act(() => {
    useToast.getState().push({ tone: 'warning', durationKind: 'success', title: '正常空结果' });
  });
  expect(useToast.getState().toasts[0]?.event).toBe('success');
});
