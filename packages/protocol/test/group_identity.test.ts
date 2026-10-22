import { describe, expect, it } from 'vitest';
import { decode, encode, GetGroupIdentity, SetGroupIdentity } from '../src/index';

describe('群展示头衔协议', () => {
  it('读取请求为群号＋成员UIN，设置请求为群号＋数值ID，两个均使用UIN-form', () => {
    expect(
      Buffer.from(
        encode(
          GetGroupIdentity.reqSchema,
          GetGroupIdentity.serialize({ groupId: 123, memberUin: '10001' }),
        ),
      ),
    ).toEqual(Buffer.from('087b10914e', 'hex'));
    expect(
      Buffer.from(
        encode(
          SetGroupIdentity.reqSchema,
          SetGroupIdentity.serialize({ groupId: 123, titleId: 0 }),
        ),
      ),
    ).toEqual(Buffer.from('087b1000', 'hex'));
    expect(GetGroupIdentity.uinForm).toBe(true);
    expect(SetGroupIdentity.uinForm).toBe(true);
    expect(GetGroupIdentity.command).not.toBe(SetGroupIdentity.command);
  });
  it('独立手写wire样本保留选中标记与独立数字等级', () => {
    const bytes = Buffer.from('0a0308914e1206081b12024c561a0b0a013712044e414d451801', 'hex');
    expect(GetGroupIdentity.deserialize(decode(GetGroupIdentity.respSchema, bytes))).toEqual({
      memberUin: '10001',
      level: { value: 27, name: 'LV', progress: null },
      titles: [
        { id: '7', name: 'NAME', selected: true, settableId: 7, specValue: null, popText: '' },
      ],
      selectedTitleId: '7',
      selectionKnown: true,
    });
  });
  it('0级、明确不选和缺省标记互不混淆，不按专属文本非空决定选中', () => {
    const result = GetGroupIdentity.deserialize({
      userInfo: { uin: 10001n },
      level: { curLevel: 0, name: '等级段' },
      titles: [{ titleId: '1', name: '已有专属文本' }],
    });
    expect(result.level?.value).toBe(0);
    expect(result.selectedTitleId).toBeNull();
    expect(result.selectionKnown).toBe(false);
    const none = GetGroupIdentity.deserialize({
      userInfo: { uin: 10001n },
      titles: [{ titleId: '1', isSet: false }],
    });
    expect(none.selectionKnown).toBe(true);
    expect(none.selectedTitleId).toBeNull();
  });
  it('多条选中不随意取第一条，不丢失原始目录', () => {
    const result = GetGroupIdentity.deserialize({
      userInfo: { uin: 10001n },
      titles: [
        { titleId: '1', isSet: true },
        { titleId: '2', isSet: true },
      ],
    });
    expect(result.selectedTitleId).toBeNull();
    expect(result.selectionKnown).toBe(false);
    expect(result.titles).toHaveLength(2);
  });
  it.each(['none', '01', '-1', '4294967296', '9007199254740993'])(
    '不能将响应ID %s 截断或强转为设置编号',
    (id) => {
      const result = GetGroupIdentity.deserialize({
        userInfo: { uin: 10001n },
        titles: [{ titleId: id, name: '原名', isSet: true }],
      });
      expect(result.selectedTitleId).toBe(id);
      expect(result.titles[0]?.settableId).toBeNull();
    },
  );
  it.each([
    {},
    { userInfo: {} },
    { userInfo: { uin: 10001n }, titles: [{ titleId: '1' }, { titleId: '1' }] },
  ])('空回应、缺成员及重复ID拒绝 %#', (body) => {
    expect(() => GetGroupIdentity.deserialize(body)).toThrow();
  });
  it.each([-1, 1.5, 0x100000000, Number.NaN])('设置编号 %s 不进行数值截断', (titleId) => {
    expect(() => SetGroupIdentity.serialize({ groupId: 123, titleId })).toThrow();
  });
});
