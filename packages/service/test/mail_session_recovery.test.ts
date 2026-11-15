import { CookieJar } from 'tough-cookie';
import { expect, it, vi } from 'vitest';
import { MailAuth } from '../src/account/mail/auth';
import type { MailRequest } from '../src/account/mail/http';
import { MAIL_VERIFICATION_REQUIRED } from '../src/account/mail/types';
import { mailEnvelope, type MailObject } from '../src/account/mail/wire';

function response(body: MailObject = {}, ret = 0) {
  return { status: 200, body: JSON.stringify({ head: { ret }, body }) };
}

function fixture() {
  const session = (sid: string) => ({
    success: true,
    msg: '',
    sid,
    panelPskey: 'fixture-panel',
    cookie: `sid=${sid}`,
    errorKind: '',
  });
  const nt = {
    ptFetchMailSession: vi
      .fn(async () => session('fresh-session'))
      .mockResolvedValueOnce(session('old-session')),
  };
  const request = vi.fn(async (_raw: string | URL, _options: MailRequest = {}) => response());
  const auth = new MailAuth(nt, '10001', () => 42, {
    jar: new CookieJar(),
    request,
    dispose: vi.fn(),
  });
  return { nt, request, auth };
}

it('旧邮箱会话被拒绝的 -25001 可重新认证，不当成需要用户验证的错误', () => {
  expect(() => mailEnvelope({ head: { ret: -25001, msg: 'fixture-secret' } })).toThrow(
    expect.objectContaining({
      kind: 'auth',
      businessCode: '-25001',
      message: '邮箱登录已失效，请重新连接。',
    }),
  );
});

it('旧会话读取被拒绝时获取新会话，并用新 sid 重读一次', async () => {
  const { nt, request, auth } = fixture();
  request.mockImplementation(async (_raw, options = {}) =>
    options.form?.sid === 'old-session'
      ? response({}, -25001)
      : response({ list: [{ emailid: 'fixture-mail' }] }),
  );
  try {
    await expect(auth.cgi('/list/maillist')).resolves.toEqual({
      list: [{ emailid: 'fixture-mail' }],
    });
    expect(nt.ptFetchMailSession).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([, options]) => options?.form?.sid)).toEqual([
      'old-session',
      'fresh-session',
    ]);
  } finally {
    auth.dispose();
  }
});

it.each([false, true])(
  '超过验证间隔后旧会话刷新被拒绝，恢复后继续请求，写操作=%s',
  async (write) => {
    vi.useFakeTimers();
    const { nt, request, auth } = fixture();
    const path = write ? '/send/sendmail' : '/list/maillist';
    request.mockImplementation(async (raw, options = {}) => {
      if (new URL(raw).pathname === '/login/login') return response({}, -25001);
      return options.form?.sid === 'fresh-session'
        ? response({ result: 'ok' })
        : response({}, -25001);
    });
    try {
      await auth.connect();
      vi.setSystemTime(Date.now() + 16 * 60_000);
      await expect(auth.cgi(path, {}, { write })).resolves.toEqual({ result: 'ok' });
      expect(nt.ptFetchMailSession).toHaveBeenCalledTimes(2);
      expect(request.mock.calls.map(([raw]) => new URL(raw).pathname)).toEqual([
        '/login/login',
        path,
      ]);
      expect(request.mock.calls[0]?.[1]?.form).toMatchObject({
        sid: 'old-session',
        auth_type: 6,
      });
      expect(request.mock.calls[1]?.[1]?.form?.sid).toBe('fresh-session');
      await auth.cgi('/list/folderlist');
      expect(
        request.mock.calls.filter(([raw]) => new URL(raw).pathname === '/login/login'),
      ).toHaveLength(1);
    } finally {
      auth.dispose();
      vi.useRealTimers();
    }
  },
);

it('列表和文件夹并发遇到刷新拒绝时共用一次刷新和重新认证', async () => {
  vi.useFakeTimers();
  const { nt, request, auth } = fixture();
  request.mockImplementation(async (raw, options = {}) => {
    if (new URL(raw).pathname === '/login/login') return response({}, -25001);
    return options.form?.sid === 'fresh-session'
      ? response({ result: 'ok' })
      : response({}, -25001);
  });
  try {
    await auth.connect();
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await expect(
      Promise.all([auth.cgi('/list/maillist'), auth.cgi('/list/folderlist')]),
    ).resolves.toEqual([{ result: 'ok' }, { result: 'ok' }]);
    expect(nt.ptFetchMailSession).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.filter(([raw]) => new URL(raw).pathname === '/login/login'),
    ).toHaveLength(1);
    expect(request.mock.calls.slice(1).map(([, options]) => options?.form?.sid)).toEqual([
      'fresh-session',
      'fresh-session',
    ]);
  } finally {
    auth.dispose();
    vi.useRealTimers();
  }
});

it('发送提交后被拒绝时不自动重发，后续操作重新获取会话', async () => {
  const { nt, request, auth } = fixture();
  request.mockResolvedValueOnce(response({}, -25001));
  try {
    await expect(auth.cgi('/send/sendmail', {}, { write: true })).rejects.toMatchObject({
      kind: 'auth',
      businessCode: '-25001',
    });
    expect(request).toHaveBeenCalledOnce();
    expect(nt.ptFetchMailSession).toHaveBeenCalledOnce();
    expect(auth.ready).toBe(false);
    await auth.cgi('/list/folderlist');
    expect(nt.ptFetchMailSession).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]?.form?.sid).toBe('fresh-session');
  } finally {
    auth.dispose();
  }
});

it('新会话读取仍被拒绝时返回错误，不无限重新认证', async () => {
  const { nt, request, auth } = fixture();
  request.mockResolvedValue(response({}, -25001));
  try {
    await expect(auth.cgi('/list/maillist')).rejects.toMatchObject({
      kind: 'auth',
      businessCode: '-25001',
    });
    expect(nt.ptFetchMailSession).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    auth.dispose();
  }
});

it('重新认证明确要求用户验证时保留原提示，不继续重试', async () => {
  const { nt, request, auth } = fixture();
  request.mockResolvedValue(response({}, -25001));
  nt.ptFetchMailSession.mockResolvedValueOnce({
    success: false,
    msg: '邮箱拒绝了当前登录环境，请通过 QQ 客户端的邮箱入口确认登录后重试',
    sid: '',
    panelPskey: '',
    cookie: '',
    errorKind: 'auth',
  });
  try {
    await expect(auth.cgi('/list/maillist')).rejects.toMatchObject({
      kind: 'auth',
      businessCode: MAIL_VERIFICATION_REQUIRED,
      message: expect.stringContaining('邮箱拒绝了当前登录环境'),
    });
    expect(nt.ptFetchMailSession).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledOnce();
    expect(auth.ready).toBe(false);
  } finally {
    auth.dispose();
  }
});

it('无关业务错误不触发换票据，也不更改错误码', async () => {
  const { nt, request, auth } = fixture();
  request.mockResolvedValue(response({}, -123));
  try {
    await expect(auth.cgi('/list/maillist')).rejects.toMatchObject({
      kind: 'business',
      businessCode: '-123',
    });
    expect(nt.ptFetchMailSession).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  } finally {
    auth.dispose();
  }
});
