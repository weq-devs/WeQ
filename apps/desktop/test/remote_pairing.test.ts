// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CLAIM_TTL, INVITATION_TTL, RemotePairing, tokenHash } from '../src/main/remote/pairing';

const token = 'a'.repeat(64);
function claim(pairing: RemotePairing, name = '测试手机') {
  return pairing.claim({ invitation: pairing.invite().secret, name, tokenHash: tokenHash(token) });
}

describe('远程配对的会话授权', () => {
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

  it('管理状态不泄露邀请密钥或设备凭据，关闭后全部失效', () => {
    const pairing = new RemotePairing();
    const request = claim(pairing);
    pairing.decide(request.id, true);
    const snapshot = JSON.stringify(pairing.snapshot());
    expect(snapshot).not.toContain(token);
    expect(snapshot).not.toContain(tokenHash(token));
    pairing.clear();
    expect(pairing.authenticate(token)).toBe(false);
    expect(pairing.snapshot().devices).toEqual([]);
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
