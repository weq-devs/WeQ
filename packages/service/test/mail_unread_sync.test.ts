import { EventEmitter } from 'node:events';
import { CookieJar } from 'tough-cookie';
import { describe, expect, it, vi } from 'vitest';
import { MailAuth } from '../src/account/mail/auth';
import { QQMailService } from '../src/account/mail/client';
import type { MailRequest, MailResponse, MailTransport } from '../src/account/mail/http';
import { mailUnreadCount } from '../src/account/mail/wire';
import { MailFailure, MAIL_VERIFICATION_REQUIRED } from '../src/account/mail/types';

class UnreadTransport implements MailTransport {
  readonly jar = new CookieJar();
  unread = 2;
  panelFails = false;
  foldersFail = false;
  notices: { mailid: string }[] = [];
  async request(raw: string | URL, _options?: MailRequest): Promise<MailResponse> {
    const path = new URL(raw).pathname;
    const failed =
      (path === '/qs/list_notify' && this.panelFails) ||
      (path === '/list/folderlist' && this.foldersFail);
    const body =
      path === '/list/folderlist'
        ? {
            list: {
              sys_list: [
                { dirid: 1, unread_num: this.unread, total_num: 10 },
                { dirid: 2, unread_num: this.unread, total_num: 10 },
                { dirid: 5, unread_num: 3, total_num: 3 },
                { dirid: 6, unread_num: 4, total_num: 4 },
              ],
              personal_list: [{ dirid: 2000, unread_num: 0, total_num: 2 }],
              tag_list: [{ dirid: 4000, unread_num: 2, total_num: 2 }],
              features_list: [{ dirid: 1002, unread_num: 1, total_num: 0 }],
            },
          }
        : { unread: 2, next_sync_time_interval_sec: 3600, newmaillist: this.notices };
    return { status: 200, body: JSON.stringify({ head: { ret: failed ? -90002 : 0 }, body }) };
  }
  dispose(): void {}
}

const native = {
  ptFetchMailSession: vi.fn(async () => ({
    success: true,
    msg: 'ok',
    sid: 'fixture-sid',
    panelPskey: 'fixture-panel',
    cookie: 'sid=fixture-sid',
    errorKind: '',
  })),
};

