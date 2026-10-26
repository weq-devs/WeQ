import { EventEmitter } from 'node:events';
import { CookieJar } from 'tough-cookie';
import { expect, it, vi } from 'vitest';
import { MailAuth } from '../src/account/mail/auth';
import { QQMailService } from '../src/account/mail/client';

function fixture(message: string) {
  const nt = {
    ptFetchMailSession: vi.fn(async () => ({
      success: false,
      msg: message,
      sid: '',
      panelPskey: '',
      cookie: '',
      errorKind: 'auth',
    })),
  };
  const auth = new MailAuth(nt, '10001', () => 42, {
    jar: new CookieJar(),
    request: vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ head: { ret: 0 }, body: {} }),
    })),
    dispose: vi.fn(),
  });
  vi.spyOn(auth, 'notificationQuery').mockResolvedValue({ unread: 0, newmaillist: [] });
  vi.spyOn(auth, 'socketCredentials').mockResolvedValue({ cookie: '', frame: '' });
  const socket = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  });
  const service = new QQMailService(nt, '10001', () => 42, {
    authFactory: () => auth,
    socketFactory: () => socket,
  });
  return { nt, service };
}

it.each([
  '邮箱需要二次验证，请先在 QQ 邮箱完成验证后重试',
  '邮箱拒绝了当前登录环境，请通过 QQ 客户端的邮箱入口确认登录后重试',
])('明确认证限制停止后台重试但不修改偏好，用户验证后可手动恢复：%s', async (message) => {
  vi.useFakeTimers();
  const { nt, service } = fixture(message);
  try {
    service.startBackground({ notifications: true, showUnread: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(nt.ptFetchMailSession).toHaveBeenCalledOnce();
    service.credentialsAvailable();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(nt.ptFetchMailSession).toHaveBeenCalledOnce();
    expect(service.status()).toMatchObject({ state: 'error', notifications: true, error: message });
    nt.ptFetchMailSession.mockResolvedValueOnce({
      success: true,
      msg: '',
      sid: 'synthetic-sid',
      panelPskey: 'synthetic-p',
      cookie: '',
      errorKind: '',
    });
    await service.connect();
    expect(nt.ptFetchMailSession).toHaveBeenCalledTimes(2);
    expect(service.status().state).toBe('ready');
  } finally {
    service.dispose();
    vi.useRealTimers();
  }
});

it('普通认证或网络故障保留原有后台恢复，不能都当成风控永久停试', async () => {
  vi.useFakeTimers();
  const { nt, service } = fixture('邮箱网络认证失败，请稍后重试。');
  try {
    service.startBackground({ notifications: false, showUnread: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(nt.ptFetchMailSession).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(nt.ptFetchMailSession).toHaveBeenCalledTimes(2);
  } finally {
    service.dispose();
    vi.useRealTimers();
  }
});
