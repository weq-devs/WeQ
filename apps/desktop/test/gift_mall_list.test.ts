import { describe, expect, it } from 'vitest';
import { uniqueGiftItems } from '../src/renderer/src/components/gift/GiftMallPanel';

describe('礼物商城列表', () => {
  it('按礼物 ID 去掉同一响应中的重复项，保留首次出现的顺序', () => {
    const first = { giftId: 1, giftName: '马上暴富' };
    const second = { giftId: 2, giftName: '真的爱你' };

    expect(uniqueGiftItems([first, first, second, { ...first, giftName: '重复记录' }])).toEqual([
      first,
      second,
    ]);
  });

  it('不同礼物 ID 即使名称相同也都保留', () => {
    expect(
      uniqueGiftItems([
        { giftId: 1, giftName: '马上暴富' },
        { giftId: 2, giftName: '马上暴富' },
      ]),
    ).toHaveLength(2);
  });
});
