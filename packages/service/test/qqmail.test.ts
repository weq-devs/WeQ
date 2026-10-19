import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { CookieJar } from 'tough-cookie';
import { MailAuth } from '../src/account/mail/auth';
import {
  mailRequestTarget,
  MailHttp,
  type MailRequest,
  type MailResponse,
  type MailTransport,
} from '../src/account/mail/http';
import { MailFailure } from '../src/account/mail/types';
import { QQMailService, type MailSocket } from '../src/account/mail/client';
import { MailAttachmentRegistry } from '../src/account/mail/attachments';
import { decodeMailSocketFrame, MailNoticeCursor } from '../src/account/mail/notifications';
import {
  addressHeader,
  composeMailForm,
  encodeMailForm,
  mailEnvelope,
  mailSummary,
  object,
  SYSTEM_MAIL_FOLDERS,
  type MailObject,
} from '../src/account/mail/wire';

class FakeMailTransport implements MailTransport {
  readonly jar = new CookieJar();
  readonly calls: { url: URL; options: MailRequest }[] = [];
  failReadOnce = false;
  closed = false;
  async request(raw: string | URL, options: MailRequest = {}): Promise<MailResponse> {
    const url = new URL(raw);
    this.calls.push({ url, options });
    if (url.pathname === '/login/login') return this.envelope({ sid: 'fixture-sid' });
    if (url.pathname === '/list/maillist' && this.failReadOnce) {
      this.failReadOnce = false;
      return this.envelope({}, -20002);
    }
    return this.envelope({});
  }
  envelope(body: MailObject, ret = 0): MailResponse {
    return { status: 200, body: JSON.stringify({ head: { ret }, body }) };
  }
  dispose(): void {
    this.closed = true;
    this.jar.removeAllCookiesSync();
  }
}

function mailNative(result: Partial<Awaited<ReturnType<typeof okMailSession>>> = {}): {
  ptFetchMailSession: ReturnType<typeof vi.fn>;
} {
  return {
    ptFetchMailSession: vi.fn(async () => ({ ...okMailSession(), ...result })),
  };
}

function okMailSession() {
  return {
    success: true,
    msg: 'ok',
    sid: 'fixture-sid',
    panelPskey: 'fixture-mail',
    cookie: 'sid=fixture-sid; p_skey=fixture-mail',
    errorKind: '',
  };
}

const native = mailNative();
const compose = {
  subject: '测试',
  content: '正文',
  plainText: true,
  to: [{ email: 'to@example.invalid', name: '' }],
  cc: [],
  bcc: [],
  attachments: [],
};

describe('邮箱协议编码', () => {
  it('数组使用重复键，对象使用 JSON，空值不落入表单', () => {
    const form = new URLSearchParams(
      encodeMailForm({
        to: ['a', 'b'],
        attachment: [{ name: 'a.txt', fileid: 'fixture' }],
        absent: undefined,
      }),
    );
    expect(form.getAll('to')).toEqual(['a', 'b']);
    expect(JSON.parse(form.get('attachment')!)).toEqual({ name: 'a.txt', fileid: 'fixture' });
    expect(form.has('absent')).toBe(false);
  });
  it('发信和草稿共用精确字段，拒绝地址头注入', () => {
    const sender = { email: 'sender@example.invalid', name: '发件人' };
    expect(composeMailForm({ ...compose, replyId: 'reply-fixture' }, sender, false)).toMatchObject({
      func: 1,
      re_mailid: 'reply-fixture',
      is_text: true,
      to: ['to@example.invalid'],
      from: '"发件人"<sender@example.invalid>',
    });
    expect(composeMailForm({ ...compose, to: [] }, sender, true).func).toBe(2);
    expect(() =>
      addressHeader({ email: 'a@example.invalid\r\nBcc:evil@example.invalid', name: '' }),
    ).toThrow(MailFailure);
    expect(() => composeMailForm({ ...compose, to: [] }, sender, false)).toThrow('收件人');
  });
  it('正文 info 与列表字段统一投影，不把业务票据透传到 DTO', () => {
    const dto = mailSummary({
      emailid: 'mail-fixture',
      subject: '主题',
      info: { dirid: 1, unread: 1, star: 1 },
      from: { email: 'sender@example.invalid', nick: '发件人' },
      sid: 'never-expose',
    });
    expect(dto).toMatchObject({
      id: 'mail-fixture',
      folderId: 1,
      unread: true,
      starred: true,
      sender: { name: '发件人' },
    });
    expect(JSON.stringify(dto)).not.toContain('never-expose');
    expect(SYSTEM_MAIL_FOLDERS.map((folder) => folder.id)).toContain(1);
  });
  it('错误码不携带服务端原始响应或票据', () => {
    expect(() => mailEnvelope({ head: { ret: -20002, msg: 'fixture-secret' } })).toThrow(
      '登录已失效',
    );
    expect(() => mailEnvelope({ body: {} })).toThrow('无法识别');
    expect(() => mailEnvelope({ head: { ret: -123, msg: 'fixture-secret' } })).toThrow('（-123）');
  });
});

