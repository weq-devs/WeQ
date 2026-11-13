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
  read: vi.fn(),
}));
vi.mock('../src/renderer/src/views/mail/api', () => ({ createMailApi: () => rpc }));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({ binding: null, serverLocation: null }),
}));
vi.mock('../src/renderer/src/views/mail/MailComposer', () => ({ MailComposer: () => null }));
vi.mock('../src/renderer/src/views/mail/MailBody', () => ({
  MailBody: () => h('div', { 'data-mail-body': true }, '已加载正文'),
}));
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
let visibilityState: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  visibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
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
  rpc.read.mockResolvedValue({
    id: 'mail-fixture',
    folderId: 1,
    subject: '测试邮件',
    sender: { email: 'test@example.invalid' },
    to: [],
    cc: [],
    bcc: [],
    time: 1,
    html: '<p>正文</p>',
    attachments: [],
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
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
  return { render, onUnreadChange, host };
}

async function openLoadedMail() {
  rpc.list.mockResolvedValue({
    items: [
      {
        id: 'mail-fixture',
        subject: '测试邮件',
        sender: { email: 'test@example.invalid' },
        time: 1,
        snippet: '',
      },
      {
        id: 'mail-second',
        subject: '另一封邮件',
        sender: { email: 'test@example.invalid' },
        time: 2,
        snippet: '',
      },
    ],
    page: 0,
    total: 1,
    unread: 0,
    hasMore: false,
  });
  const f = fixture({ showUnread: false, notifications: false });
  await f.render(true);
  await act(async () => f.host.querySelector<HTMLButtonElement>('.weq-mail-row-main')?.click());
  expect(f.host.querySelector('[data-mail-body]')).not.toBeNull();
  return f;
}

async function visibility(state: 'visible' | 'hidden') {
  visibilityState = state;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
}

describe('已加载邮件恢复窗口', () => {
  it('重新聚焦、恢复可见及返回邮箱时复用列表、文件夹和正文', async () => {
    const f = await openLoadedMail();
    const body = f.host.querySelector('[data-mail-body]');
    await new Promise((resolve) => setTimeout(resolve, 260));
    await act(async () => window.dispatchEvent(new Event('focus')));
    await visibility('hidden');
    await visibility('visible');
    expect(f.host.querySelector('[data-mail-body]')).toBe(body);
    await f.render(false);
    await f.render(true);
    expect(rpc.list).toHaveBeenCalledOnce();
    expect(rpc.folders).toHaveBeenCalledOnce();
    expect(rpc.read).toHaveBeenCalledOnce();
  });

  it('窗口隐藏期间收到新邮件，返回时仍更新列表但不重读当前正文', async () => {
    await openLoadedMail();
    await visibility('hidden');
    await act(async () => listener?.({ type: 'new-mail' }));
    await visibility('visible');
    expect(rpc.list).toHaveBeenCalledTimes(2);
    expect(rpc.read).toHaveBeenCalledOnce();
  });

  it('隐藏时中断的正文请求在返回后重新读取', async () => {
    rpc.read.mockReturnValueOnce(new Promise(() => {}));
    rpc.list.mockResolvedValue({
      items: [
        {
          id: 'mail-fixture',
          subject: '测试邮件',
          sender: { email: 'test@example.invalid' },
          time: 1,
          snippet: '',
        },
      ],
      page: 0,
      total: 1,
      unread: 0,
      hasMore: false,
    });
    const f = fixture(undefined);
    await f.render(true);
    await act(async () => f.host.querySelector<HTMLButtonElement>('.weq-mail-row-main')?.click());
    await visibility('hidden');
    await visibility('visible');
    expect(rpc.read).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector('[data-mail-body]')).not.toBeNull();
  });

  it('重选当前文件夹后重新读取列表，再选同一邮件仍可正常加载正文', async () => {
    rpc.folders.mockResolvedValue([{ id: 1, name: '收件箱', unread: 0 }]);
    const f = await openLoadedMail();
    await act(async () => f.host.querySelector<HTMLButtonElement>('[title="收件箱"]')?.click());
    expect(rpc.list).toHaveBeenCalledTimes(2);
    await act(async () => f.host.querySelector<HTMLButtonElement>('.weq-mail-row-main')?.click());
    expect(rpc.read).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector('[data-mail-body]')).not.toBeNull();
  });

  it('读取失败后仍可手动重试，不将失败标记成已加载', async () => {
    rpc.read.mockRejectedValueOnce(new Error('测试读取失败'));
    rpc.list.mockResolvedValue({
      items: [
        {
          id: 'mail-fixture',
          subject: '测试邮件',
          sender: { email: 'test@example.invalid' },
          time: 1,
          snippet: '',
        },
      ],
      page: 0,
      total: 1,
      unread: 0,
      hasMore: false,
    });
    const f = fixture(undefined);
    await f.render(true);
    await act(async () => f.host.querySelector<HTMLButtonElement>('.weq-mail-row-main')?.click());
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="重试读取邮箱"]')?.click(),
    );
    expect(rpc.read).toHaveBeenCalledTimes(2);
    expect(rpc.list).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector('[data-mail-body]')).not.toBeNull();
  });

  it('另一封邮件尚未读完就选回原邮件，不复用已清除的正文状态', async () => {
    const f = await openLoadedMail();
    rpc.read.mockReturnValueOnce(new Promise(() => {}));
    const rows = f.host.querySelectorAll<HTMLButtonElement>('.weq-mail-row-main');
    await act(async () => rows[1].click());
    expect(f.host.querySelector('[data-mail-body]')).toBeNull();
    await act(async () => rows[0].click());
    expect(rpc.read).toHaveBeenCalledTimes(3);
    expect(f.host.querySelector('[data-mail-body]')).not.toBeNull();
  });
});

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
