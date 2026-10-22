// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RemoteStore } from '../src/main/remote/store';
import { RemotePairing, tokenHash } from '../src/main/remote/pairing';

it('重启与关闭连接保留设备，删除后重启仍拒绝旧凭据；磁盘没有明文令牌或邀请', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-remote-store-'));
  try {
    const store = new RemoteStore(dir);
    const first = new RemotePairing();
    first.restore(store.claims(), (claims) => store.save({ claims }));
    const token = 'c'.repeat(64);
    const invitation = first.invite();
    const claim = first.claim({
      invitation: invitation.secret,
      name: '测试手机',
      tokenHash: tokenHash(token),
      scope: 'web:access',
    });
    expect(new RemoteStore(dir).claims()).toEqual([]);
    first.decide(claim.id, true);
    first.clear();
    const disk = readFileSync(join(dir, 'devices.json'), 'utf8');
    expect(disk).not.toContain(token);
    expect(disk).not.toContain(invitation.secret);
    const reload = new RemoteStore(dir);
    const second = new RemotePairing();
    second.restore(reload.claims(), (claims) => reload.save({ claims }));
    expect(second.canAccessWeb(token)).toBe(true);
    second.revoke(claim.id);
    expect(new RemoteStore(dir).claims()).toEqual([]);
    expect(second.authenticate(token)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('凭据落盘失败时不授予新权限，也不误报已删除设备', () => {
  const pairing = new RemotePairing();
  const token = 'd'.repeat(64);
  const claim = pairing.claim({
    invitation: pairing.invite().secret,
    name: '手机',
    tokenHash: tokenHash(token),
    scope: 'web:access',
  });
  pairing.decide(claim.id, true);
  pairing.restore(
    [
      {
        id: claim.id,
        name: '手机',
        tokenHash: tokenHash(token),
        code: '',
        expiresAt: 0,
        approvedAt: 1,
        lastSeenAt: null,
        scope: 'web:access',
      },
    ],
    () => {
      throw new Error('disk full');
    },
  );
  expect(() => pairing.revoke(claim.id)).toThrow('disk full');
  expect(pairing.canAccessWeb(token)).toBe(true);
});
