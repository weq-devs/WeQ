import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => ({
  patch: vi.fn(async (values: object) => ({ epoch: 'fixture', revision: 1, values, records: {} })),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { clientState: { patch: { mutate: rpc.patch } } },
  trpc: {},
}));
import { WebNotificationsSection } from '../src/renderer/src/components/settings/WebNotificationsSection';
import { useWebNotices } from '../src/renderer/src/state/webNotices';
afterEach(() => vi.unstubAllGlobals());
it('当前浏览器拒绝授权只显示本端授权结果，不关闭共享通知开关', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const request = vi.fn(async () => 'denied');
  vi.stubGlobal('Notification', { permission: 'denied', requestPermission: request });
  useWebNotices.setState({ enabled: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(WebNotificationsSection)));
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await vi.waitFor(() => expect(rpc.patch).toHaveBeenCalledWith({ webNotifications: true }));
    expect(useWebNotices.getState().enabled).toBe(true);
    expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).toContain('浏览器未允许通知');
    expect(request).toHaveBeenCalledTimes(1);
    expect(rpc.patch).not.toHaveBeenCalledWith({ webNotifications: false });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
