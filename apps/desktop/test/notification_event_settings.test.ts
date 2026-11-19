import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_EVENTS,
  normalizeNotificationEvents,
  type NotificationEvents,
  type NotificationEvent,
} from '@weq/service/notification-settings';
import { NotificationEventSettings } from '../src/renderer/src/components/settings/NotificationEventSettings';
const state = vi.hoisted(() => ({
  settings: {} as { notificationEvents: NotificationEvents },
  save: vi.fn(),
  error: null as Error | null,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => {}, {
      apply: () => proxy(path),
      get: (_target, key) => {
        if (key === 'useQuery')
          return () => ({
            data: path === 'bootstrap.getSettings' ? state.settings : undefined,
            error: state.error,
            isLoading: false,
            refetch: vi.fn(),
          });
        if (key === 'useMutation') return () => ({ mutateAsync: state.save, isLoading: false });
        if (key === 'setData')
          return (
            _input: unknown,
            update: (previous: typeof state.settings) => typeof state.settings,
          ) => {
            state.settings = update(state.settings);
          };
        if (key === 'invalidate') return async () => {};
        return proxy(path ? `${path}.${String(key)}` : String(key));
      },
    });
  return { trpc: proxy(), client: proxy() };
});
const disposals: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.settings = { notificationEvents: normalizeNotificationEvents(undefined) };
  state.error = null;
  state.save
    .mockReset()
    .mockImplementation(
      async ({
        events,
        channel,
        enabled,
      }: {
        events: NotificationEvent[];
        channel: 'banner' | 'system';
        enabled: boolean;
      }) => {
        const next = structuredClone(state.settings.notificationEvents);
        for (const event of events) next[event][channel] = enabled;
        return next;
      },
    );
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.unstubAllGlobals();
});
function mount(settingId?: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      h(NotificationEventSettings, {
        target: settingId ? { section: 'global', settingId, revision: 1 } : undefined,
      }),
    ),
  );
  disposals.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
function button(host: HTMLElement, label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  )!;
}
it('初始四组折叠，展开显示全部事件，官方公告只有横幅渠道', () => {
  const host = mount();
  expect(host.querySelectorAll('thead th')).toHaveLength(3);
  expect(host.querySelectorAll('.weq-notification-group')).toHaveLength(4);
  expect(host.querySelectorAll('.weq-notification-event')).toHaveLength(0);
  expect(button(host, '普通消息：应用内横幅通知').getAttribute('aria-checked')).toBe('false');
  expect(button(host, '普通消息：系统通知').getAttribute('aria-checked')).toBe('true');
  for (const label of ['普通消息', '重点消息', '其他通知', '应用与任务'])
    act(() => button(host, label).click());
  expect(host.querySelectorAll('.weq-notification-event')).toHaveLength(NOTIFICATION_EVENTS.length);
  expect(button(host, '重要官方公告：应用内横幅通知').getAttribute('aria-checked')).toBe('true');
  expect(button(host, '重要官方公告：系统通知')).toBeUndefined();
  for (const label of ['普通私聊消息', '普通群聊消息', '收到助手或克隆体的新回复'])
    expect(button(host, `${label}：应用内横幅通知`).getAttribute('aria-checked')).toBe('false');
  expect(host.textContent).not.toMatch(/N\d{2}/);
  expect(host.textContent).not.toContain('收到点赞');
});
it('数据库异常旧深链展开应用与任务，默认仅横幅开启，两个渠道独立保存', async () => {
  const host = mount('damage-reminder');
  expect(button(host, '应用与任务').getAttribute('aria-expanded')).toBe('true');
  const row = host.querySelector('[data-setting-id="damage-reminder"]');
  expect(row?.textContent).toContain('数据库异常提醒');
  const banner = button(host, '数据库异常提醒：应用内横幅通知');
  const system = button(host, '数据库异常提醒：系统通知');
  expect(banner.getAttribute('aria-checked')).toBe('true');
  expect(system.getAttribute('aria-checked')).toBe('false');
  await act(async () => system.click());
  expect(state.save).toHaveBeenLastCalledWith({
    events: ['databaseDamage'],
    channel: 'system',
    enabled: true,
  });
  await act(async () => banner.click());
  expect(state.save).toHaveBeenLastCalledWith({
    events: ['databaseDamage'],
    channel: 'banner',
    enabled: false,
  });
  expect(system.getAttribute('aria-checked')).toBe('true');
  expect(host.textContent).not.toContain('数据库异常时弹窗提醒');
});
it('父项部分开启点击全开再全关，按列原子提交，不触发折叠或改动另一列', async () => {
  const host = mount();
  const group = button(host, '重点消息：系统通知');
  expect(group.getAttribute('aria-checked')).toBe('mixed');
  await act(async () => group.click());
  expect(state.save).toHaveBeenLastCalledWith({
    events: ['specialCare', 'mentionMe', 'mentionAll', 'replyMe', 'redPacket', 'keyword'],
    channel: 'system',
    enabled: true,
  });
  expect(group.getAttribute('aria-checked')).toBe('true');
  expect(button(host, '重点消息').getAttribute('aria-expanded')).toBe('false');
  expect(button(host, '重点消息：应用内横幅通知').getAttribute('aria-checked')).toBe('mixed');
  await act(async () => group.click());
  expect(group.getAttribute('aria-checked')).toBe('false');
});
it('旧深链自动展开对应组，子项双渠道分别保存，保存失败保留旧值并就地提示', async () => {
  const host = mount('mail-banner');
  expect(button(host, '其他通知').getAttribute('aria-expanded')).toBe('true');
  const system = button(host, '新邮件：系统通知');
  await act(async () => system.click());
  expect(state.save).toHaveBeenLastCalledWith({
    events: ['mail'],
    channel: 'system',
    enabled: false,
  });
  expect(button(host, '新邮件：应用内横幅通知').getAttribute('aria-checked')).toBe('true');
  state.save.mockRejectedValueOnce(new Error('合成写入失败'));
  await act(async () => system.click());
  expect(system.getAttribute('aria-checked')).toBe('false');
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('合成写入失败');
});
