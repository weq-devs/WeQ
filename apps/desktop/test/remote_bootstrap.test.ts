import { describe, expect, it } from 'vitest';
import {
  remoteInviteInput,
  remoteDirectAddresses,
  remoteConnectionMode,
} from '../src/shared/remote_bootstrap';

describe('扫码入网输入边界', () => {
  const authKey = `tskey-auth-${'k'.repeat(40)}`;
  it('填写 Key 即可生成邀请，兼容旧确认字段并拒绝非法密钥和控制面替换', () => {
    expect(remoteInviteInput.parse(undefined)).toBeUndefined();
    expect(remoteInviteInput.parse({ authKey })).toEqual({ authKey });
    expect(remoteInviteInput.parse({ authKey, singleUseConfirmed: true })).toEqual({
      authKey,
      singleUseConfirmed: true,
    });
    for (const input of [
      { authKey, singleUseConfirmed: false },
      { authKey: `${authKey}\n`, singleUseConfirmed: true },
      { authKey, singleUseConfirmed: true, control: 'https://evil.invalid' },
      { authKey: 'tskey-api-invalid', singleUseConfirmed: true },
    ]) {
      expect(remoteInviteInput.safeParse(input).success).toBe(false);
    }
  });

  it('已有 Tailscale 只提供 CGNAT 地址，局域网不混入已有网络地址', () => {
    const lan = ['https://10.0.0.2:7691', 'https://172.16.0.2:7691', 'https://192.168.1.8:7691'];
    const existing = ['https://100.64.0.1:7691', 'https://100.127.255.255:7692'];
    const invalid = [
      'https://100.63.0.1:7691',
      'https://100.128.0.1:7691',
      'https://127.0.0.1:7691',
      'http://100.64.0.1:7691',
      'https://8.8.8.8:7691',
      'https://user@100.64.0.1:7691',
      'https://100.64.0.1:7691/path',
    ];
    expect(
      remoteDirectAddresses([...lan, ...existing, ...invalid, ...existing], 'existing'),
    ).toEqual(existing);
    expect(remoteDirectAddresses([...lan, ...existing, ...invalid], 'lan')).toEqual(lan);
    expect(remoteConnectionMode.parse('existing')).toBe('existing');
  });
});
