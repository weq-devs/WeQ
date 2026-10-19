import { describe, expect, it, vi } from 'vitest';
import {
  ManagedQQSsoSession,
  createRuntimeAwareAttachHook,
  claimManagedQQProcess,
} from '../src/qq_runtime_session';
import { registerSsoSession, attachAndRegisterSsoSession } from '../src/account/sso_session';
import type { NtHelperBinding } from '@weq/native';
import type { Platform } from '@weq/platform';

const material = { a2: 'aa'.repeat(8), d2: 'bb'.repeat(8), d2Key: 'cc'.repeat(16) };
function fixture() {
  const nt = {
    setSsoSession: vi.fn<NtHelperBinding['setSsoSession']>(async () => {}),
    hasSsoSession: vi.fn(async () => true),
    clearSsoSession: vi.fn(async () => true),
    resolveAppidFromMajor: vi.fn(() => ({ appid: '12345', version: 'fixture', build: '1' })),
  };
  const client = {
    pid: 123,
    identity: {
      uin: '10001',
      uid: 'u_self',
      guid: 'ab'.repeat(16),
      subAppId: 12345,
      clientVersion: 'fixture-1',
    },
    wrapperPath: '/fixture/wrapper.node',
    majorPath: '/fixture/major.node',
  };
  const lease = new ManagedQQSsoSession(nt, client);
  return { nt, client, lease, signal: new AbortController().signal };
}
describe('托管 SSO 私有租约', () => {
  it('私有交接途中实际进程退出时不交付旧票据，也不回退扫描', async () => {
    const f = fixture();
    const external = {
      attach: vi.fn(async () => material),
      ensure: vi.fn(async () => material),
      reset: vi.fn(),
    };
    const aware = createRuntimeAwareAttachHook(f.nt, external);
    const release = claimManagedQQProcess(f.nt, f.client.pid, () =>
      f.lease.readTransportMaterial(),
    );
    await f.lease.register(material, f.signal);
    let finish: (value: boolean) => void = () => {};
    f.nt.hasSsoSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = aware.ensure(f.client.pid, f.client.identity.uin);
    release();
    finish(true);
    await expect(pending).rejects.toThrow(/已失效/);
    expect(external.ensure).not.toHaveBeenCalled();
    await f.lease.close();
  });
  it('不接受虚构 PID 的托管声明', () => {
    const f = fixture();
    for (const pid of [0, -1, Number.NaN])
      expect(() => claimManagedQQProcess(f.nt, pid, () => null)).toThrow(/PID 无效/);
  });
  it('外部 QQ 的读取仍同步入队，不越过现有 reset/取消栅栏', async () => {
    const f = fixture();
    const external = {
      attach: vi.fn(async () => material),
      ensure: vi.fn(async () => material),
      reset: vi.fn(),
    };
    const aware = createRuntimeAwareAttachHook(f.nt, external);
    const first = aware.ensure(456, '10002');
    expect(external.ensure).toHaveBeenCalledOnce();
    await first;
    external.ensure.mockClear();
    const second = attachAndRegisterSsoSession(
      f.nt as unknown as NtHelperBinding,
      {} as Platform,
      external,
      456,
      '10002',
      {},
    );
    expect(external.ensure).toHaveBeenCalledOnce();
    await second;
  });
  it('私有物料返回副本，连接取消后即使尚未清理原生登记也不再提供', async () => {
    const f = fixture(),
      signal = new AbortController();
    await f.lease.register(material, signal.signal);
    const copy = f.lease.readTransportMaterial()!;
    copy.material.a2 = '00';
    copy.identity.uid = 'u_changed';
    expect(f.lease.readTransportMaterial()).toEqual({
      identity: {
        uin: f.client.identity.uin,
        uid: f.client.identity.uid,
        guid: f.client.identity.guid,
      },
      material,
    });
    signal.abort();
    expect(f.lease.readTransportMaterial()).toBeNull();
    expect(f.lease.isReady()).toBe(false);
    await f.lease.close();
  });
  it('旧 attach 与登记入口复用已验证托管会话，不读外部内存也不替换租约', async () => {
    const f = fixture();
    const external = {
      attach: vi.fn(async () => material),
      ensure: vi.fn(async () => material),
      reset: vi.fn(),
    };
    const aware = createRuntimeAwareAttachHook(f.nt, external);
    const release = claimManagedQQProcess(f.nt, f.client.pid, () =>
      f.lease.readTransportMaterial(),
    );
    await f.lease.register(material, f.signal);
    expect(await aware.ensure(f.client.pid, f.client.identity.uin)).toEqual(material);
    const result = await attachAndRegisterSsoSession(
      f.nt as unknown as NtHelperBinding,
      {} as Platform,
      aware,
      f.client.pid,
      f.client.identity.uin,
      {},
    );
    expect(result).toEqual({ registered: true, material });
    expect(f.nt.setSsoSession).toHaveBeenCalledOnce();
    expect(f.lease.isReady()).toBe(true);
    expect(external.ensure).not.toHaveBeenCalled();
    expect(external.attach).not.toHaveBeenCalled();
    await f.lease.close();
    release();
  });
  it('托管启动、关闭中或账号不匹配时明确拒绝，不回退到提权扫描', async () => {
    const f = fixture();
    const external = {
      attach: vi.fn(async () => material),
      ensure: vi.fn(async () => material),
      reset: vi.fn(),
    };
    const aware = createRuntimeAwareAttachHook(f.nt, external);
    const release = claimManagedQQProcess(f.nt, f.client.pid, () =>
      f.lease.readTransportMaterial(),
    );
    await expect(aware.ensure(f.client.pid, '10001')).rejects.toThrow(/尚未就绪/);
    await f.lease.register(material, f.signal);
    await expect(aware.attach(f.client.pid, '10002')).rejects.toThrow(/账号不匹配/);
    await f.lease.close();
    await expect(aware.ensure(f.client.pid, '10001')).rejects.toThrow(/尚未就绪/);
    expect(external.ensure).not.toHaveBeenCalled();
    expect(external.attach).not.toHaveBeenCalled();
    release();
    expect(await aware.ensure(f.client.pid, '10001')).toEqual(material);
    expect(external.ensure).toHaveBeenCalledOnce();
  });
  it('登记真实 PID 与安装快照，不探测外部 QQ 模块，不回传票据', async () => {
    const f = fixture();
    expect(f.lease.isReady()).toBe(false);
    expect(await f.lease.register(material, f.signal)).toBe(true);
    expect(f.nt.setSsoSession).toHaveBeenCalledWith(
      f.client.pid,
      expect.objectContaining({
        uin: f.client.identity.uin,
        uid: f.client.identity.uid,
        guid: f.client.identity.guid,
        subAppId: f.client.identity.subAppId,
        clientVersion: f.client.identity.clientVersion,
        a2: Buffer.from(material.a2, 'hex'),
        d2: Buffer.from(material.d2, 'hex'),
        d2Key: Buffer.from(material.d2Key, 'hex'),
      }),
      f.client.wrapperPath,
    );
    expect(f.nt.resolveAppidFromMajor).not.toHaveBeenCalled();
    expect(f.lease.isReady()).toBe(true);
    await f.lease.close();
    expect(f.lease.isReady()).toBe(false);
    expect(f.nt.clearSsoSession).toHaveBeenCalledWith(f.client.pid);
  });
  it('取消或票据不完整时不登记', async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    expect(await f.lease.register(material, abort.signal)).toBe(false);
    expect(await f.lease.register({ ...material, d2Key: 'xx' }, f.signal)).toBe(false);
    expect(f.nt.setSsoSession).not.toHaveBeenCalled();
    await f.lease.close();
    expect(f.nt.clearSsoSession).not.toHaveBeenCalled();
  });
  it('登记期间关闭时回收迟到成功，不发布可用状态', async () => {
    const f = fixture();
    let finish = () => {};
    f.nt.setSsoSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.lease.register(material, f.signal);
    await vi.waitFor(() => expect(f.nt.setSsoSession).toHaveBeenCalled());
    const closing = f.lease.close();
    finish();
    expect(await pending).toBe(false);
    await closing;
    expect(f.nt.clearSsoSession).toHaveBeenCalledOnce();
    expect(f.lease.isReady()).toBe(false);
  });
  it('原生无法确认登记时清理自己的记录', async () => {
    const f = fixture();
    f.nt.hasSsoSession.mockRejectedValueOnce(new Error('fixture'));
    expect(await f.lease.register(material, f.signal)).toBe(false);
    expect(f.nt.clearSsoSession).toHaveBeenCalledOnce();
    expect(f.lease.isReady()).toBe(false);
  });
  it('同 PID 已被别的登记替换后不误清理新会话', async () => {
    const f = fixture();
    await f.lease.register(material, f.signal);
    await registerSsoSession(
      f.nt,
      { qqWrapperNodePath: () => f.client.wrapperPath, qqMajorNodePath: () => f.client.majorPath },
      f.client.pid,
      { ...f.client.identity, uin: '10002', uid: 'u_other' },
      material,
    );
    expect(f.lease.isReady()).toBe(false);
    await f.lease.close();
    expect(f.nt.clearSsoSession).not.toHaveBeenCalled();
  });
  it('清理失败保留租约以便重试，关闭后不再接受登记', async () => {
    const f = fixture();
    await f.lease.register(material, f.signal);
    f.nt.clearSsoSession.mockRejectedValueOnce(new Error('fixture-clear'));
    await expect(f.lease.close()).rejects.toThrow('fixture-clear');
    await f.lease.close();
    expect(f.nt.clearSsoSession).toHaveBeenCalledTimes(2);
    expect(await f.lease.register(material, f.signal)).toBe(false);
  });
});
