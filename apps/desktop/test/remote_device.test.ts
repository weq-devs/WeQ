// @vitest-environment node
import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { observeRemoteRequest } from '../src/main/remote/device';
import { RemotePairing, tokenHash } from '../src/main/remote/pairing';

const deviceInfo = {
  platform: 'ios',
  model: 'iPhone17,1',
  osVersion: '26.1',
  appVersion: '1.0.0b3',
  appBuild: '11',
} as const;
const header = Buffer.from(JSON.stringify(deviceInfo)).toString('base64');
const observation = { deviceInfo, lastConnection: { ip: '192.168.1.3', route: 'lan' } } as const;
const token = 'e'.repeat(64);
function request(peer: string, headers = {}): IncomingMessage {
  return { socket: { remoteAddress: peer }, headers } as IncomingMessage;
}

describe('Remote 设备资料和连接观测', () => {
  it('读取资料，回环网络助手追加的末项为实际来源，不采用客户端伪造的前项', () => {
    expect(
      observeRemoteRequest(
        request('::ffff:127.0.0.1', {
          'x-weq-device': header,
          'x-forwarded-for': '8.8.8.8, 192.168.1.3',
        }),
      ),
    ).toEqual(observation);
    expect(
      observeRemoteRequest(request('192.168.1.4', { 'x-forwarded-for': '100.64.0.2' }))
        .lastConnection,
    ).toEqual({ ip: '192.168.1.4', route: 'lan' });
  });

  it.each([
    ['100.64.0.2', 'tailscale'],
    ['100.127.255.255', 'tailscale'],
    ['100.128.0.1', 'unknown'],
    ['fd7a:115c:a1e0::2', 'tailscale'],
    ['10.0.1.2', 'lan'],
    ['172.31.0.1', 'lan'],
    ['172.32.0.1', 'unknown'],
  ])('来源 %s 的连接方式为 %s', (ip, route) => {
    expect(
      observeRemoteRequest(request('127.0.0.1', { 'x-forwarded-for': ip })).lastConnection,
    ).toEqual({ ip, route });
  });

  it('旧客户端、损坏、超长、无效字段均不虚构资料，也不抛出鉴权错误', () => {
    for (const value of [
      undefined,
      'not-json',
      '!invalid',
      'a'.repeat(2049),
      Buffer.from(JSON.stringify({ ...deviceInfo, model: '' })).toString('base64'),
    ]) {
      expect(
        observeRemoteRequest(
          request('127.0.0.1', { 'x-weq-device': value, 'x-forwarded-for': 'invalid' }),
        ),
      ).toEqual({ deviceInfo: undefined });
    }
  });

  it('未授权不能更新资料；授权后自动补齐，旧客户端的访问不会清空已有资料，关闭时保存', () => {
    const pairing = new RemotePairing(() => 12345);
    const save = vi.fn();
    pairing.restore([], save);
    const claim = pairing.claim({
      invitation: pairing.invite().secret,
      name: '合成手机',
      tokenHash: tokenHash(token),
      scope: 'web:access',
    });
    expect(pairing.authenticate(token, observation)).toBe(false);
    pairing.decide(claim.id, true);
    expect(pairing.snapshot().devices[0]?.lastSeenAt).toBeNull();
    expect(pairing.canAccessWeb('a'.repeat(64), observation)).toBe(false);
    expect(pairing.canAccessWeb(token, observation)).toBe(true);
    pairing.authenticate(token, {});
    expect(pairing.snapshot().devices[0]).toMatchObject({ ...observation, lastSeenAt: 12345 });
    expect(save).toHaveBeenCalledTimes(1);
    pairing.clear();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.lastCall?.[0][0]).toMatchObject({ ...observation, lastSeenAt: 12345 });
  });

  it('高频访问合并落盘，写入失败仍可访问并在下一周期重试', () => {
    vi.useFakeTimers();
    const pairing = new RemotePairing();
    const save = vi.fn();
    pairing.restore([], save);
    const claim = pairing.claim(
      { invitation: pairing.invite().secret, name: '手机', tokenHash: tokenHash(token) },
      observation,
    );
    pairing.decide(claim.id, true);
    try {
      save.mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      for (let i = 0; i < 100; i++) expect(pairing.authenticate(token, observation)).toBe(true);
      expect(save).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(30_000);
      expect(save).toHaveBeenCalledTimes(2);
      expect(pairing.authenticate(token, observation)).toBe(true);
      vi.advanceTimersByTime(30_000);
      expect(save).toHaveBeenCalledTimes(3);
    } finally {
      pairing.clear();
      vi.useRealTimers();
    }
  });
});
