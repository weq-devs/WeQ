import { describe, expect, it } from 'vitest';
import { encode, SetFriendRemark, SetGroupMessagePolicy } from '@weq/protocol';
import { AccountWriteService, type AccountWriteIdentity } from '../src/account/account_write';
import { OnlineStatusService, OnlineType, ONLINE_TYPE_NAMES } from '../src/account/online_status';

function fixture() {
  const calls: Array<{ command: number; sub: number; body: Buffer }> = [];
  let live = true;
  const identity: AccountWriteIdentity = {
    uin: '10001',
    selfUid: 'u_self',
    getBuddy: async (uid) =>
      uid === 'u_friend' ? { uid, uin: 10002n, qid: '', categoryId: 0 } : null,
    listCategories: async () => [{ id: 5, name: '同学', buddyCount: 0 }],
  };
  const service = new AccountWriteService(
    {
      sendOidbPacket: async (_pid, command, sub, body) => {
        calls.push({ command, sub, body });
        if (command === SetFriendRemark.command)
          return Buffer.from(
            encode(SetFriendRemark.respSchema, {
              result: { target: { uid: 'u_friend' }, remark: '同学' },
            }),
          );
        if (command === SetGroupMessagePolicy.command)
          return Buffer.from(encode(SetGroupMessagePolicy.respSchema, { body: { groupId: 123 } }));
        return Buffer.alloc(0);
      },
      sendPacket: async () => Buffer.alloc(0),
    },
    identity,
    () => {
      if (!live) throw new Error('账号已切换');
      return 5;
    },
  );
  return {
    service,
    calls,
    identity,
    close: () => {
      live = false;
    },
  };
}

describe('账号写操作编排', () => {
  it('可编辑状态沿用读取侧的枚举，不把离线混成状态设置', () => {
    const options = OnlineStatusService.prototype.editableStatuses();
    expect(options).not.toContainEqual({
      value: OnlineType.OFFLINE,
      label: ONLINE_TYPE_NAMES[OnlineType.OFFLINE],
    });
    expect(options).toEqual(
      Object.entries(ONLINE_TYPE_NAMES)
        .filter(([value]) => Number(value) !== OnlineType.OFFLINE)
        .map(([value, label]) => ({ value: Number(value), label })),
    );
  });
  it('非好友不能修改备注、置顶、免打扰或分组', async () => {
    const f = fixture();
    await expect(f.service.friendRemark('u_stranger', '同学')).rejects.toThrow(/不是/);
    await expect(f.service.pin({ kind: 'c2c', uid: 'u_stranger' }, true)).rejects.toThrow(/不是/);
    await expect(f.service.friendDisturb('u_stranger', true)).rejects.toThrow(/不是/);
    await expect(f.service.friendCategory('u_stranger', 5)).rejects.toThrow(/不是/);
    expect(f.calls).toHaveLength(0);
  });

  it('设置和清空备注选择不同命令，保留不同确认程度', async () => {
    const f = fixture();
    expect(await f.service.friendRemark('u_friend', '同学')).toEqual({ state: 'confirmed' });
    expect(await f.service.friendRemark('u_friend', '')).toEqual({ state: 'accepted' });
    expect(f.calls.map((c) => c.command)).toEqual([0x912e, 0x912f]);
  });

  it('未知分组不发包，已在目标分组不重复操作', async () => {
    const f = fixture();
    await expect(f.service.friendCategory('u_friend', 9)).rejects.toThrow(/不存在/);
    expect(await f.service.friendCategory('u_friend', 0)).toEqual({ state: 'unchanged' });
    expect(f.calls).toHaveLength(0);
    await f.service.friendCategory('u_friend', 5);
    expect(f.calls).toHaveLength(1);
  });

  it('等待名册期间切号，发包前重新核对绑定', async () => {
    const f = fixture();
    const get = f.identity.getBuddy;
    f.identity.getBuddy = async (uid) => {
      const result = await get(uid);
      f.close();
      return result;
    };
    await expect(f.service.friendRemark('u_friend', '同学')).rejects.toThrow(/切换/);
    expect(f.calls).toHaveLength(0);
  });

  it('群策略使用账号自己的 UID，好友免打扰不伪造确认', async () => {
    const f = fixture();
    await f.service.groupMessagePolicy(123, 4);
    expect(f.calls[0]?.body.includes(Buffer.from('u_self'))).toBe(true);
    expect(await f.service.friendDisturb('u_friend', true)).toEqual({ state: 'unconfirmed' });
  });
});
