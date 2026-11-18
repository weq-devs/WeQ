import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeNotificationEvents } from '@weq/service/notification-settings';
import { ToastHost } from '../src/renderer/src/components/Toast';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import type { DatabaseDamagedEvent } from '../src/renderer/src/components/DatabaseDamagedDialog';
import { useDatabaseDamageNotifications } from '../src/renderer/src/hooks/useDatabaseDamageNotifications';
import { useNotificationPolicy } from '../src/renderer/src/lib/notificationPolicy';
import { activateNotificationClick } from '../src/renderer/src/lib/notificationSystemClick';
import { bindAccountState } from '../src/renderer/src/lib/clientPreferences';

const rpc = vi.hoisted(() => ({
  listener: null as null | ((event: DatabaseDamagedEvent) => void),
  unsubscribe: vi.fn(),
  notify: vi.fn(async (_input: { event: string; clickId?: string }) => true),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: {
      onAccountForcedClosed: {
        subscribe: (_: unknown, callbacks: { onData: typeof rpc.listener }) => {
          rpc.listener = callbacks.onData;
          return { unsubscribe: rpc.unsubscribe };
        },
      },
      notifyConfiguredEvent: { mutate: rpc.notify },
    },
  },
  trpc: {},
}));

const event: DatabaseDamagedEvent = {
  reason: 'database-damaged',
  kind: 'confirmed',
  uin: 'fixture',
  title: '数据库损坏',
  message: '合成健康检查结果，已生成报告',
  details: ['合成数据库：消息表损坏'],
  failures: [],
  reportPath: '/fixture/db-health.md',
};
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rpc.notify.mockClear();
  rpc.unsubscribe.mockClear();
  rpc.listener = null;
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  bindAccountState({ expectedAccountUin: event.uin, expectedAccountConfigId: 'fixture-source' });
  useNotificationPolicy.getState().setEvents(normalizeNotificationEvents(undefined));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  bindAccountState(null);
  vi.unstubAllGlobals();
});
function mount() {
  const openDetails = vi.fn();
  function Fixture() {
    useDatabaseDamageNotifications(openDetails);
    return h(ToastHost);
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(h(Fixture)));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, openDetails };
}
async function receive(value = event) {
  await act(async () => {
    rpc.listener!(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it('默认仅显示常规横幅，不自动弹窗，点击后打开完整详情且同账号提醒原位更新', async () => {
  const f = mount();
  await receive();
  expect(f.openDetails).not.toHaveBeenCalled();
  expect(rpc.notify).not.toHaveBeenCalled();
  expect(f.host.querySelector<HTMLElement>('.weq-toast')?.hidden).toBe(false);
  expect(f.host.textContent).toContain(event.reportPath);
  expect(useToast.getState().toasts[0]?.event).toBe('databaseDamage');
  await receive();
  expect(useToast.getState().toasts).toHaveLength(1);
  act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="查看检查详情"]')!.click());
  expect(f.openDetails).toHaveBeenCalledWith(event);
});
it('只开系统通知时不显示横幅，系统通知点击仍打开原检查结果，清理订阅', async () => {
  const policy = normalizeNotificationEvents(undefined);
  policy.databaseDamage = { banner: false, system: true };
  useNotificationPolicy.getState().setEvents(policy);
  const f = mount();
  const incomplete = { ...event, kind: 'check-error' as const, title: '数据库无法读取' };
  await receive(incomplete);
  expect(f.host.querySelector('.weq-toast')).toBeNull();
  expect(f.openDetails).not.toHaveBeenCalled();
  expect(rpc.notify).toHaveBeenCalledOnce();
  const input = rpc.notify.mock.calls[0]![0];
  expect(input.event).toBe('databaseDamage');
  await act(async () => {
    expect(await activateNotificationClick(input.clickId!)).toBe(true);
  });
  expect(f.openDetails).toHaveBeenCalledWith(incomplete);
  cleanups.pop()!();
  expect(rpc.unsubscribe).toHaveBeenCalledOnce();
});
it('两个渠道都关闭时不显示通知，也不主动打开详情', async () => {
  const policy = normalizeNotificationEvents(undefined);
  policy.databaseDamage = { banner: false, system: false };
  useNotificationPolicy.getState().setEvents(policy);
  const f = mount();
  await receive();
  expect(f.host.querySelector('.weq-toast')).toBeNull();
  expect(rpc.notify).not.toHaveBeenCalled();
  expect(f.openDetails).not.toHaveBeenCalled();
});
it('切换账号或同号数据源后不把旧异常带到新账号的修复入口', async () => {
  const f = mount();
  await receive();
  bindAccountState({ expectedAccountUin: event.uin, expectedAccountConfigId: 'other-source' });
  await act(async () =>
    f.host.querySelector<HTMLButtonElement>('[aria-label="查看检查详情"]')!.click(),
  );
  expect(f.openDetails).not.toHaveBeenCalled();
  expect(f.host.textContent).toContain('请先切回通知来源账号');
});