describe('邮箱生命周期和提醒', () => {
  it.each(['open', 'read', 'unread', 'trash'] as const)(
    '%s 成功后同步账号未读数并发布角标状态，不依赖开启提醒',
    async (operation) => {
      const transport = new FakeMailTransport(),
        auth = new MailAuth(native, '12345678', () => 42, transport);
      const query = vi
        .spyOn(auth, 'notificationQuery')
        .mockResolvedValueOnce({ unread: 2 })
        .mockResolvedValue({ unread: operation === 'unread' ? 3 : 1 });
      vi.spyOn(auth, 'cgi').mockResolvedValue({
        item: { ret: 0, emailid: 'read-fixture', content: '正文' },
      });
      const service = new QQMailService(native, '12345678', () => 42, {
        authFactory: () => auth,
      });
      const changed = vi.fn();
      service.events.on('change', changed);
      try {
        await service.connect();
        changed.mockClear();
        if (operation === 'open') await service.read('read-fixture');
        else await service.action(['read-fixture'], operation);
        const unread = operation === 'unread' ? 3 : 1;
        expect(query).toHaveBeenCalledTimes(2);
        await vi.waitFor(() =>
          expect(service.status()).toMatchObject({ unread, notifications: false }),
        );
        expect(changed).toHaveBeenCalledWith({
          type: 'status',
          status: expect.objectContaining({ unread }),
        });
      } finally {
        service.dispose();
      }
    },
  );
  it.each(['open', 'read'] as const)('未读数补刷失败不把 %s 成功报为失败', async (operation) => {
    const transport = new FakeMailTransport(),
      auth = new MailAuth(native, '12345678', () => 42, transport);
    const query = vi
      .spyOn(auth, 'notificationQuery')
      .mockResolvedValueOnce({ unread: 2 })
      .mockRejectedValue(new MailFailure('network', '同步失败'));
    vi.spyOn(auth, 'cgi').mockResolvedValue({
      item: { ret: 0, emailid: 'read-fixture', content: '正文' },
    });
    const service = new QQMailService(native, '12345678', () => 42, {
      authFactory: () => auth,
    });
    const changed = vi.fn();
    service.events.on('change', changed);
    try {
      await service.connect();
      changed.mockClear();
      if (operation === 'open')
        await expect(service.read('read-fixture')).resolves.toMatchObject({ id: 'read-fixture' });
      else await expect(service.action(['read-fixture'], 'read')).resolves.toBeUndefined();
      expect(query).toHaveBeenCalledTimes(2);
      expect(service.status()).toMatchObject({ state: 'ready', unread: 2 });
      expect(changed).toHaveBeenCalledWith({ type: 'changed' });
    } finally {
      service.dispose();
    }
  });
  it('面板票据不能被带到其他路径、主机或注入请求头', async () => {
    const transport = new MailHttp();
    try {
      for (const url of [
        'https://wx.mail.qq.com/login/login',
        'https://mail.qq.com/qs/list_notify',
      ])
        await expect(transport.request(url, { panelCookie: 'fixture' })).rejects.toThrow(
          '提醒认证地址',
        );
      await expect(
        transport.request('https://wx.mail.qq.com/qs/list_notify', {
          panelCookie: 'fixture\r\nInjected: true',
        }),
      ).rejects.toThrow('提醒认证地址');
    } finally {
      transport.dispose();
    }
  });
  it('网页登录清掉 p_skey 后，提醒仍使用独立保留的 QQ 面板票据', async () => {
    const transport = new FakeMailTransport(),
      original = transport.request.bind(transport);
    transport.request = async (raw, options) => {
      const path = new URL(raw).pathname;
      if (path === '/qs/list_notify')
        return object(options).panelCookie === 'p_uin=o12345678; p_skey=fixture-mail'
          ? transport.envelope({ unread: 3, newmaillist: [] })
          : transport.envelope({}, -90002);
      return original(raw, options);
    };
    const auth = new MailAuth(native, '12345678', () => 42, transport);
    try {
      await auth.connect();
      transport.jar.setCookieSync(
        'p_skey=; Max-Age=0; Domain=wx.mail.qq.com; Path=/; Secure',
        'https://wx.mail.qq.com/',
      );
      expect(
        transport.jar
          .getCookiesSync('https://wx.mail.qq.com/')
          .some((cookie) => cookie.key === 'p_skey'),
      ).toBe(false);
      await expect(auth.notificationQuery()).resolves.toMatchObject({ unread: 3 });
      expect(await auth.redact('fixture-mail')).toBe('[redacted]');
    } finally {
      auth.dispose();
    }
  });
  it('提醒查询失败不阻止 WebSocket 建立基线和投递实时新邮件', async () => {
    class Socket extends EventEmitter implements MailSocket {
      send(): void {}
      close(): void {
        this.emit('close');
      }
      terminate(): void {
        this.emit('close');
      }
    }
    const transport = new FakeMailTransport(),
      auth = new MailAuth(native, '12345678', () => 42, transport);
    vi.spyOn(auth, 'notificationQuery').mockRejectedValue(new MailFailure('business', '查询失败'));
    const socket = new Socket(),
      onNotice = vi.fn(),
      factory = vi.fn(() => socket);
    const service = new QQMailService(native, '12345678', () => 42, {
      authFactory: () => auth,
      socketFactory: factory,
      onNotice,
    });
    try {
      await service.connect();
      await expect(service.setNotifications(true)).resolves.toMatchObject({ notifications: true });
      expect(factory).toHaveBeenCalledOnce();
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            cmd: 0,
            content: JSON.stringify({ head: { ret: 0 }, body: { lastest_msg_seq: 10 } }),
          }),
        ),
      );
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            cmd: 1,
            content: Buffer.from(
              JSON.stringify({ cid: '148', z: 11, e: 'real-time-fixture' }),
            ).toString('base64'),
          }),
        ),
      );
      expect(onNotice).toHaveBeenCalledOnce();
    } finally {
      service.dispose();
    }
  });
  it('WebSocket 的 cmd=0 版本变化也触发补查新邮件', async () => {
    class Socket extends EventEmitter implements MailSocket {
      send(): void {}
      close(): void {
        this.emit('close');
      }
      terminate(): void {
        this.emit('close');
      }
    }
    const transport = new FakeMailTransport(),
      auth = new MailAuth(native, '12345678', () => 42, transport);
    const query = vi
      .spyOn(auth, 'notificationQuery')
      .mockResolvedValueOnce({ unread: 0 })
      .mockResolvedValue({ unread: 1, newmaillist: [{ mailid: 'version-fixture' }] });
    const socket = new Socket(),
      onNotice = vi.fn();
    const service = new QQMailService(native, '12345678', () => 42, {
      authFactory: () => auth,
      socketFactory: () => socket,
      onNotice,
      notificationsEnabled: true,
    });
    const baseline = (sequence: number) =>
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            cmd: 0,
            content: JSON.stringify({ head: { ret: 0 }, body: { lastest_msg_seq: sequence } }),
          }),
        ),
      );
    try {
      await service.connect();
      baseline(10);
      baseline(11);
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(onNotice).toHaveBeenCalledOnce());
    } finally {
      service.dispose();
    }
  });
  it('销毁后晚到的 HTTP 响应不能重新写入 Cookie', async () => {
    const request = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      end: vi.fn(),
    });
    const mock = vi.spyOn(https, 'request').mockReturnValue(request as unknown as ClientRequest);
    const transport = new MailHttp();
    try {
      const pending = transport.request('https://wx.mail.qq.com/login/checksid');
      await vi.waitFor(() => expect(mock).toHaveBeenCalledOnce());
      transport.dispose();
      const response = Object.assign(new EventEmitter(), {
        headers: { 'set-cookie': ['sid=late-fixture; Path=/; Secure'] },
        statusCode: 200,
      });
      const callback = mock.mock.calls[0]![2];
      expect(callback).toBeTypeOf('function');
      callback?.(response as unknown as IncomingMessage);
      response.emit('end');
      await expect(pending).rejects.toThrow('取消');
      expect(transport.jar.getCookiesSync('https://wx.mail.qq.com/')).toEqual([]);
    } finally {
      transport.dispose();
      mock.mockRestore();
    }
  });
  it('未读搜索使用搜索结果总数，不依赖列表专用 unread_num 分页', async () => {
    const transport = new FakeMailTransport(),
      original = transport.request.bind(transport);
    transport.request = async (url, options) =>
      new URL(url).pathname === '/list/search'
        ? transport.envelope({ list: [{ emailid: 'search-fixture' }], total_num: 65 })
        : original(url, options);
    const service = new QQMailService(native, '12345678', () => 42, {
      authFactory: () => new MailAuth(native, '12345678', () => 42, transport),
    });
    try {
      expect(
        await service.list({ folderId: 1, page: 0, unreadOnly: true, keyword: '课程' }),
      ).toMatchObject({ total: 65, hasMore: true });
    } finally {
      service.dispose();
    }
  });
  it('会话邮件先列出子邮件，不自动读取整个会话正文', async () => {
    const transport = new FakeMailTransport(),
      original = transport.request.bind(transport);
    transport.request = async (url, options) =>
      new URL(url).pathname === '/list/collo_maillist'
        ? transport.envelope({
            colloinfo: { emailid: 'C1Tthread', subject: '会话' },
            sublist: [{ emailid: 'child-fixture', subject: '子邮件' }],
          })
        : original(url, options);
    const service = new QQMailService(native, '12345678', () => 42, {
      authFactory: () => new MailAuth(native, '12345678', () => 42, transport),
    });
    const detail = await service.read('C1Tthread');
    expect(detail.thread?.[0]?.id).toBe('child-fixture');
    expect(detail.html).toBe('');
    expect(transport.calls.some((call) => call.url.pathname === '/read/readmail')).toBe(false);
    service.dispose();
  });
  it('提醒开启后去重并调用系统适配，关闭与销毁清理连接和计时器', async () => {
    vi.useFakeTimers();
    class Socket extends EventEmitter implements MailSocket {
      readonly send = vi.fn();
      readonly terminate = vi.fn(() => this.emit('close'));
      close(): void {
        this.emit('close');
      }
    }
    const transport = new FakeMailTransport(),
      socket = new Socket(),
      onNotice = vi.fn();
    const factory = vi.fn(() => socket);
    const service = new QQMailService(native, '12345678', () => 42, {
      authFactory: () => new MailAuth(native, '12345678', () => 42, transport),
      socketFactory: factory,
      onNotice,
    });
    try {
      await service.setNotifications(true);
      socket.emit('open');
      expect(factory).toHaveBeenCalledTimes(1);
      expect(socket.send).toHaveBeenCalledTimes(1);
      const payload = JSON.stringify({
        cmd: 1,
        content: Buffer.from(
          JSON.stringify({ cid: '148', z: 5, e: 'mail-fixture', u: '主题', sn: '发件人', d: '1' }),
        ).toString('base64'),
      });
      socket.emit('message', Buffer.from(payload));
      socket.emit('message', Buffer.from(payload));
      expect(onNotice).toHaveBeenCalledTimes(1);
      await service.setNotifications(false);
      socket.emit('message', Buffer.from(payload));
      expect(onNotice).toHaveBeenCalledTimes(1);
      expect(socket.terminate).toHaveBeenCalledTimes(1);
      service.dispose();
      await vi.runAllTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });
  it.each([
    { notifications: true, showUnread: false },
    { notifications: false, showUnread: true },
  ])('后台偏好 %j 在启动与凭据就绪时连接，未读同步不强开提醒', async (preferences) => {
    vi.useFakeTimers();
    let pid: number | null = null;
    const nt = mailNative();
    const transport = new FakeMailTransport();
    const auth = new MailAuth(nt, '12345678', () => pid, transport);
    const query = vi.spyOn(auth, 'notificationQuery').mockResolvedValue({
      unread: 3,
      next_sync_time_interval_sec: 60,
      newmaillist: [{ mailid: 'existing-fixture' }],
    });
    const socket = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    });
    const onNotice = vi.fn();
    const service = new QQMailService(nt, '12345678', () => pid, {
      authFactory: () => auth,
      socketFactory: () => socket,
      onNotice,
    });
    try {
      service.startBackground(preferences);
      await vi.advanceTimersByTimeAsync(0);
      expect(service.status().state).toBe('error');
      pid = 42;
      service.credentialsAvailable();
      service.credentialsAvailable();
      await vi.advanceTimersByTimeAsync(0);
      expect(nt.ptFetchMailSession).toHaveBeenCalledOnce();
      expect(service.status()).toMatchObject({
        state: 'ready',
        unread: 3,
        notifications: preferences.notifications,
      });
      expect(onNotice).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(query).toHaveBeenCalledTimes(2);
      service.disconnect();
      service.credentialsAvailable();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(query).toHaveBeenCalledTimes(2);
      expect(service.status().state).toBe('disconnected');
    } finally {
      service.dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });
  it.each([false, true])(
    '首轮认证期间收到凭据后补连一次，主动断开=%s 时不复活连接',
    async (disconnect) => {
      vi.useFakeTimers();
      const nt = mailNative();
      let release: ((result: ReturnType<typeof okMailSession>) => void) | undefined;
      nt.ptFetchMailSession.mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof okMailSession>>((resolve) => {
            release = resolve;
          }),
      );
      const socket = Object.assign(new EventEmitter(), {
        send: vi.fn(),
        close: vi.fn(),
        terminate: vi.fn(),
      });
      const service = new QQMailService(nt, '12345678', () => 42, {
        authFactory: () => new MailAuth(nt, '12345678', () => 42, new FakeMailTransport()),
        socketFactory: () => socket,
      });
      try {
        service.startBackground({ notifications: true, showUnread: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(nt.ptFetchMailSession).toHaveBeenCalledOnce();
        service.credentialsAvailable();
        service.credentialsAvailable();
        if (disconnect) service.disconnect();
        if (!release) throw new Error('fixture authentication did not start');
        release({ ...okMailSession(), success: false, sid: '', msg: '旧入口不可用' });
        await vi.advanceTimersByTimeAsync(0);
        expect(nt.ptFetchMailSession).toHaveBeenCalledTimes(disconnect ? 1 : 2);
        expect(service.status().state).toBe(disconnect ? 'disconnected' : 'ready');
        if (disconnect) {
          service.credentialsAvailable();
          await vi.advanceTimersByTimeAsync(5 * 60_000);
          expect(nt.ptFetchMailSession).toHaveBeenCalledOnce();
        }
      } finally {
        service.dispose();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      }
    },
  );
  it('两个后台偏好均关闭时，启动与凭据刷新不连接邮箱', async () => {
    const nt = mailNative();
    const service = new QQMailService(nt, '12345678', () => 42);
    try {
      service.startBackground({ notifications: false, showUnread: false });
      service.credentialsAvailable();
      await Promise.resolve();
      expect(nt.ptFetchMailSession).not.toHaveBeenCalled();
      expect(service.status().state).toBe('disconnected');
    } finally {
      service.dispose();
    }
  });
  it('已启用提醒的账号先离线再恢复时，后台恢复连接并建立首轮基线', async () => {
    vi.useFakeTimers();
    class Socket extends EventEmitter implements MailSocket {
      send(): void {}
      close(): void {
        this.emit('close');
      }
      terminate(): void {
        this.emit('close');
      }
    }
    let pid: number | null = null;
    const transport = new FakeMailTransport(),
      socket = new Socket(),
      onNotice = vi.fn(),
      factory = vi.fn(() => socket);
    const service = new QQMailService(native, '12345678', () => pid, {
      authFactory: () => new MailAuth(native, '12345678', () => pid, transport),
      socketFactory: factory,
      onNotice,
      notificationsEnabled: true,
    });
    try {
      await expect(service.connect()).rejects.toThrow('请先登录');
      pid = 42;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(service.status().state).toBe('ready');
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            cmd: 1,
            content: Buffer.from(
              JSON.stringify({ cid: '148', z: 8, e: 'new-after-recovery', u: '主题' }),
            ).toString('base64'),
          }),
        ),
      );
      expect(onNotice).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });
  it('断开后晚到的列表不得恢复 ready 或污染新会话', async () => {
    const transport = new FakeMailTransport();
    const original = transport.request.bind(transport);
    let release: ((response: MailResponse) => void) | undefined;
    transport.request = async (url, options) =>
      new URL(url).pathname === '/list/maillist'
        ? new Promise<MailResponse>((resolve) => {
            release = resolve;
          })
        : original(url, options);
    const service = new QQMailService(native, '12345678', () => 42, {
      authFactory: () => new MailAuth(native, '12345678', () => 42, transport),
    });
    const pending = service.list({ folderId: 1, page: 0 });
    await vi.waitFor(() => expect(release).toBeDefined());
    service.disconnect();
    release!(transport.envelope({ list: [{ emailid: 'stale-mail' }], total_num: 1 }));
    await expect(pending).rejects.toThrow('状态已变化');
    expect(service.status().state).toBe('disconnected');
    service.dispose();
  });
  it('发送网络中断明确返回状态未知，不能自动重发', async () => {
    const transport = new FakeMailTransport();
    const original = transport.request.bind(transport);
    const sent = vi.fn();
    transport.request = async (url, options) => {
      if (new URL(url).pathname === '/send/sendmail') {
        sent();
        throw new MailFailure('network', '连接中断');
      }
      return original(url, options);
    };
    const service = new QQMailService(native, '12345678', () => 42, {
      authFactory: () => new MailAuth(native, '12345678', () => 42, transport),
    });
    await expect(service.send(compose)).rejects.toMatchObject({ kind: 'unknown-send' });
    expect(sent).toHaveBeenCalledTimes(1);
    service.dispose();
  });
  it('发送后切换会话不能把服务端成功误报为可直接重试的认证错误', async () => {
    const transport = new FakeMailTransport();
    const original = transport.request.bind(transport);
    let release: ((response: MailResponse) => void) | undefined;
    transport.request = async (url, options) =>
      new URL(url).pathname === '/send/sendmail'
        ? new Promise<MailResponse>((resolve) => {
            release = resolve;
          })
        : original(url, options);
    const service = new QQMailService(native, '12345678', () => 42, {
      authFactory: () => new MailAuth(native, '12345678', () => 42, transport),
    });
    const pending = service.send(compose);
    await vi.waitFor(() => expect(release).toBeDefined());
    service.disconnect();
    release!(transport.envelope({ mailid: 'accepted-fixture' }));
    await expect(pending).rejects.toMatchObject({ kind: 'unknown-send' });
    service.dispose();
  });
  it('推送基线和增量事件分别解析，不把票据或正文当作通知 DTO', () => {
    expect(
      decodeMailSocketFrame(
        JSON.stringify({
          cmd: 0,
          content: JSON.stringify({
            head: { ret: 0 },
            body: { lastest_msg_seq: 2, lastest_msg_dirid: 1 },
          }),
        }),
      ),
    ).toEqual({ kind: 'baseline', sequence: 2, folderId: 1 });
    const content = Buffer.from(
      JSON.stringify({
        cid: '148',
        z: 3,
        e: 'fixture',
        u: '主题',
        sn: '发件人',
        d: '1',
        sid: 'never-expose',
      }),
    ).toString('base64');
    const event = decodeMailSocketFrame(JSON.stringify({ cmd: 1, content }));
    expect(event).toEqual({
      kind: 'mail',
      sequence: 3,
      notice: { id: 'fixture', subject: '主题', sender: '发件人', folderId: 1 },
    });
    expect(JSON.stringify(event)).not.toContain('never-expose');
    expect(() => decodeMailSocketFrame('not-json')).toThrow(MailFailure);
  });
  it('首次只建立基线，两个提醒来源的同一封邮件只接收一次', () => {
    const cursor = new MailNoticeCursor();
    cursor.prime(['old']);
    expect(cursor.accept('old')).toBe(false);
    expect(cursor.accept('new')).toBe(true);
    expect(cursor.accept('new')).toBe(false);
  });
  it('附件签名只留在注册表，过期状态和外部下载地址被拒绝', () => {
    const registry = new MailAttachmentRegistry();
    const [attachment] = registry.fromMessage(
      {
        big_attach: [
          {
            name: '测试.txt',
            fileid: 'file',
            key: 'private-key',
            code: 'private-code',
            size: 3,
            download_url: 'https://evil.invalid/file',
          },
        ],
      },
      'mail-fixture',
    );
    expect(attachment).toBeDefined();
    expect(JSON.stringify(attachment)).not.toContain('private');
    expect(() => registry.downloadUrl(attachment!.id)).toThrow('不受信任');
    const [expired] = registry.fromMessage(
      { normal_attach: [{ name: '过期.txt', fileid: 'expired', status: -1 }] },
      'mail-fixture',
    );
    expect(expired!.available).toBe(false);
    expect(() => registry.get(expired!.id)).toThrow('已失效');
    registry.clear();
    expect(() => registry.get(attachment!.id)).toThrow('已失效');
  });
});

