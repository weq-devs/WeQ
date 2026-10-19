import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QQKernelHost,
  validateQQKernelOptions,
  qqKernelErrorText,
} from '../src/main/qq_runtime/kernel_host';
import type { QQKernelEvent, QQKernelOptions } from '../src/main/qq_runtime/kernel_protocol';
import { qqKernelRegistrationArgs } from '../build/qq_kernel_registration';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'weq-kernel-fixture-'));
  directories.push(dataRoot);
  const options: QQKernelOptions = {
    instanceId: 'fixture',
    nonce: '11'.repeat(24),
    wrapperPath: '/Applications/QQ.app/Contents/Resources/app/wrapper.node',
    dataRoot,
    client: { appId: '12345', version: '1.2.3-456', qua: 'fixture-qua' },
    device: { hostName: 'fixture', osVersion: 'fixture-os' },
    expectedUin: '10001',
  };
  let loginListener: Record<string, (...args: unknown[]) => void> = {};
  let sessionListener: Record<string, (...args: unknown[]) => void> = {};
  const engine = { initWithDeskTopConfig: vi.fn(), destroy: vi.fn() };
  const login = {
    initConfig: vi.fn(),
    addKernelLoginListener: vi.fn((listener) => {
      loginListener = listener;
      return 1;
    }),
    removeKernelLoginListener: vi.fn(),
    connect: vi.fn(() => true),
    abortPolling: vi.fn(),
    cancel: vi.fn(),
    destroy: vi.fn(),
    getQRCodePicture: vi.fn(() => true),
    getMachineGuid: vi.fn(() => 'ab'.repeat(16)),
    quickLoginWithUin: vi.fn(async () => ({ result: '1', loginErrorInfo: {} })),
  };
  const session = {
    init: vi.fn((_config, _depends, _dispatcher, listener) => {
      sessionListener = listener;
    }),
  };
  const startup = { start: vi.fn(), stop: vi.fn() };
  const api = {
    NodeIQQNTWrapperEngine: { get: () => engine },
    NodeIKernelLoginService: { get: () => login },
    NodeIQQNTStartupSessionWrapper: { create: () => startup },
    NodeIQQNTWrapperSession: { getNTWrapperSession: () => session },
  };
  const events: QQKernelEvent[] = [];
  const host = new QQKernelHost(api, options, (event) => events.push(event));
  await host.initialize();
  return {
    host,
    options,
    engine,
    login,
    session,
    startup,
    events,
    listener: () => loginListener,
    sessionListener: () => sessionListener,
  };
}

