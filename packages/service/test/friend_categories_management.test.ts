import { describe, expect, it, vi } from 'vitest';
import {
  decode,
  encode,
  GetFriendSnsPage,
  MoveFriendCategory,
  UpdateFriendCategories,
  DeleteFriendCategory,
  CreateFriendCategory,
} from '@weq/protocol';
import { AccountWriteService } from '../src/account/account_write';

function fixture() {
  let categories = [
    { id: 0, name: '默认', buddyCount: 0, sortOrder: 0 },
    { id: 5, name: '朋友', buddyCount: 1, sortOrder: 1 },
  ];
  const friends = [{ uid: 'u_friend', uin: 10002n, categoryId: 5 }];
  let rejectMove = false;
  const commands: number[] = [];
  const send = vi.fn(async (_pid: number, command: number, _sub: number, body: Buffer) => {
    commands.push(command);
    if (command === GetFriendSnsPage.command)
      return Buffer.from(
        encode(GetFriendSnsPage.respSchema, { selfUin: 10001n, friends, categories }),
      );
    if (command === MoveFriendCategory.command) {
      const request = decode(MoveFriendCategory.reqSchema, body);
      if (!rejectMove) friends[0]!.categoryId = Number(request.categoryId);
    }
    if (command === DeleteFriendCategory.command) {
      const request = decode(DeleteFriendCategory.reqSchema, body);
      categories = categories.filter((row) => row.id !== request.categoryId);
    }
    if (command === UpdateFriendCategories.command) {
      const request = decode(UpdateFriendCategories.reqSchema, body);
      for (const change of request.categories as Array<{
        id: number;
        name?: string;
        sort?: number;
      }>) {
        const row = categories.find((row) => row.id === change.id)!;
        if (change.name !== undefined) row.name = change.name;
        if (change.sort !== undefined) row.sortOrder = change.sort;
      }
    }
    if (command === CreateFriendCategory.command) {
      const request = decode(CreateFriendCategory.reqSchema, body);
      const row = { id: 6, name: String(request.name), buddyCount: 0, sortOrder: 2 };
      categories.push(row);
      return Buffer.from(
        encode(CreateFriendCategory.respSchema, {
          category: { id: row.id, name: row.name, sort: 2 },
        }),
      );
    }
    return Buffer.alloc(0);
  });
  const service = new AccountWriteService(
    { sendOidbPacket: send, sendPacket: async () => Buffer.alloc(0) },
    {
      uin: '10001',
      selfUid: 'u_self',
      getBuddy: async (uid) =>
        uid === 'u_friend' ? { uid, uin: 10002n, qid: '', categoryId: 5 } : null,
      listCategories: async () => [],
    },
    () => 1,
  );
  return {
    service,
    commands,
    rejectMove: () => {
      rejectMove = true;
    },
  };
}
describe('好友分组服务编排', () => {
  it('完整名册中的默认组缺省字段保留存在性，只在同账号目录能唯一关联时恢复操作身份', async () => {
    const sendOidbPacket = async () =>
      Buffer.from(
        encode(GetFriendSnsPage.respSchema, {
          selfUin: 10001n,
          isEnd: true,
          friends: [{ uid: 'u_friend', uin: 10002n }],
          categories: [{ name: '默认', buddyCount: 1, sortOrder: 0 }],
        }),
      );
    const identity = {
      uin: '10001',
      selfUid: 'u_self',
      getBuddy: async () => null,
      listCategories: async () => [{ id: 0, name: '默认', buddyCount: 1, sortOrder: 0 }],
    };
    const service = new AccountWriteService(
      { sendOidbPacket, sendPacket: async () => Buffer.alloc(0) },
      identity,
      () => 1,
    );
    expect(await service.friendRoster()).toMatchObject({
      categories: [{ id: 0, idPresent: false }],
      friends: [{ categoryId: 0, categoryIdPresent: false }],
    });
    identity.listCategories = async () => [
      { id: 0, name: '默认', buddyCount: 1, sortOrder: 7 },
    ];
    expect(await service.friendRoster()).toMatchObject({
      categories: [{ id: 0, idPresent: false, sortOrder: 0 }],
    });
    identity.listCategories = async () => [
      { id: 0, name: '另一个分组名', buddyCount: 1, sortOrder: 0 },
    ];
    await expect(service.friendRoster()).rejects.toThrow('可确认');
  });
  it('非空删除先明确移组并读回，再删除与读回目录', async () => {
    const f = fixture();
    expect(await f.service.manageFriendCategories({ type: 'delete', id: 5, mergeInto: 0 })).toEqual(
      { state: 'confirmed' },
    );
    expect(f.commands).toEqual([0xfd4, 0x10eb, 0xfd4, 0xfd4, 0x1125, 0xfd4]);
  });
  it('移组未读回时停止，绝不删除仍有成员的分组', async () => {
    const f = fixture();
    f.rejectMove();
    await expect(
      f.service.manageFriendCategories({ type: 'delete', id: 5, mergeInto: 0 }),
    ).rejects.toThrow('停止');
    expect(f.commands).not.toContain(DeleteFriendCategory.command);
  });
  it('未选择合并目标或删除默认分组时不写', async () => {
    const f = fixture();
    await expect(f.service.manageFriendCategories({ type: 'delete', id: 5 })).rejects.toThrow(
      '目标',
    );
    await expect(f.service.manageFriendCategories({ type: 'delete', id: 0 })).rejects.toThrow(
      '默认',
    );
    expect(f.commands.every((cmd) => cmd === GetFriendSnsPage.command)).toBe(true);
  });
  it('重命名保留排序，排序必须覆盖现有完整目录，特殊分组字符串不能成为协议目标', async () => {
    const f = fixture();
    expect(await f.service.manageFriendCategories({ type: 'rename', id: 5, name: '同学' })).toEqual(
      { state: 'confirmed' },
    );
    await expect(f.service.manageFriendCategories({ type: 'sort', ids: [5] })).rejects.toThrow(
      '目录已变化',
    );
    expect(await f.service.manageFriendCategories({ type: 'sort', ids: [5, 0] })).toEqual({
      state: 'confirmed',
    });
  });
  it('新建分组依据新目录 ID 和名称读回确认', async () => {
    const f = fixture();
    expect(await f.service.manageFriendCategories({ type: 'create', name: '同事' })).toEqual({
      state: 'confirmed',
    });
  });
});
