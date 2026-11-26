// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CLAIM_TTL, INVITATION_TTL, RemotePairing, tokenHash } from '../src/main/remote/pairing';

const token = 'a'.repeat(64);
function claim(pairing: RemotePairing, name = '测试手机') {
  return pairing.claim({ invitation: pairing.invite().secret, name, tokenHash: tokenHash(token) });
}

describe('远程配对的会话授权', () => {
  it('新手机一次获得配对时选择的多个账号，修改授权立即关闭旧网页会话', () => {
    const pairing = new RemotePairing();
    const request = pairing.claim({
      invitation: pairing.invite().secret,
      name: '合成手机',
      tokenHash: tokenHash(token),
      scope: 'web:access',
    });
    expect(pairing.accountConfigIds(token)).toEqual([]);
    expect(() => pairing.decide(request.id, true, [])).toThrow('请至少选择一个要授权的账号');
    expect(pairing.poll(request.id, token)?.approved).toBe(false);
    pairing.decide(request.id, true, ['101', '202', '101']);
    expect(pairing.accountConfigIds(token)).toEqual(['101', '202']);
    let revoked = false;
    pairing.watchWeb(token, () => {
      revoked = true;
    });
    pairing.setAccountConfigIds(request.id, ['202']);
    expect(revoked).toBe(true);
    expect(pairing.accountConfigIds(token)).toEqual(['202']);
    expect(pairing.authenticate(token)).toBe(true);
  });

  it('扫码申请不授予权限，电脑确认后才允许访问，撤销立即生效', () => {
    const pairing = new RemotePairing();
    const request = claim(pairing);
    expect(request.code).toMatch(/^\d{6}$/);
    expect(pairing.authenticate(token)).toBe(false);
    expect(pairing.poll(request.id, token)?.approved).toBe(false);
    pairing.decide(request.id, true);
    expect(pairing.authenticate(token)).toBe(true);
    expect(pairing.poll(request.id, token)?.approved).toBe(true);
    pairing.revoke(request.id);
    expect(pairing.authenticate(token)).toBe(false);
    expect(pairing.poll(request.id, token)).toBeNull();
  });

  it('账号申请只绑定原设备和数据源，重复申请合并，失败不写入授权', () => {
    let now = 1000;
    const old = 'live-101';
    const target = { configId: 'backup-101', displayName: '备份', uin: '101', static: true };
    const other = 'b'.repeat(64);
    const pairing = new RemotePairing(() => now);
    let failSave = false;
    pairing.restore([], () => {
      if (failSave) throw new Error('写入失败');
    });
    const addDevice = (secret: string, name: string) => {
      const request = pairing.claim({
        invitation: pairing.invite().secret,
        name,
        tokenHash: tokenHash(secret),
        scope: 'web:access',
      });
      pairing.decide(request.id, true, [old]);
      return request.id;
    };
    const device = addDevice(token, '测试设备');
    const otherDevice = addDevice(other, '另一部设备');
    const requested = pairing.requestAccountAccess(token, target);
    if (requested.state !== 'pending') throw new Error('Expected pending request');
    expect(pairing.requestAccountAccess(token, target)).toEqual(requested);
    expect(pairing.snapshot().accountRequests).toMatchObject([
      { id: requested.id, account: target, device: { id: device, name: '测试设备' } },
    ]);
    expect(pairing.pollAccountAccess(other, requested.id)).toEqual({ state: 'expired' });
    expect(() => pairing.decideAccountAccess(requested.id, true, () => false)).toThrow(
      '数据源已经变化',
    );
    failSave = true;
    expect(() => pairing.decideAccountAccess(requested.id, true, () => true)).toThrow('写入失败');
    expect(pairing.accountConfigIds(token)).toEqual([old]);
    expect(pairing.pollAccountAccess(token, requested.id)).toEqual(requested);
    failSave = false;
    pairing.decideAccountAccess(requested.id, false, () => true);
    expect(pairing.pollAccountAccess(token, requested.id)).toEqual({ state: 'denied' });
    const next = pairing.requestAccountAccess(token, target);
    if (next.state !== 'pending') throw new Error('Expected pending request');
    now += CLAIM_TTL;
    expect(() => pairing.decideAccountAccess(next.id, true, () => true)).toThrow('申请已失效');
    const revoked = pairing.requestAccountAccess(other, target);
    if (revoked.state !== 'pending') throw new Error('Expected pending request');
    pairing.revoke(otherDevice);
    expect(() => pairing.decideAccountAccess(revoked.id, true, () => true)).toThrow('申请已失效');
    expect(pairing.accountConfigIds(token)).toEqual([old]);
    expect(pairing.accountConfigIds(other)).toEqual([]);
  });

  it('邀请只使用一次且不接受错误凭证', () => {
    const pairing = new RemotePairing();
    const invitation = pairing.invite().secret;
    const input = { invitation, name: '手机', tokenHash: tokenHash(token) };
    const request = pairing.claim(input);
    expect(() => pairing.claim(input)).toThrow();
    expect(pairing.poll(request.id, 'b'.repeat(64))).toBeNull();
    pairing.decide(request.id, false);
    expect(() => pairing.decide(request.id, true)).toThrow();
  });

  it('邀请、待批准请求均会过期，刷新会取消旧邀请和待确认请求', () => {
    let now = 1000;
    const pairing = new RemotePairing(() => now);
    const old = pairing.invite();
    now += INVITATION_TTL;
    expect(() =>
      pairing.claim({ invitation: old.secret, name: '手机', tokenHash: tokenHash(token) }),
    ).toThrow();
    const request = claim(pairing);
    now += CLAIM_TTL;
    expect(() => pairing.decide(request.id, true)).toThrow();
    const next = claim(pairing);
    pairing.invite();
    expect(() => pairing.decide(next.id, true)).toThrow();
  });

  it('管理状态不泄露密钥，关闭连接不丢失已批准凭据', () => {
    const pairing = new RemotePairing();
    const request = claim(pairing);
    pairing.decide(request.id, true);
    const snapshot = JSON.stringify(pairing.snapshot());
    expect(snapshot).not.toContain(token);
    expect(snapshot).not.toContain(tokenHash(token));
    pairing.clear();
    expect(pairing.authenticate(token)).toBe(true);
    expect(pairing.snapshot().devices).toHaveLength(1);
  });

  it('拒绝空名称、额外字段和重复设备凭据', () => {
    const pairing = new RemotePairing();
    const request = claim(pairing);
    pairing.decide(request.id, true);
    expect(() => claim(pairing)).toThrow('请生成新的设备凭据');
    const invitation = pairing.invite().secret;
    expect(() => pairing.claim({ invitation, name: ' ', tokenHash: tokenHash(token) })).toThrow();
  });
});
