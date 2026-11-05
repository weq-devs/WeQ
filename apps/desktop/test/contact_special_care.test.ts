// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  decode,
  encode,
  GetFriendSnsPage,
  SNS_SPECIAL_CARE,
  type FriendSnsPage,
} from '@weq/protocol';
import { AccountWriteService } from '@weq/service';
import { readContactSpecialCare } from '../src/main/ipc/routers/contact_special_care';

function friend(uid: string, enabled: boolean | null, zone = false) {
  return {
    uid,
    uin: uid === 'u_care' ? '10002' : '10003',
    disturb: false,
    disturbPresent: false,
    specialCare: {
      enabled,
      zone,
      ring: false,
      enabledPresent: enabled !== null,
      zonePresent: true,
      ringPresent: true,
    },
  } satisfies FriendSnsPage['friends'][number];
}

function fixture(friends: FriendSnsPage['friends']) {
  return {
    accountWrite: {
      friendRoster: vi.fn(async () => ({ friends, categories: null })),
    },
    webQuery: {
      getSpecialCare: vi.fn(async () => ({
        items: [{ uin: '19999', name: '空间名单' }],
        fansCount: 3,
      })),
    },
  };
}

describe('联系人特别关心名单', () => {
  it('以好友名册整体开关为准，不使用空间名单或仅空间开关', async () => {
    const services = fixture([
      friend('u_care', true),
      friend('u_zone', false, true),
      friend('u_unknown', null, true),
    ]);
    expect(await readContactSpecialCare(services)).toEqual({
      items: [{ uid: 'u_care', uin: '10002', name: '' }],
      fansCount: 3,
    });
    expect(services.accountWrite.friendRoster).toHaveBeenCalledWith(false);
  });

  it('空间接口失败不丢失 QQ 名单，也不伪造被关心人数为零', async () => {
    const services = fixture([friend('u_care', true)]);
    services.webQuery.getSpecialCare.mockRejectedValueOnce(new Error('票据失效'));
    expect(await readContactSpecialCare(services)).toEqual({
      items: [{ uid: 'u_care', uin: '10002', name: '' }],
      fansCount: null,
    });
  });

  it('名册读取失败不能用空间名单或空名单冒充成功', async () => {
    const services = fixture([]);
    services.accountWrite.friendRoster.mockRejectedValueOnce(new Error('名册分页失败'));
    await expect(readContactSpecialCare(services)).rejects.toThrow('名册分页失败');
  });

  it('完整名册没有开启特别关心时才返回空名单', async () => {
    expect((await readContactSpecialCare(fixture([friend('u_other', false)]))).items).toEqual([]);
  });

  it('真实协议路径读取后续分页，不依赖本地好友资料缓存', async () => {
    const cookie = Uint8Array.of(7, 8);
    const pages = [
      { selfUin: 10001n, isEnd: false, cookie, friends: [{ uid: 'u_other', uin: 10003n }] },
      {
        selfUin: 10001n,
        isEnd: true,
        friends: [
          {
            uid: 'u_care',
            uin: 10002n,
            sns: [{ key: SNS_SPECIAL_CARE, value: Uint8Array.of(49) }],
          },
        ],
      },
    ];
    const send = vi.fn(async (_pid: number, _cmd: number, _sub: number, _request: Uint8Array) =>
      Buffer.from(encode(GetFriendSnsPage.respSchema, pages.shift()!)),
    );
    const services = fixture([]);
    const accountWrite = new AccountWriteService(
      { sendOidbPacket: send, sendPacket: async () => Buffer.alloc(0) },
      {
        uin: '10001',
        selfUid: 'u_self',
        getBuddy: async () => null,
        listCategories: async () => [],
      },
      () => 1,
    );
    expect((await readContactSpecialCare({ ...services, accountWrite })).items).toEqual([
      { uid: 'u_care', uin: '10002', name: '' },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(decode(GetFriendSnsPage.reqSchema, send.mock.calls[1]![3]).cookie).toEqual(
      Buffer.from(cookie),
    );
  });
});
