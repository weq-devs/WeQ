/**
 * `attachAndRegisterSsoSession` —— 「先 attach 拿物料、再登记原生 SSO 会话」
 * 这半步是 0xcde_2 在线取密钥能成立的前提。这里锁三件事：
 *   1. 身份齐全时确实调了 `setSsoSession`，且字段映射正确（a2/d2/d2key 是 hex→Buffer）；
 *   2. 缺 uid / guid 时**不**登记（发了也会被服务端以 -10003 拒），返回 registered: false；
 *   3. 物料不全时不登记。
 */
import { describe, expect, it, vi } from 'vitest';
import type { NtHelperBinding, SessionMaterial } from '@weq/native';
import type { Platform } from '@weq/platform';
import {
  attachAndRegisterSsoSession,
  PC_SUB_APP_ID,
  registerSsoSession,
  resolveDeviceGuid,
  resolveSubAppId,
} from '../src/account/sso_session';
import type { AttachHook } from '../src/bootstrap/attach';

const MATERIAL: SessionMaterial = {
  a2: 'aa'.repeat(4),
  d2: 'bb'.repeat(4),
  d2Key: '3d2c69392a38707d762c7370654b3a4e',
};

function fakePlatform(
  majorNodePath: string | null = '/opt/QQ/resources/app/major.node',
): Pick<Platform, 'qqWrapperNodePath' | 'qqDataRoot' | 'qqMajorNodePath'> {
  return {
    qqWrapperNodePath: () => '/opt/QQ/resources/app/wrapper.node',
    qqDataRoot: () => '/home/u/.config/QQ',
    qqMajorNodePath: () => majorNodePath,
  };
}

/** A native stub whose `resolveAppidFromMajor` returns `appid`. */
function fakeNt(
  appid: string | null,
  throws = false,
): Pick<NtHelperBinding, 'resolveAppidFromMajor'> {
  return {
    resolveAppidFromMajor: () => {
      if (throws) throw new Error('boom');
      return { appid: appid ?? '' };
    },
  } as unknown as Pick<NtHelperBinding, 'resolveAppidFromMajor'>;
}

describe('resolveSubAppId', () => {
  it('uses the appid scanned out of major.node', () => {
    expect(resolveSubAppId(fakeNt('537382819'), fakePlatform())).toBe(537382819);
  });

  it('falls back to the built-in constant when major.node is missing', () => {
    expect(resolveSubAppId(fakeNt('537382819'), fakePlatform(null))).toBe(PC_SUB_APP_ID);
  });

  it('falls back when the appid is unparsable', () => {
    expect(resolveSubAppId(fakeNt(''), fakePlatform())).toBe(PC_SUB_APP_ID);
  });

  it('falls back when resolveAppidFromMajor throws', () => {
    expect(resolveSubAppId(fakeNt(null, true), fakePlatform())).toBe(PC_SUB_APP_ID);
  });
});

