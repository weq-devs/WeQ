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
} from '../src/account/sso_session';
import type { AttachHook } from '../src/bootstrap/attach';

const MATERIAL: SessionMaterial = {
  a2: 'aa'.repeat(4),
  d2: 'bb'.repeat(4),
  d2Key: '3d2c69392a38707d762c7370654b3a4e',
};

function fakePlatform(): Pick<Platform, 'qqWrapperNodePath' | 'qqDataRoot'> {
  return {
    qqWrapperNodePath: () => '/opt/QQ/resources/app/wrapper.node',
    qqDataRoot: () => '/home/u/.config/QQ',
  };
}

describe('registerSsoSession', () => {
  it('maps hex material to Buffers and registers with wrapper path', async () => {
    const setSsoSession = vi.fn(async () => {});
    const nt = { setSsoSession } as unknown as Pick<NtHelperBinding, 'setSsoSession'>;
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
      subAppId: PC_SUB_APP_ID,
    });
    expect(Buffer.isBuffer(session.a2)).toBe(true);
    expect(session.a2.equals(Buffer.from(MATERIAL.a2!, 'hex'))).toBe(true);
    expect(session.d2Key.equals(Buffer.from(MATERIAL.d2Key!, 'hex'))).toBe(true);
    expect(wrapper).toBe('/opt/QQ/resources/app/wrapper.node');
  });

  it('skips registration when the uid is missing', async () => {
    const setSsoSession = vi.fn(async () => {});
    const nt = { setSsoSession } as unknown as Pick<NtHelperBinding, 'setSsoSession'>;
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
    const nt = { setSsoSession } as unknown as Pick<NtHelperBinding, 'setSsoSession'>;
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
    const nt = { setSsoSession } as unknown as NtHelperBinding;
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
    const nt = { setSsoSession } as unknown as NtHelperBinding;
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
