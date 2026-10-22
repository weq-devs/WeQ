import { describe, expect, it } from 'vitest';
import {
  encode,
  decode,
  CreateFriendCategory,
  UpdateFriendCategories,
  DeleteFriendCategory,
  MoveFriendCategory,
  GetFriendSnsPage,
} from '../src/index';

describe('现代好友分组协议', () => {
  it('默认分组零值合法，但缺失分组身份不能补成默认组，负值仍拒绝', () => {
    const page = GetFriendSnsPage.deserialize({
      selfUin: 10001n,
      friends: [{ uid: 'u_friend', uin: 10002n }],
    });
    expect(page.friends[0]).not.toHaveProperty('categoryId');
    expect(
      GetFriendSnsPage.deserialize({
        selfUin: 10001n,
        friends: [],
        categories: [{ name: '未知分组' }],
      }).categories,
    ).toEqual([{ id: null, name: '未知分组', buddyCount: null, sortOrder: null }]);
    expect(() => MoveFriendCategory.serialize({ uid: 'u_friend', categoryId: -1 })).toThrow();
    expect(() =>
      UpdateFriendCategories.serialize({ categories: [{ id: 0, name: 'A', sort: -1 }] }),
    ).toThrow();
  });
  it('非默认分组改名显式保留现有排序，不假定省略排序能保留旧值', () => {
    expect(
      Buffer.from(
        encode(
          UpdateFriendCategories.reqSchema,
          UpdateFriendCategories.serialize({ categories: [{ id: 5, name: 'A', sort: 3 }] }),
        ),
      ).toString('hex'),
    ).toBe('0a0708051201411803');
  });
  it('单好友回默认组显式编码 0，普通形式、不签名', () => {
    expect(MoveFriendCategory.command).toBe(0x10eb);
    expect(MoveFriendCategory.subCommand).toBe(1);
    expect(MoveFriendCategory.needSign).toBe(false);
    expect(
      Buffer.from(
        encode(
          MoveFriendCategory.reqSchema,
          MoveFriendCategory.serialize({ uid: 'u_a', categoryId: 0 }),
        ),
      ).toString('hex'),
    ).toBe('0a03755f611000');
  });
  it('新建与排序 0 不混淆，排序显式保留现有名称', () => {
    expect(
      decode(
        CreateFriendCategory.reqSchema,
        encode(CreateFriendCategory.reqSchema, CreateFriendCategory.serialize({ name: 'A' })),
      ),
    ).toEqual({ name: 'A' });
    expect(
      Buffer.from(
        encode(
          UpdateFriendCategories.reqSchema,
          UpdateFriendCategories.serialize({ categories: [{ id: 5, name: 'A', sort: 0 }] }),
        ),
      ).toString('hex'),
    ).toBe('0a0708051201411800');
  });
  it('已有空名称可以原样保留，但禁止只传名称或排序的部分更新', () => {
    expect(
      Buffer.from(
        encode(
          UpdateFriendCategories.reqSchema,
          UpdateFriendCategories.serialize({ categories: [{ id: 5, name: '', sort: 0 }] }),
        ),
      ).toString('hex'),
    ).toBe('0a06080512001800');
    expect(() => UpdateFriendCategories.serialize({ categories: [{ id: 5, name: 'A' }] })).toThrow(
      '同时包含',
    );
    expect(() => UpdateFriendCategories.serialize({ categories: [{ id: 5, sort: 0 }] })).toThrow(
      '同时包含',
    );
  });
  it('拒绝删除默认组、非法名称与重复更新', () => {
    expect(() => DeleteFriendCategory.serialize({ categoryId: 0 })).toThrow();
    expect(() => CreateFriendCategory.serialize({ name: ' A' })).toThrow();
    expect(() =>
      UpdateFriendCategories.serialize({ categories: [{ id: 1 }, { id: 1 }] }),
    ).toThrow();
  });
  it('从根 tag102 读取目录，好友 tag2 读取实际归属', () => {
    const bytes = Buffer.from(
      'aa060f0a08755f667269656e64100018924eb20609080012014118002003',
      'hex',
    );
    expect(GetFriendSnsPage.deserialize(decode(GetFriendSnsPage.respSchema, bytes))).toMatchObject({
      friends: [{ uid: 'u_friend', categoryId: 0 }],
      categories: [{ id: 0, name: 'A', buddyCount: 0, sortOrder: 3 }],
    });
  });
});