describe('SSO client version metadata', () => {
  it('takes appid, version and signer from the running process instead of the older installation', async () => {
    const setSsoSession = vi.fn(async () => {});
    const major = vi.fn((pid?: number) =>
      pid === 42 ? '/hot/major.node' : '/installed/major.node',
    );
    const wrapper = vi.fn((pid?: number) =>
      pid === 42 ? '/hot/wrapper.node' : '/installed/wrapper.node',
    );
    const nt = {
      setSsoSession,
      resolveAppidFromMajor: (file: string) =>
        file.startsWith('/hot/')
          ? { appid: '537391652', version: '7.0.2', build: '53644' }
          : { appid: '537382843', version: '7.0.1', build: '52892' },
    } as unknown as Pick<NtHelperBinding, 'setSsoSession' | 'resolveAppidFromMajor'>;
    const ok = await registerSsoSession(
      nt,
      { qqMajorNodePath: major, qqWrapperNodePath: wrapper },
      42,
      { uin: '12345', uid: 'u_fixture', guid: 'ab'.repeat(16) },
      MATERIAL,
    );
    expect(ok).toBe(true);
    expect(setSsoSession.mock.calls[0]?.[1]).toMatchObject({
      subAppId: 537391652,
      clientVersion: '7.0.2-53644',
    });
    expect(setSsoSession.mock.calls[0]?.[2]).toBe('/hot/wrapper.node');
    expect(major).toHaveBeenCalledWith(42);
    expect(wrapper).toHaveBeenCalledWith(42);
  });

  it('does not register mismatched installed metadata when running modules are unavailable', async () => {
    const setSsoSession = vi.fn(async () => {});
    const nt = { setSsoSession, resolveAppidFromMajor: () => ({ appid: '537382843' }) };
    const ok = await registerSsoSession(
      nt as never,
      {
        qqMajorNodePath: () => {
          throw new Error('runtime modules unavailable');
        },
        qqWrapperNodePath: () => '/installed/wrapper.node',
      },
      42,
      { uin: '12345', uid: 'u_fixture', guid: 'ab'.repeat(16) },
      MATERIAL,
    );
    expect(ok).toBe(false);
    expect(setSsoSession).not.toHaveBeenCalled();
  });

  it('passes the installed QQ version and build to native registration', async () => {
    const setSsoSession = vi.fn(async () => {});
    const nt = {
      setSsoSession,
      resolveAppidFromMajor: () => ({ appid: '537382843', version: '7.0.1', build: '52892' }),
    } as unknown as Pick<NtHelperBinding, 'setSsoSession' | 'resolveAppidFromMajor'>;
    expect(
      await registerSsoSession(
        nt,
        fakePlatform(),
        42,
        { uin: '12345', uid: 'u_fixture', guid: 'ab'.repeat(16) },
        MATERIAL,
      ),
    ).toBe(true);
    expect(setSsoSession.mock.calls[0]?.[1]).toMatchObject({ clientVersion: '7.0.1-52892' });
  });
});

describe('registerSsoSession', () => {
  it('maps hex material to Buffers and registers with wrapper path', async () => {
    const setSsoSession = vi.fn(async () => {});
    const nt = {
      setSsoSession,
      resolveAppidFromMajor: () => ({ appid: '537382819' }),
    } as unknown as Pick<NtHelperBinding, 'setSsoSession' | 'resolveAppidFromMajor'>;
    const ok = await registerSsoSession(
      nt,
      fakePlatform(),
      42,
      { uin: '1707889225', uid: 'u_abc', guid: 'ab'.repeat(16) },
      MATERIAL,
    );
    expect(ok).toBe(true);
    expect(setSsoSession).toHaveBeenCalledTimes(1);
    const [, session, wrapper] = setSsoSession.mock.calls[0]!;
    expect(session).toMatchObject({
      uin: '1707889225',
      guid: 'ab'.repeat(16),
      uid: 'u_abc',
      subAppId: 537382819,
    });
    expect(Buffer.isBuffer(session.a2)).toBe(true);
    expect(session.a2.equals(Buffer.from(MATERIAL.a2!, 'hex'))).toBe(true);
    expect(session.d2Key.equals(Buffer.from(MATERIAL.d2Key!, 'hex'))).toBe(true);
    expect(wrapper).toBe('/opt/QQ/resources/app/wrapper.node');
  });

  it('skips registration when the uid is missing', async () => {
    const setSsoSession = vi.fn(async () => {});
    const nt = { setSsoSession, resolveAppidFromMajor: () => ({ appid: '1' }) } as unknown as Pick<
      NtHelperBinding,
      'setSsoSession' | 'resolveAppidFromMajor'
    >;
    const ok = await registerSsoSession(
      nt,
      fakePlatform(),
      42,
      { uin: '1707889225', uid: '', guid: 'ab'.repeat(16) },
      MATERIAL,
    );
    expect(ok).toBe(false);
    expect(setSsoSession).not.toHaveBeenCalled();
  });

  it('skips registration when the material is incomplete', async () => {
    const setSsoSession = vi.fn(async () => {});
    const nt = { setSsoSession, resolveAppidFromMajor: () => ({ appid: '1' }) } as unknown as Pick<
      NtHelperBinding,
      'setSsoSession' | 'resolveAppidFromMajor'
    >;
    const ok = await registerSsoSession(
      nt,
      fakePlatform(),
      42,
      { uin: '1707889225', uid: 'u_abc', guid: 'ab'.repeat(16) },
      { a2: 'aa', d2: undefined, d2Key: 'cc' },
    );
    expect(ok).toBe(false);
    expect(setSsoSession).not.toHaveBeenCalled();
  });
});

