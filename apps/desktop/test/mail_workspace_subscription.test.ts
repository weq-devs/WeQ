import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailEvent, MailStatus } from '@weq/service/mail';
import { MailWorkspace } from '../src/renderer/src/views/MailView';
import { useMailNavigation } from '../src/renderer/src/hooks/useMailNavigation';
import {
  notificationContent,
  notificationSource,
} from '../src/renderer/src/lib/notificationNavigation.shared';

const rpc = vi.hoisted(() => ({
  status: vi.fn(),
  subscribe: vi.fn(),
  dispose: vi.fn(),
  list: vi.fn(),
  folders: vi.fn(),
  read: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ preferences: vi.fn(), subscribe: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/trpc/client')>();
  return {
    ...actual,
    client: { mail: { events: { subscribe: navigation.subscribe } } },
    trpc: { settings: { mail: { get: { useQuery: navigation.preferences } } } },
  };
});
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

function fixture(changingSource = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (active: boolean) => {
    await act(async () =>
      root.render(
        notificationContent(
          changingSource
            ? notificationSource(
                { kind: 'mail', folderId: 1, mailId: 'mail-fixture' },
                '邮箱',
                null,
              )
            : null,
          h(MailWorkspace, { selfUin: '12345678', active }),
        ),
      ),
    );
  };
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { render, host };
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
  const f = fixture();
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
    const f = fixture();
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
    const f = fixture();
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

describe('邮箱状态订阅', () => {
  it('通知来源与页面回调反复更新时不重建连接、状态读取或订阅', async () => {
    const f = fixture(true);
    await f.render(true);
    for (let revision = 0; revision < 20; revision++) {
      await f.render(revision % 2 === 0);
      await act(async () =>
        listener?.({ type: 'status', status: { ...status, unread: revision } }),
      );
    }
    expect(rpc.subscribe).toHaveBeenCalledOnce();
    expect(rpc.status).toHaveBeenCalledOnce();
    expect(rpc.dispose).not.toHaveBeenCalled();
  });

  it('导航在邮箱页面外接收未读状态和系统通知点击，切号和关闭开关后隐藏旧角标', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    cleanups.push(() => act(() => root.unmount()));
    const open = vi.fn();
    const renderBadge = vi.fn();
    const unsubscribe = vi.fn();
    navigation.preferences.mockReturnValue({ isFetchedAfterMount: false });
    let receive: (event: MailEvent) => void = () => {};
    navigation.subscribe.mockImplementation((_account, { onData }) => {
      receive = onData;
      return { unsubscribe };
    });
    const Harness = ({ uin }: { uin: string }) => {
      renderBadge(useMailNavigation(uin, true, open));
      return null;
    };
    const render = (uin: string) => act(async () => root.render(h(Harness, { uin })));
    await render('12345678');
    await act(async () =>
      receive({
        type: 'status',
        status: { ...status, unread: 0, unreadPending: true, showUnread: true },
      }),
    );
    expect(renderBadge).toHaveBeenLastCalledWith({ count: 0, pending: true });
    await act(async () => receive({ type: 'status', status: { ...status, showUnread: true } }));
    expect(renderBadge).toHaveBeenLastCalledWith({ count: 2, pending: false });
    await act(async () =>
      receive({
        type: 'open',
        notice: { id: 'mail-fixture', folderId: 1, subject: '', sender: '' },
      }),
    );
    expect(open).toHaveBeenCalledWith({ kind: 'mail', mailId: 'mail-fixture', folderId: 1 });
    navigation.preferences.mockReturnValue({
      isFetchedAfterMount: true,
      data: { showUnread: false },
    });
    await render('12345678');
    expect(renderBadge).toHaveBeenLastCalledWith({ count: 0, pending: false });
    expect(navigation.subscribe).toHaveBeenCalledOnce();
    navigation.preferences.mockReturnValue({
      isFetchedAfterMount: true,
      data: { showUnread: true },
    });
    await render('23456789');
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(renderBadge).toHaveBeenLastCalledWith({ count: 0, pending: false });
    expect(rpc.subscribe).not.toHaveBeenCalled();
  });
});
