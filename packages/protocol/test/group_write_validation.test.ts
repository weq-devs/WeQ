import { describe, expect, it } from 'vitest';
import {
  SetGroupName,
  SetGroupMemberCard,
  SetGroupSpecialTitle,
  SetGroupEssence,
  SPECIAL_TITLE_PERMANENT,
} from '../src/index';

describe('复用群写协议的编码边界', () => {
  it('群号超过 uint32 时不截断到另一目标', () => {
    const groupId = 2 ** 32 + 123;
    for (const encode of [
      () => SetGroupName.serialize({ groupId, name: 'fixture' }),
      () => SetGroupMemberCard.serialize({ groupId, targetUid: 'u_fixture', card: 'fixture' }),
      () => SetGroupSpecialTitle.serialize({ groupId, targetUid: 'u_fixture', title: 'fixture' }),
      () => SetGroupEssence.serialize({ groupId, sequence: 1, random: 0, enable: true }),
    ])
      expect(encode).toThrow(/groupId/);
  });
  it('成员写入必须给 NT UID，不把任意非空文本当作成员', () => {
    expect(() =>
      SetGroupMemberCard.serialize({ groupId: 123, targetUid: 'not-a-uid', card: '' }),
    ).toThrow(/UID/);
    expect(() =>
      SetGroupSpecialTitle.serialize({ groupId: 123, targetUid: 'not-a-uid', title: '' }),
    ).toThrow(/UID/);
  });
  it('头衔到期值不能发生 int32 溢出，永久常量仍合法', () => {
    for (const expireTime of [2 ** 31, -(2 ** 31) - 1, 1.5, Number.NaN]) {
      expect(() =>
        SetGroupSpecialTitle.serialize({
          groupId: 123,
          targetUid: 'u_fixture',
          title: 'fixture',
          expireTime,
        }),
      ).toThrow(/expireTime/);
    }
    expect(() =>
      SetGroupSpecialTitle.serialize({
        groupId: 123,
        targetUid: 'u_fixture',
        title: '',
        expireTime: SPECIAL_TITLE_PERMANENT,
      }),
    ).not.toThrow();
  });
  it('精华消息的 sequence/random 必须可无损编码，零 random 保持合法', () => {
    for (const random of [-1, 2 ** 32, Number.NaN])
      expect(() =>
        SetGroupEssence.serialize({ groupId: 123, sequence: 1, random, enable: true }),
      ).toThrow(/random/);
    expect(() =>
      SetGroupEssence.serialize({ groupId: 123, sequence: 2 ** 32, random: 0, enable: true }),
    ).toThrow(/sequence/);
    expect(() =>
      SetGroupEssence.serialize({ groupId: 123, sequence: 1, random: 0, enable: false }),
    ).not.toThrow();
  });
});