describe('attachAndRegisterSsoSession', () => {
  it('attaches once then registers with the attach material', async () => {
    const setSsoSession = vi.fn(async () => {});
    const nt = {
      setSsoSession,
      resolveAppidFromMajor: () => ({ appid: '123' }),
    } as unknown as NtHelperBinding;
    const ensure = vi.fn(async () => MATERIAL);
    const attachHook: AttachHook = {
      attach: ensure,
      ensure,
      reset: () => {},
    };
    const res = await attachAndRegisterSsoSession(
      nt,
      fakePlatform() as unknown as Platform,
      attachHook,
      7,
      '1707889225',
      { uid: 'u_abc', guid: 'ab'.repeat(16) },
    );
    expect(res.registered).toBe(true);
    expect(res.material).toEqual(MATERIAL);
    expect(ensure).toHaveBeenCalledWith(7, '1707889225');
    expect(setSsoSession).toHaveBeenCalledTimes(1);
  });

  it('returns registered:false without calling setSsoSession when identity is incomplete', async () => {
    const setSsoSession = vi.fn(async () => {});
    const nt = {
      setSsoSession,
      resolveAppidFromMajor: () => ({ appid: '123' }),
    } as unknown as NtHelperBinding;
    const ensure = vi.fn(async () => MATERIAL);
    const attachHook: AttachHook = { attach: ensure, ensure, reset: () => {} };
    const res = await attachAndRegisterSsoSession(
      nt,
      fakePlatform() as unknown as Platform,
      attachHook,
      7,
      '1707889225',
      { uid: null, guid: null },
    );
    expect(res.registered).toBe(false);
    expect(setSsoSession).not.toHaveBeenCalled();
  });
});

describe('resolveDeviceGuid', () => {
  it('reads the guid from the qq data root', () => {
    const readDeviceGuid = vi.fn(() => 'ab'.repeat(16));
    const nt = { readDeviceGuid } as unknown as Pick<NtHelperBinding, 'readDeviceGuid'>;
    expect(resolveDeviceGuid(nt, fakePlatform())).toBe('ab'.repeat(16));
    expect(readDeviceGuid).toHaveBeenCalledWith('/home/u/.config/QQ');
  });

  it('returns null when there is no data root or the read throws', () => {
    const nt = {
      readDeviceGuid: () => {
        throw new Error('boom');
      },
    } as unknown as Pick<NtHelperBinding, 'readDeviceGuid'>;
    expect(resolveDeviceGuid(nt, { qqDataRoot: () => null })).toBeNull();
    expect(resolveDeviceGuid(nt, fakePlatform())).toBeNull();
  });
});

describe('SSO rejects invalid tickets and unknown online appids', () => {
  it.each(['a', 'aaXX', ' aa', 'zz', ''])('rejects malformed hex %s', async (value) => {
    const setSsoSession = vi.fn();
    expect(
      await registerSsoSession(
        { setSsoSession } as never,
        fakePlatform(),
        42,
        { uin: '123', uid: 'u_test', guid: 'ab'.repeat(16), subAppId: 123 },
        { ...MATERIAL, a2: value },
      ),
    ).toBe(false);
    expect(setSsoSession).not.toHaveBeenCalled();
  });
  it.each(['aa'.repeat(15), 'aa'.repeat(17)])('rejects an incorrectly sized d2key', async (key) => {
    const setSsoSession = vi.fn();
    expect(
      await registerSsoSession(
        { setSsoSession } as never,
        fakePlatform(),
        42,
        { uin: '123', uid: 'u_test', guid: 'ab'.repeat(16), subAppId: 123 },
        { ...MATERIAL, d2Key: key },
      ),
    ).toBe(false);
    expect(setSsoSession).not.toHaveBeenCalled();
  });
  it('refuses missing, invalid and unreadable online metadata instead of guessing', () => {
    expect(() => resolveSubAppId(fakeNt('123'), fakePlatform(null), 42)).toThrow();
    expect(() => resolveSubAppId(fakeNt(''), fakePlatform(), 42)).toThrow();
    expect(() => resolveSubAppId(fakeNt(null, true), fakePlatform(), 42)).toThrow();
  });
});
