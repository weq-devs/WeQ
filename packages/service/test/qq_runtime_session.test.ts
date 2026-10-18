import { describe, expect, it, vi } from 'vitest';
import { ManagedQQSsoSession } from '../src/qq_runtime_session';
import { registerSsoSession } from '../src/account/sso_session';
import type { NtHelperBinding } from '@weq/native';

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