describe('托管 QQ 内核宿主（不加载真实 QQ）', () => {
  it('已收到有效登录身份后，迟到的快登结果不覆盖为验证页面', async () => {
    const f = await fixture();
    f.listener().onLoginConnected!();
    f.login.quickLoginWithUin.mockImplementationOnce(async () => {
      f.listener().onQRCodeLoginSucceed!({ uin: '10001', uid: 'u_self' });
      return { result: '1', loginErrorInfo: { proofWaterUrl: 'https://ssl.qq.com/verify' } };
    });
    await f.host.startLogin('10001');
    await vi.waitFor(() => expect(f.session.init).toHaveBeenCalledOnce());
    expect(f.events.some((event) => event.type === 'verification')).toBe(false);
    expect(f.login.getQRCodePicture).not.toHaveBeenCalled();
    await f.host.stop();
  });
  it('缓存登录异常时回落到二维码，不停在无二维码的登录页', async () => {
    const f = await fixture();
    f.listener().onLoginConnected!();
    f.login.quickLoginWithUin.mockRejectedValueOnce(new Error('fixture-expired-cache'));
    await expect(f.host.startLogin('10001')).resolves.toBeUndefined();
    expect(f.login.getQRCodePicture).toHaveBeenCalledOnce();
    await f.host.stop();
  });
  it('返回码为零但仍带登录错误时不当作缓存登录成功', async () => {
    const f = await fixture();
    f.listener().onLoginConnected!();
    f.login.quickLoginWithUin.mockResolvedValueOnce({
      result: '0',
      loginErrorInfo: { errMsg: 'fixture-login-failed' },
    });
    await f.host.startLogin('10001');
    expect(f.login.getQRCodePicture).toHaveBeenCalledOnce();
    await f.host.stop();
  });
  it('未连接、未完成初始化、断线和停止时均不给出发包身份', async () => {
    const f = await fixture();
    expect(f.host.sessionForTransport()).toBeNull();
    f.listener().onLoginConnected!();
    f.listener().onQRCodeLoginSucceed!({ uin: '10001', uid: 'u_self' });
    await vi.waitFor(() => expect(f.session.init).toHaveBeenCalled());
    expect(f.host.sessionForTransport()).toBeNull();
    f.sessionListener().onSessionInitComplete!({});
    expect(f.host.sessionForTransport()).toEqual({
      uin: '10001',
      uid: 'u_self',
      guid: 'ab'.repeat(16),
    });
    f.listener().onLoginDisConnected!();
    expect(f.host.sessionForTransport()).toBeNull();
    await f.host.stop();
    expect(f.host.sessionForTransport()).toBeNull();
  });
  it('初始化只配置内核，不发起登录，身份来自实际安装版本输入', async () => {
    const f = await fixture();
    expect(f.engine.initWithDeskTopConfig.mock.calls[0]?.[0]).toMatchObject({
      app_version: f.options.client.version,
      qua: f.options.client.qua,
      global_path_config: { desktopGlobalPath: join(f.options.dataRoot, 'global') },
    });
    expect(f.login.connect).not.toHaveBeenCalled();
    expect(f.events.map((event) => event.type)).toEqual(['initialized']);
    await f.host.stop();
    expect(f.login.abortPolling).not.toHaveBeenCalled();
    expect(f.login.cancel).not.toHaveBeenCalled();
    expect(f.startup.stop).not.toHaveBeenCalled();
  });

  it('首次二维码前不能 abortPolling，重复连接回调不重复申请', async () => {
    const f = await fixture();
    await f.host.startLogin();
    f.listener().onLoginConnected!();
    f.listener().onLoginConnected!();
    expect(f.login.getQRCodePicture).toHaveBeenCalledOnce();
    expect(f.login.abortPolling).not.toHaveBeenCalled();
    f.host.refreshQr();
    expect(f.login.abortPolling).toHaveBeenCalledOnce();
    expect(f.login.getQRCodePicture).toHaveBeenCalledTimes(2);
    await f.host.stop();
    expect(f.login.cancel).toHaveBeenCalledOnce();
    expect(f.events.at(-1)?.type).toBe('stopped');
  });

  it('只有明确的过期码才称二维码过期，其他失败不自动刷新', async () => {
    const f = await fixture();
    f.listener().onQRCodeSessionFailed!(1, 3);
    expect(f.events.at(-1)?.type).toBe('qr-expired');
    f.listener().onQRCodeSessionFailed!(5, 9);
    expect(f.events.at(-1)).toMatchObject({ type: 'error', code: 'qr-session-failed' });
    expect(f.login.getQRCodePicture).not.toHaveBeenCalled();
    await f.host.stop();
  });

  it('错误扫码账号不会初始化账号会话，迟到回调不复活已停止宿主', async () => {
    const f = await fixture();
    f.listener().onQRCodeLoginSucceed!({ uin: '10002', uid: 'u_wrong' });
    await vi.waitFor(() => expect(f.events.at(-1)?.type).toBe('stopped'));
    expect(f.session.init).not.toHaveBeenCalled();
    expect(f.events.some((event) => event.type === 'login')).toBe(false);
    f.listener().onLoginConnected!();
    expect(f.events.at(-1)?.type).toBe('stopped');
  });

  it('登录和会话初始化分开，遥测成功不算会话或数据库就绪', async () => {
    const f = await fixture();
    f.listener().onQRCodeLoginSucceed!({ uin: '10001', uid: 'u_self' });
    await vi.waitFor(() => expect(f.session.init).toHaveBeenCalledOnce());
    expect(f.events.some((event) => event.type === 'login')).toBe(true);
    expect(f.events.some((event) => event.type === 'session-initialized')).toBe(false);
    f.sessionListener().onOpentelemetryInit!({ is_init: true });
    expect(f.events.some((event) => event.type === 'session-initialized')).toBe(false);
    f.sessionListener().onSessionInitComplete!({});
    expect(f.events.at(-1)).toMatchObject({
      type: 'session-initialized',
      uid: 'u_self',
      guid: 'ab'.repeat(16),
    });
    await f.host.stop();
    expect(f.startup.stop).toHaveBeenCalledOnce();
    expect(f.login.cancel).not.toHaveBeenCalled();
  });

  it('二维码和错误消息有界，不把凭据或验证 URL 放进错误文案', async () => {
    const f = await fixture();
    f.listener().onQRCodeGetPicture!({ pngBase64QrcodeData: 'not-png', qrcodeUrl: 'fixture' });
    expect(f.events.at(-1)).toMatchObject({ type: 'error', code: 'kernel-callback' });
    expect(
      qqKernelErrorText(
        new Error(`secret=${'ab'.repeat(32)} https://captcha.qq.com/?ticket=secret`),
      ),
    ).not.toContain('ticket=secret');
    expect(qqKernelErrorText('ab'.repeat(32))).toBe('[redacted]');
    await f.host.stop();
  });

  it('配置只保留声明字段，不允许把安装目录或根目录用作数据目录', async () => {
    const f = await fixture();
    expect(validateQQKernelOptions({ ...f.options, dbKey: 'not-forwarded' })).not.toHaveProperty(
      'dbKey',
    );
    expect(() => validateQQKernelOptions({ ...f.options, dataRoot: '/' })).toThrow(/路径/);
    expect(() =>
      validateQQKernelOptions({
        ...f.options,
        dataRoot: '/Applications/QQ.app/Contents/Resources/app/data',
      }),
    ).toThrow(/安装/);
    expect(() =>
      validateQQKernelOptions({ ...f.options, client: { ...f.options.client, appId: '' } }),
    ).toThrow(/身份/);
    await f.host.stop();
  });

  it('注册桥构建包含两种架构，路径作为独立参数不经 shell 拼接', () => {
    const args = qqKernelRegistrationArgs('/source path/a.c', '/output path/a.node');
    expect(args.filter((arg) => arg === '-arch')).toHaveLength(2);
    expect(args).toContain('arm64');
    expect(args).toContain('x86_64');
    expect(args).toContain('/source path/a.c');
    expect(args.at(-1)).toBe('/output path/a.node');
  });
});
