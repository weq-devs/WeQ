import type { AccountSession } from '@weq/account';
import { decode, SetProfile, SetSelfLongNick } from '@weq/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ProfileService, type ProfileOnlineDeps } from '../src/account/profile';

function fixture() {
  const session = { context: { uin: '10001' } } as unknown as AccountSession;
  const sendOidbPacket = vi.fn<ProfileOnlineDeps['nt']['sendOidbPacket']>(async () =>
    Buffer.alloc(0),
  );
  const nt = { sendOidbPacket, sendPacket: vi.fn(async () => Buffer.alloc(0)) };
  return { service: new ProfileService(session, { nt, resolvePid: () => 7 }), sendOidbPacket };
}

describe('资料服务签名参数', () => {
  it.each(['合成签名', ''])('signature=%s 完整传到协议层', async (signature) => {
    const { service, sendOidbPacket } = fixture();
    await service.setProfile({ nickname: '合成昵称', ...{ signature } });
    expect(sendOidbPacket).toHaveBeenCalledOnce();
    const call = sendOidbPacket.mock.calls[0]!;
    expect(call[0]).toBe(7);
    expect(decode(SetProfile.reqSchema, call[3])).toMatchObject({
      uin: 10001n,
      stringProfiles: [{ value: '合成昵称' }, { value: signature }],
    });
  });

  it('旧 personalNote 必须报错，不能被 service 丢弃后误改其他字段', async () => {
    const { service, sendOidbPacket } = fixture();
    await expect(
      service.setProfile({ nickname: '合成昵称', ...{ personalNote: '说明文本' } }),
    ).rejects.toThrow(/personalNote/);
    expect(sendOidbPacket).not.toHaveBeenCalled();
  });

  it.each(['合成签名', ''])('单独修改 signature=%s 不被当作空补丁', async (signature) => {
    const { service, sendOidbPacket } = fixture();
    await service.setProfile({ signature, ...{ selfUin: '20002' } });
    expect(sendOidbPacket).toHaveBeenCalledOnce();
    expect(decode(SetProfile.reqSchema, sendOidbPacket.mock.calls[0]![3])).toMatchObject({
      uin: 10001n,
      stringProfiles: [{ value: signature }],
    });
  });

  it('独立签名清空保持空值，不更换当前账号身份', async () => {
    const { service, sendOidbPacket } = fixture();
    await service.setLongNick('');
    expect(decode(SetSelfLongNick.reqSchema, sendOidbPacket.mock.calls[0]![3])).toMatchObject({
      uin: 10001n,
      profile: { value: '' },
    });
  });
});
