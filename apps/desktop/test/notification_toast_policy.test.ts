import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeNotificationEvents } from '@weq/service/notification-settings';
import { DEFAULT_TOAST_DURATIONS } from '@weq/service/toast-settings';
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
  useToast.setState({ toasts: [], leaving: [], seq: 0, durations: DEFAULT_TOAST_DURATIONS });
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
it('关闭进行中横幅保留任务推进，完成时默认只显示横幅，不取消任务', async () => {
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
  expect(rpc.notify).not.toHaveBeenCalled();
});
it('消息横幅默认常驻，修改时长不影响成功或失败的任务结果', () => {
  const store = useToast.getState();
  const ordinary = store.push({ event: 'assistantReply', title: '回复' });
  const important = store.push({ event: 'mentionMe', tone: 'warning', title: '提及' });
  const other = store.push({ event: 'recall', title: '撤回' });
  const success = store.push({ event: 'taskComplete', tone: 'warning', title: '任务成功' });
  const failure = store.push({ event: 'taskFailure', title: '任务失败' });
  const ttls = () => useToast.getState().toasts.map(({ id, ttl }) => [id, ttl]);
  expect(ttls()).toEqual([
    [ordinary, 0],
    [important, 0],
    [other, 0],
    [success, 3000],
    [failure, 0],
  ]);
  store.setDurations({ successSeconds: 3, failureSeconds: 9, messageSeconds: 6 });
  expect(ttls()).toEqual([
    [ordinary, 6000],
    [important, 6000],
    [other, 6000],
    [success, 3000],
    [failure, 9000],
  ]);
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
