import type { AccountSession } from '@weq/account';
import { cloudProfileResponse, encode } from '@weqbot/protocol';
import { expect, it, vi } from 'vitest';
import { ProfileService } from '../src/account/profile';

function fixture(local: Record<string, unknown> | null = null) {
  const getProfile = vi.fn(async () => local);
  const sendOidbPacket = vi.fn(async () =>
    Buffer.from(
      encode(cloudProfileResponse, {
        body: {
          uid: 'u_peer',
          uin: 10002,
          properties: {
            bytes: [
              { key: 20002, value: Buffer.from('在线昵称') },
              // Avatar.url@5，来源协议的独立字节，不用被测解析器生成。
              {
                key: 101,
                value: Buffer.from('2a1668747470733a2f2f716c6f676f2e636e2f612f313030', 'hex'),
              },
            ],
          },
        },
      }),
    ),
  );
  const session = { profileInfo: { getProfile } } as unknown as AccountSession;
  return {
    sendOidbPacket,
    service: new ProfileService(session, {
      nt: { sendOidbPacket, sendPacket: async () => Buffer.alloc(0) },
      resolvePid: () => 1,
    }),
  };
}

it('本人资料工具只短时复用成功结果，作废后旧在途读取不能覆盖新结果', async () => {
  const first = { uin: 10001n, nick: '旧昵称' };
  const second = { uin: 10001n, nick: '新昵称' };
  const getProfileByUin = vi.fn(async () => second).mockResolvedValueOnce(first);
  const session = {
    context: { uin: '10001' },
    profileInfo: { getProfileByUin },
  } as unknown as AccountSession;
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const service = new ProfileService(session);
  try {
    const old = service.getCachedSelfProfile();
    expect(service.getCachedSelfProfile()).toBe(old);
    service.invalidateSelfProfile();
    const latest = service.getCachedSelfProfile();
    expect(await old).toEqual(first);
    expect(await latest).toEqual(second);
    expect(service.getCachedSelfProfile()).toBe(latest);
    expect(getProfileByUin).toHaveBeenCalledTimes(2);

    now += 1_000;
    getProfileByUin.mockRejectedValueOnce(new Error('资料库暂不可读'));
    await expect(service.getCachedSelfProfile()).rejects.toThrow('暂不可读');
    expect(await service.getCachedSelfProfile()).toEqual(second);
    expect(getProfileByUin).toHaveBeenCalledTimes(4);
  } finally {
    clock.mockRestore();
  }
});

it('本地查无资料时按 UID 在线读取昵称、QQ 号及头像，不依赖仍在群内', async () => {
  const { service, sendOidbPacket } = fixture();
  expect(await service.getIdentity('u_peer', { online: true })).toMatchObject({
    uid: 'u_peer',
    uin: '10002',
    nick: '在线昵称',
    avatarUrl: 'https://qlogo.cn/a/100',
    error: null,
  });
  expect(sendOidbPacket).toHaveBeenCalledOnce();
});

it('本地群名片与备注保留，缺少头像身份时只补全缺项', async () => {
  const { service } = fixture({
    uid: 'u_peer',
    uin: 0n,
    nick: '',
    remark: '本地备注',
    avatarUrl: '',
  });
  expect(
    await service.getIdentity('u_peer', {
      online: true,
      member: { uin: 0n, card: '本地群名片', nick: '' },
    }),
  ).toMatchObject({ nick: '在线昵称', remark: '本地备注', card: '本地群名片', uin: '10002' });
});

it('已有完整本地资料不联网，离线缺资料也不发包', async () => {
  const { service, sendOidbPacket } = fixture({ uid: 'u_peer', uin: 10002n, nick: '本地昵称' });
  expect((await service.getIdentity('u_peer', { online: true })).nick).toBe('本地昵称');
  await service.getIdentity('u_missing', { online: false });
  expect(sendOidbPacket).not.toHaveBeenCalled();
});

it('在线失败保留本地已有内容，不把其他 UID 的资料展示成设置者', async () => {
  const { service, sendOidbPacket } = fixture({ remark: '本地备注' });
  sendOidbPacket.mockResolvedValueOnce(
    Buffer.from(
      encode(cloudProfileResponse, {
        body: { uid: 'u_other', uin: 10003, properties: {} },
      }),
    ),
  );
  expect(await service.getIdentity('u_peer', { online: true })).toMatchObject({
    uid: 'u_peer',
    remark: '本地备注',
    nick: '',
    uin: '',
    error: expect.stringContaining('不匹配'),
  });
});