describe('跨客户端邮箱未读同步', () => {
  it('使用持久化查询间隔，修改后立即重新计时，断开后停止查询', async () => {
    vi.useFakeTimers();
    const auth = new MailAuth(native, '12345678', () => 42, new UnreadTransport());
    const query = vi
      .spyOn(auth, 'notificationQuery')
      .mockResolvedValue({ unread: 0, next_sync_time_interval_sec: 1 });
    const socket = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    });
    const service = new QQMailService(native, '12345678', () => 42, {
      authFactory: () => auth,
      socketFactory: () => socket,
    });
    try {
      service.startBackground({ showUnread: true, notifications: false, pollIntervalMinutes: 3 });
      await vi.advanceTimersByTimeAsync(0);
      expect(query).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(179_999);
      expect(query).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(query).toHaveBeenCalledTimes(2);
      service.setPollIntervalMinutes(2);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(query).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(query).toHaveBeenCalledTimes(3);
      service.disconnect();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(query).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });
  it('关闭横幅时，同未读数的新邮件仍触发列表刷新，相同结果不重复刷新', async () => {
    vi.useFakeTimers();
    const transport = new UnreadTransport();
    const auth = new MailAuth(native, '12345678', () => 42, transport);
    const socket = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    });
    const onNotice = vi.fn();
    const service = new QQMailService(native, '12345678', () => 42, {
      authFactory: () => auth,
      socketFactory: () => socket,
      onNotice,
    });
    const events = vi.fn();
    service.events.on('change', events);
    try {
      service.startBackground({ showUnread: true, notifications: false });
      await vi.advanceTimersByTimeAsync(0);
      events.mockClear();
      transport.notices = [{ mailid: 'fixture-new' }];
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events).toHaveBeenCalledWith({ type: 'changed' });
      expect(onNotice).not.toHaveBeenCalled();
      events.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events).not.toHaveBeenCalledWith({ type: 'changed' });
      transport.unread = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events).toHaveBeenCalledWith({ type: 'changed' });
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });
  it('累计独立收信文件夹，不把星标、标签、垃圾箱和功能入口重复计数', () => {
    expect(
      mailUnreadCount({
        sys_list: [
          { dirid: 1, unread_num: 2 },
          { dirid: 2, unread_num: 2 },
          { dirid: 6, unread_num: 9 },
        ],
        personal_list: [{ dirid: 2000, unread_num: '3' }],
        pop_list: [{ dirid: 2001, unread_num: 1 }],
        tag_list: [{ dirid: 4000, unread_num: 2 }],
        features_list: [{ dirid: 1002, unread_num: 1 }],
      }),
    ).toBe(6);
  });
  it.each([
    undefined,
    {},
    { sys_list: [] },
    { sys_list: [{ dirid: 1 }] },
    { sys_list: [{ dirid: 1, unread_num: 'invalid' }] },
    { sys_list: [{ dirid: 1, unread_num: 0 }], personal_list: [{ dirid: 2000 }] },
  ])('不完整的文件夹计数 %j 不能伪装成零未读', (value) => {
    expect(mailUnreadCount(value)).toBeNull();
  });
  it.each([false, true])(
    '提醒计数滞后或失败（%s）时，后台仍按邮箱当前状态清除红点',
    async (panelFails) => {
      vi.useFakeTimers();
      const transport = new UnreadTransport();
      const auth = new MailAuth(native, '12345678', () => 42, transport);
      const socket = Object.assign(new EventEmitter(), {
        send: vi.fn(),
        close: vi.fn(),
        terminate: vi.fn(),
      });
      const onNotice = vi.fn();
      const service = new QQMailService(native, '12345678', () => 42, {
        authFactory: () => auth,
        socketFactory: () => socket,
        onNotice,
      });
      const events = vi.fn();
      service.events.on('change', events);
      try {
        service.startBackground({ showUnread: true, notifications: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(service.status().unread).toBe(2);
        transport.unread = 0;
        transport.panelFails = panelFails;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(service.status().unread).toBe(0);
        expect(events).toHaveBeenCalledWith({
          type: 'status',
          status: expect.objectContaining({ unread: 0 }),
        });
        expect(onNotice).not.toHaveBeenCalled();
      } finally {
        service.dispose();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      }
    },
  );

  it('邮箱计数查询失败不当作已读清零，仍可使用有效的提醒计数', async () => {
    const transport = new UnreadTransport();
    transport.foldersFail = true;
    const auth = new MailAuth(native, '12345678', () => 42, transport);
    try {
      expect((await auth.notificationQuery()).unread).toBe(2);
      transport.panelFails = true;
      await expect(auth.notificationQuery()).rejects.toThrow();
    } finally {
      auth.dispose();
    }
  });

  it('提醒接口可用也不吞掉邮箱会话的明确验证提示', async () => {
    const auth = new MailAuth(native, '12345678', () => 42, new UnreadTransport());
    const error = new MailFailure('auth', '邮箱需要二次验证', MAIL_VERIFICATION_REQUIRED);
    vi.spyOn(auth, 'cgi').mockRejectedValue(error);
    try {
      await expect(auth.notificationQuery()).rejects.toBe(error);
    } finally {
      auth.dispose();
    }
  });

  it('提醒首次失败后恢复，不把已有邮件补发成新通知，后续新邮件仍正常提醒', async () => {
    vi.useFakeTimers();
    const transport = new UnreadTransport();
    transport.panelFails = true;
    transport.notices = [{ mailid: 'fixture-existing' }];
    const auth = new MailAuth(native, '12345678', () => 42, transport);
    const socket = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    });
    const onNotice = vi.fn();
    const service = new QQMailService(native, '12345678', () => 42, {
      authFactory: () => auth,
      socketFactory: () => socket,
      onNotice,
    });
    try {
      service.startBackground({ showUnread: true, notifications: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.status().unread).toBe(2);
      transport.panelFails = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onNotice).not.toHaveBeenCalled();
      transport.notices.push({ mailid: 'fixture-new' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onNotice).toHaveBeenCalledOnce();
      expect(onNotice).toHaveBeenCalledWith(expect.objectContaining({ id: 'fixture-new' }));
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });
});
