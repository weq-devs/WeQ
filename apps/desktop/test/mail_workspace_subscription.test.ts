import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailEvent, MailStatus } from '@weq/service/mail';
import { MailWorkspace } from '../src/renderer/src/views/MailView';

const rpc = vi.hoisted(() => ({
  status: vi.fn(),
  subscribe: vi.fn(),
  dispose: vi.fn(),
  list: vi.fn(),
  folders: vi.fn(),
}));
vi.mock('../src/renderer/src/views/mail/api', () => ({ createMailApi: () => rpc }));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({ binding: null, serverLocation: null }),
}));
vi.mock('../src/renderer/src/views/mail/MailComposer', () => ({ MailComposer: () => null }));
vi.mock('../src/renderer/src/views/mail/MailBody', () => ({ MailBody: () => null }));
vi.mock('../src/renderer/src/components/settings/MailSettingsSection', () => ({
  MailSettingsSection: () => null,
}));

const status: MailStatus = {
  state: 'ready',
  unread: 2,
  notifications: false,
  lastSync: 1,
  error: null,
};
let listener: ((event: MailEvent) => void) | null = null;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  listener = null;
  rpc.status.mockResolvedValue(status);
  rpc.subscribe.mockImplementation((next: (event: MailEvent) => void) => {
    listener = next;
    next({ type: 'status', status });
    return () => {
      listener = null;
    };
  });
  rpc.list.mockResolvedValue({ items: [], page: 0, total: 0, unread: 0, hasMore: false });
  rpc.folders.mockResolvedValue([]);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

function fixture(preferences: { showUnread: boolean; notifications: boolean } | undefined) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onUnreadChange = vi.fn();
  const render = async (active: boolean, nextPreferences = preferences) => {
    await act(async () =>
      root.render(
        h(MailWorkspace, {
          selfUin: '12345678',
          active,
          preferences: nextPreferences,
          onUnreadChange,
        }),
      ),
    );
  };
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { render, onUnreadChange };
}

describe('邮箱后台状态订阅', () => {
  it.each([undefined, { showUnread: false, notifications: false }])(
    '未取得偏好或两个开关都关闭时，不提前订阅邮箱：%j',
    async (preferences) => {
      const f = fixture(preferences);
      await f.render(false);
      expect(rpc.subscribe).not.toHaveBeenCalled();
      expect(rpc.status).not.toHaveBeenCalled();
      expect(f.onUnreadChange).not.toHaveBeenCalled();
    },
  );

  it('启动偏好延后返回时，仅开红点也会自动建立订阅，后续偏好更新不重复订阅', async () => {
    const f = fixture(undefined);
    await f.render(false);
    expect(rpc.subscribe).not.toHaveBeenCalled();
    await f.render(false, { showUnread: true, notifications: false });
    expect(rpc.subscribe).toHaveBeenCalledOnce();
    await f.render(false, { showUnread: true, notifications: true });
    expect(rpc.subscribe).toHaveBeenCalledOnce();
    await act(async () => listener?.({ type: 'status', status: { ...status, unread: 0 } }));
    expect(f.onUnreadChange).toHaveBeenLastCalledWith(0);
  });

  it.each([
    { showUnread: true, notifications: false },
    { showUnread: false, notifications: true },
    { showUnread: true, notifications: true },
  ])('任一开关开启时，无需进入邮箱即可接收未读变化，不读取邮件列表：%j', async (preferences) => {
    const f = fixture(preferences);
    await f.render(false);
    expect(rpc.subscribe).toHaveBeenCalledOnce();
    expect(f.onUnreadChange).toHaveBeenLastCalledWith(2);
    await act(async () => listener?.({ type: 'status', status: { ...status, unread: 3 } }));
    expect(f.onUnreadChange).toHaveBeenLastCalledWith(3);
    expect(rpc.list).not.toHaveBeenCalled();
    expect(rpc.folders).not.toHaveBeenCalled();
  });

  it('两个开关关闭仍允许手动进入邮箱，离开后保留已有状态订阅', async () => {
    const f = fixture({ showUnread: false, notifications: false });
    await f.render(false);
    expect(rpc.subscribe).not.toHaveBeenCalled();
    await f.render(true);
    expect(rpc.subscribe).toHaveBeenCalledOnce();
    await f.render(false);
    await act(async () => listener?.({ type: 'status', status: { ...status, unread: 4 } }));
    expect(f.onUnreadChange).toHaveBeenLastCalledWith(4);
  });
});
