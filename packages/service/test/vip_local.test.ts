/**
 * 本地 21000 特权清单 → 会员身份的离线单测。
 *
 * 注意只能推断超会/大会员：普通 VIP（红）在 21000 里没有对应 bizId。
 */

import { describe, expect, it } from 'vitest';
import { resolveVipBadge, vipInfoFromPrivileges, type VipInfo } from '../src/account/vip';

const opened = (bizId: number, level?: number) => ({ bizId, level, opened: true });
const closed = (bizId: number, level?: number) => ({ bizId, level, opened: false });

describe('从本地特权清单推断会员身份', () => {
  it('大会员优先，并带上它的等级', () => {
    expect(vipInfoFromPrivileges([opened(1, 4), opened(113, 8)], 1)).toEqual({
      tier: 'bvip',
      year: false,
      level: 8,
      fetchedAt: 1,
    });
  });

  it('只有超会时返回 svip', () => {
    expect(vipInfoFromPrivileges([opened(1, 5)], 1)).toMatchObject({
      tier: 'svip',
      level: 5,
    });
  });

  it('未开通（gray 项）不算会员', () => {
    expect(vipInfoFromPrivileges([closed(1, 5), closed(113, 8)], 1)).toBeNull();
  });

  it('其它特权（黄钻/音乐包/情侣）不是会员身份', () => {
    expect(
      vipInfoFromPrivileges([opened(102, 3), opened(103, 2), opened(118, 1), opened(119, 1)], 1),
    ).toBeNull();
  });

  it('空清单 / undefined → null，缺失等级按 0 处理', () => {
    expect(vipInfoFromPrivileges([], 1)).toBeNull();
    expect(vipInfoFromPrivileges(undefined, 1)).toBeNull();
    expect(vipInfoFromPrivileges([opened(1)], 1)?.level).toBe(0);
  });
});

describe('顶栏徽标的取值优先级', () => {
  const stored: VipInfo = { tier: 'bvip', year: true, level: 8, fetchedAt: 5 };

  it('有在线快照就直接用，不再看本地库', () => {
    expect(
      resolveVipBadge({ vip: stored, vipCheckedAt: 5, privileges: [opened(1, 4)], now: 9 }),
    ).toEqual(stored);
  });

  it('在线确认过不是会员时不退回本地旧资料（避免退会后徽标被顶回来）', () => {
    expect(resolveVipBadge({ vipCheckedAt: 5, privileges: [opened(1, 4)], now: 9 })).toBeNull();
  });

  it('从没查过才用本地特权清单兜底', () => {
    expect(resolveVipBadge({ privileges: [opened(1, 4)], now: 9 })).toEqual({
      tier: 'svip',
      year: false,
      level: 4,
      fetchedAt: 9,
    });
    expect(resolveVipBadge({ now: 9 })).toBeNull();
  });
});