describe('邮箱认证边界', () => {
  it.each(['mail.qq.com', 'wx.mail.qq.com'])('%s 的普通附件复用原生会话 Cookie', async (host) => {
    const transport = new FakeMailTransport();
    const auth = new MailAuth(mailNative(), '12345678', () => 42, transport);
    try {
      const source = new URL(`https://${host}/attach/download?fileid=fixture`);
      const result = await auth.downloadCredentials(source, false);
      expect(result.cookie).toContain('sid=fixture-sid');
      expect(result.cookie).toContain('p_skey=fixture-mail');
      expect(result.url.searchParams.get('sid')).toBe('fixture-sid');
      expect(source.searchParams.has('sid')).toBe(false);
    } finally {
      auth.dispose();
    }
  });
  it.each(['mail.qq.com', 'wx.mail.qq.com'])(
    '%s 的超大附件换票据携带 Cookie，外部下载地址不携带',
    async (host) => {
      const transport = new FakeMailTransport();
      const auth = new MailAuth(mailNative(), '12345678', () => 42, transport);
      const cookies: string[] = [];
      transport.request = async (raw) => {
        const url = new URL(raw);
        expect(url.origin).toBe(`https://${host}`);
        cookies.push(await transport.jar.getCookieString(url.href));
        return transport.envelope({ url: 'https://download.qq.com/fixture' });
      };
      try {
        const result = await auth.downloadCredentials(
          new URL(`https://${host}/ftn/download`),
          true,
        );
        expect(cookies).toHaveLength(1);
        expect(cookies[0]).toContain('sid=fixture-sid');
        expect(result.url.href).toBe('https://download.qq.com/fixture');
        expect(result.cookie).toBe('');
      } finally {
        auth.dispose();
      }
    },
  );
  it('导入的 Cookie 限于两个 HTTPS 主机，不扩散到兄弟或下级域', async () => {
    const transport = new FakeMailTransport();
    const auth = new MailAuth(mailNative(), '12345678', () => 42, transport);
    try {
      await auth.connect();
      for (const url of [
        'http://mail.qq.com/',
        'http://wx.mail.qq.com/',
        'https://other.mail.qq.com/',
        'https://child.wx.mail.qq.com/',
        'https://qzone.qq.com/',
        'https://qq.com/',
      ])
        expect(await transport.jar.getCookieString(url)).toBe('');
    } finally {
      auth.dispose();
    }
  });
  it('主域响应更新的敏感 Cookie 也会从正文中脱敏', async () => {
    const transport = new FakeMailTransport();
    const auth = new MailAuth(mailNative(), '12345678', () => 42, transport);
    try {
      await auth.connect();
      await transport.jar.setCookie(
        'pt4_token=fixture-main-secret; Path=/; Secure',
        'https://mail.qq.com/',
      );
      expect(await auth.redact('<p>fixture-main-secret</p>')).toBe('<p>[redacted]</p>');
    } finally {
      auth.dispose();
    }
  });
  it('只有已探测的 loopback 端口能进入本机 TLS 例外', () => {
    expect(mailRequestTarget(new URL('https://127.0.0.1:4301/pt_get_st'), 4301).hostname).toBe(
      'localhost.ptlogin2.qq.com',
    );
    expect(() => mailRequestTarget(new URL('https://example.invalid:4301/'), 4301)).toThrow(
      MailFailure,
    );
    expect(() => mailRequestTarget(new URL('https://127.0.0.1:4303/'), 4301)).toThrow(MailFailure);
    expect(() => mailRequestTarget(new URL('http://wx.mail.qq.com/'))).toThrow(MailFailure);
    expect(() => mailRequestTarget(new URL('https://wx.mail.qq.com.evil.invalid/'))).toThrow(
      MailFailure,
    );
  });
  it('标准 CookieJar 隔离域、路径、HttpOnly 与过期票据', async () => {
    const jar = new CookieJar();
    await jar.setCookie(
      'p_skey=mail; Domain=mail.qq.com; Path=/; Secure; HttpOnly',
      'https://wx.mail.qq.com/',
    );
    await jar.setCookie(
      'p_skey=space; Domain=qzone.qq.com; Path=/; Secure',
      'https://qzone.qq.com/',
    );
    expect(await jar.getCookieString('https://wx.mail.qq.com/')).toBe('p_skey=mail');
    expect(await jar.getCookieString('https://qzone.qq.com/')).toBe('p_skey=space');
    expect(await jar.getCookieString('https://wx.mail.qq.com/', { http: false })).toBe('');
    await jar.setCookie(
      'p_skey=gone; Domain=mail.qq.com; Path=/; Max-Age=0',
      'https://wx.mail.qq.com/',
    );
    expect(await jar.getCookieString('https://wx.mail.qq.com/')).toBe('');
  });
  it('并发认证单飞，native 会话票据灌入 CookieJar 供后续请求复用', async () => {
    const transport = new FakeMailTransport();
    const nt = mailNative();
    const auth = new MailAuth(nt, '12345678', () => 42, transport);
    await Promise.all([auth.connect(), auth.connect(), auth.connect()]);
    expect(nt.ptFetchMailSession).toHaveBeenCalledOnce();
    expect(nt.ptFetchMailSession).toHaveBeenCalledWith(42, '12345678');
    expect(await transport.jar.getCookieString('https://wx.mail.qq.com/')).toContain(
      'sid=fixture-sid',
    );
    expect(await transport.jar.getCookieString('https://wx.mail.qq.com/')).toContain(
      'p_skey=fixture-mail',
    );
    expect(auth.ready).toBe(true);
  });
  it('native 返回失败时透传用户可读错误，不继续请求邮箱', async () => {
    const transport = new FakeMailTransport();
    const nt = mailNative({
      success: false,
      msg: '本地 QQ 返回的账号列表不包含指定 QQ 号',
      sid: '',
      panelPskey: '',
      cookie: '',
      errorKind: 'auth',
    });
    const auth = new MailAuth(nt, '12345678', () => 42, transport);
    await expect(auth.connect()).rejects.toMatchObject({
      kind: 'auth',
      message: '本地 QQ 返回的账号列表不包含指定 QQ 号',
    });
    expect(transport.calls).toEqual([]);
  });
  it('native 报告离线时映射成 offline，便于上层提示先登录 QQ', async () => {
    const nt = mailNative({
      success: false,
      msg: 'QQ 未在线',
      sid: '',
      panelPskey: '',
      cookie: '',
      errorKind: 'offline',
    });
    const auth = new MailAuth(nt, '12345678', () => 42, new FakeMailTransport());
    await expect(auth.connect()).rejects.toMatchObject({ kind: 'offline', message: 'QQ 未在线' });
  });
  it('读取失效只重认证一次，销毁后不能重连', async () => {
    const transport = new FakeMailTransport();
    const auth = new MailAuth(native, '12345678', () => 42, transport);
    transport.failReadOnce = true;
    await auth.cgi('/list/maillist');
    expect(transport.calls.filter((call) => call.url.pathname === '/list/maillist')).toHaveLength(
      2,
    );
    auth.dispose();
    expect(transport.closed).toBe(true);
    await expect(auth.connect()).rejects.toThrow('会话已关闭');
  });
  it('写操作不因登录错误被隐式重发', async () => {
    const transport = new FakeMailTransport();
    const auth = new MailAuth(native, '12345678', () => 42, transport);
    await auth.connect();
    const original = transport.request.bind(transport);
    const sent = vi.fn();
    transport.request = async (url, options) => {
      if (new URL(url).pathname === '/send/sendmail') {
        sent();
        return transport.envelope({}, -20002);
      }
      return original(url, options);
    };
    await expect(auth.cgi('/send/sendmail', {}, { write: true })).rejects.toThrow('登录已失效');
    expect(sent).toHaveBeenCalledTimes(1);
  });
});
