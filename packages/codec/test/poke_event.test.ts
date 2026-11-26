/**
 * 戳一戳灰条的参与者身份只由 @weq/codec 解析。
 *
 * 全部使用虚构 UID/群号，不接触真实聊天记录和数据库。
 * 有正文时按语义确定方向；缺少正文时保留旧年报的回退口径。
 */
import { describe, expect, it } from 'vitest';
import { parsePokeDirection, parsePokeParties } from '../src/index';
import type { GrayTipPokeElement } from '../src/element';

type Poke = Partial<
  Pick<
    GrayTipPokeElement,
    'actionInitiator' | 'actionTarget' | 'actionAttributes' | 'grayTipXmlContent' | 'tipJson'
  >
>;

function parse(poke: Poke = {}) {
  return parsePokeParties(poke);
}

describe('parsePokeParties — WeQ codec 统一入口', () => {
  it('未知身份时仅返回六个空串，不猜测消息发送者', () => {
    expect(parse()).toEqual({
      initiatorUid: '',
      initiatorUin: '',
      initiatorName: '',
      targetUid: '',
      targetUin: '',
      targetName: '',
    });
  });

  it('actionInitiator/actionTarget 直接携带 uid+昵称', () => {
    expect(
      parse({
        actionInitiator: { uid: ' u_initiator ', nickname: ' 甲 ' },
        actionTarget: { uid: ' u_target ', nickname: ' 乙 ' },
      }),
    ).toEqual({
      initiatorUid: 'u_initiator',
      initiatorUin: '',
      initiatorName: '甲',
      targetUid: 'u_target',
      targetUin: '',
      targetName: '乙',
    });
  });

  it('action 对象优先于 XML 和 tipJson 的 UID、昵称', () => {
    const parties = parse({
      actionInitiator: { uid: 'u_explicit_initiator', nickname: '发起者' },
      actionTarget: { uid: 'u_explicit_target', nickname: '目标' },
      grayTipXmlContent: '<gtip><qq uin="u_xml_target"/><qq uin="u_xml_initiator"/></gtip>',
      tipJson:
        '{"items":[{"type":"qq","uid":"u_json_target","nm":"JSON目标"},{"type":"qq","uid":"u_json_initiator","nm":"JSON发起"}]}',
    });
    expect(parties.initiatorUid).toBe('u_explicit_initiator');
    expect(parties.targetUid).toBe('u_explicit_target');
    expect(parties.initiatorName).toBe('发起者');
    expect(parties.targetName).toBe('目标');
  });

  it('身份冲突时不把其他参与者的昵称和 QQ 号拼到 action UID 上', () => {
    const result = parse({
      actionTarget: { uid: 'u_actual' },
      grayTipXmlContent: '<gtip><qq uin="u_other" nm="其他人" jp="123"/></gtip>',
      actionAttributes: [{ key: 'nick_str1', value: '其他人' }],
    });
    expect(result).toMatchObject({ targetUid: 'u_actual', targetUin: '', targetName: '' });
  });

  it('nick_str1/2 与 uin_str1/2 按 target/initiator 的出场顺序归位', () => {
    expect(
      parse({
        actionAttributes: [
          { key: 'nick_str1', value: '  目标人 ' },
          { key: 'nick_str2', value: ' 发起人 ' },
          { key: 'uin_str1', value: '123450001' },
          { key: 'uin_str2', value: '123450002' },
        ],
      }),
    ).toEqual({
      initiatorUid: '',
      initiatorUin: '123450002',
      initiatorName: '发起人',
      targetUid: '',
      targetUin: '123450001',
      targetName: '目标人',
    });
  });

  it('同一个 key 后项覆盖前项，保持旧 Map 行为', () => {
    const p = parse({
      actionAttributes: [
        { key: 'nick_str1', value: '旧名称' },
        { key: ' nick_str1 ', value: '新名称' },
        { key: 'uin_str1', value: '00017' },
      ],
    });
    expect(p.targetName).toBe('新名称');
    expect(p.targetUin).toBe('00017');
  });

  it('uin_strN 只接受纯十进制字符串', () => {
    for (const bad of ['u_abc', '12 3', '-2', '+1', '1.5', '0x10', '12\n34', '']) {
      expect(parse({ actionAttributes: [{ key: 'uin_str1', value: bad }] }).targetUin).toBe('');
    }
    expect(parse({ actionAttributes: [{ key: 'uin_str2', value: '0' }] }).initiatorUin).toBe('0');
  });

  it('正文确定方向时纠正实机 actionInitiator 指向被戳者的情况', () => {
    const poke = {
      actionInitiator: { uid: 'u_target', nickname: '被戳者' },
      grayTipXmlContent:
        '<gtip><qq uid="u_actor" jp="123" nm="发起者"/><nor txt="拍了拍"/><qq uin="u_target"/></gtip>',
      actionAttributes: [{ key: 'uin_str2', value: '456' }],
    };
    expect(parsePokeDirection(poke)).toEqual(['u_actor', 'u_target']);
    expect(parse(poke)).toEqual({
      initiatorUid: 'u_actor',
      initiatorUin: '123',
      initiatorName: '发起者',
      targetUid: 'u_target',
      targetUin: '456',
      targetName: '被戳者',
    });
  });

  it('JSON 正文中的动作方向与已有 UIN、param 和名称均保留', () => {
    const poke = {
      tipJson: JSON.stringify({
        items: [
          { type: 'url', txt: '普通链接' },
          { type: 'qq', param: ['u_actor'], uin: '123', nm: '发起者' },
          { type: 'nor', txt: '戳了戳' },
          { type: 'qq', uid: 'u_target', uin: '456', nm: '目标' },
        ],
      }),
    };
    expect(parsePokeDirection(poke)).toEqual(['u_actor', 'u_target']);
    expect(parse(poke)).toMatchObject({
      initiatorUid: 'u_actor',
      initiatorUin: '123',
      initiatorName: '发起者',
      targetUid: 'u_target',
      targetUin: '456',
      targetName: '目标',
    });
  });

  it('同一参与者的 XML 身份与 JSON 名称和 QQ 号互相补全', () => {
    const poke = {
      grayTipXmlContent: '<gtip><qq uin="u_actor"/><nor txt="拍了拍"/><qq uin="u_target"/></gtip>',
      tipJson: JSON.stringify({
        items: [
          { type: 'qq', uid: 'u_actor', uin: '123', nm: '发起人' },
          { type: 'nor', txt: '拍了拍' },
          { type: 'qq', uid: 'u_target', uin: '456', nm: '目标' },
        ],
      }),
    };
    expect(parse(poke)).toMatchObject({
      initiatorUid: 'u_actor',
      initiatorUin: '123',
      initiatorName: '发起人',
      targetUid: 'u_target',
      targetUin: '456',
      targetName: '目标',
    });
  });

  it('昵称中的动作文字不改变缺少正文的旧版回退方向', () => {
    expect(
      parse({
        grayTipXmlContent: '<gtip><qq uin="u_target" nm="拍了拍"/><qq uin="u_actor"/></gtip>',
      }),
    ).toMatchObject({ initiatorUid: 'u_actor', targetUid: 'u_target' });
  });

  it('XML 第一名是 target，第二名是 initiator（可含单/双引号）', () => {
    const p = parse({
      grayTipXmlContent:
        "<gtip><qq uin='u_target' nm='T'/><nor>戳了</nor><qq uin=\"u_actor\"/></gtip>",
    });
    expect(p.targetUid).toBe('u_target');
    expect(p.initiatorUid).toBe('u_actor');
  });

  it('XML 解析可匹配大写 QQ 标签且 trim 标识', () => {
    const p = parse({
      grayTipXmlContent: '<gtip><QQ class="person" UIN=" u_target "/><QQ uin=" u_actor "/></gtip>',
    });
    expect(p.targetUid).toBe('u_target');
    expect(p.initiatorUid).toBe('u_actor');
  });

  it('XML 仅一人时不编造另一人的 UID', () => {
    const p = parse({ grayTipXmlContent: '<gtip><qq uin="u_only"/></gtip>' });
    expect(p.targetUid).toBe('u_only');
    expect(p.initiatorUid).toBe('');
  });

  it('空 XML uin 和不相关标签被跳过', () => {
    const p = parse({
      grayTipXmlContent:
        '<gtip><qq uin=""/><other uin="u_other"/><qq uin="u_real_target"/><qq uin="u_actor"/></gtip>',
    });
    expect(p.targetUid).toBe('u_real_target');
    expect(p.initiatorUid).toBe('u_actor');
  });

  it('tipJson items 允许 qq 和 url 条目作为 fallback', () => {
    const p = parse({
      tipJson: JSON.stringify({
        items: [
          { type: 'plain', uid: 'ignore', nm: '忽略' },
          { type: 'qq', uid: 'u_json_target', nm: 'T' },
          { type: 'url', uid: 'u_json_actor', nm: 'A' },
        ],
      }),
    });
    expect(p.targetUid).toBe('u_json_target');
    expect(p.targetName).toBe('T');
    expect(p.initiatorUid).toBe('u_json_actor');
    expect(p.initiatorName).toBe('A');
  });

  it('XML 优先于 tipJson 的 UID，action 昵称优先于 attrs 和 JSON', () => {
    const p = parse({
      grayTipXmlContent: '<gtip><qq uin="u_xml_target"/><qq uin="u_xml_actor"/></gtip>',
      tipJson: JSON.stringify({
        items: [
          { type: 'qq', uid: 'u_json_target', nm: 'JSON目标' },
          { type: 'qq', uid: 'u_json_actor', nm: 'JSON发起' },
        ],
      }),
      actionTarget: { nickname: '直接目标昵称' },
      actionAttributes: [{ key: 'nick_str2', value: '属性发起昵称' }],
    });
    expect(p.targetUid).toBe('u_xml_target');
    expect(p.initiatorUid).toBe('u_xml_actor');
    expect(p.targetName).toBe('直接目标昵称');
    expect(p.initiatorName).toBe('属性发起昵称');
  });

  it('空 action UID 回退到已有 XML 身份', () => {
    const p = parse({
      actionTarget: { uid: '   ' },
      grayTipXmlContent: '<gtip><qq uin="u_xml_target"/></gtip>',
    });
    expect(p.targetUid).toBe('u_xml_target');
  });

  it('无字段和仅无关 actionAttributes 时返回空身份', () => {
    expect(
      parse({
        actionAttributes: [
          { key: 'other', value: 'value' },
          { key: '', value: '' },
        ],
      }),
    ).toEqual(parse({}));
  });

  it.each(['', '{garbage', 'null', '"string"', '{}', '{"items":{}}', '{"items":[null,17]}'])(
    '错误或异形 tipJson 安全返回空: %s',
    (tipJson) => {
      expect(parse({ tipJson })).toEqual(parse({}));
    },
  );

  it('tipJson 允许只有一名参与者，另一名未知', () => {
    const p = parse({ tipJson: '{"items":[{"type":"qq","uid":"u_target","nm":"T"}]}' });
    expect(p.targetUid).toBe('u_target');
    expect(p.initiatorUid).toBe('');
    expect(p.initiatorName).toBe('');
  });

  it('缺失身份字段时保留有证据的 UIN/昵称，无推测 UID', () => {
    const p = parse({
      actionAttributes: [
        { key: 'uin_str1', value: '123' },
        { key: 'nick_str2', value: '发起者' },
      ],
    });
    expect(p.targetUid).toBe('');
    expect(p.targetUin).toBe('123');
    expect(p.initiatorUid).toBe('');
    expect(p.initiatorName).toBe('发起者');
  });

  it('返回字段保持稳定，调用不会修改输入对象', () => {
    const p: Poke = {
      actionInitiator: { uid: 'u_actor', nickname: 'Actor' },
      actionAttributes: [{ key: 'uin_str1', value: '42' }],
    };
    const before = JSON.stringify(p);
    expect(parse(p)).toEqual(parse(p));
    expect(JSON.stringify(p)).toBe(before);
    expect(Object.keys(parse(p)).sort()).toEqual(
      [
        'initiatorUid',
        'initiatorUin',
        'initiatorName',
        'targetUid',
        'targetUin',
        'targetName',
      ].sort(),
    );
  });

  it('损坏的运行时 payload 不应让解析器抛错', () => {
    for (const broken of [
      null,
      undefined,
      123,
      { actionAttributes: false },
      { actionAttributes: [null, false, { key: 20, value: null }] },
      { actionInitiator: { uid: 34, nickname: {} }, actionTarget: false },
      { grayTipXmlContent: 100, tipJson: [] },
      { tipJson: '{"items":[{},null,{"type":"qq","uid":123,"nm":false}]}' },
    ]) {
      expect(() => parsePokeParties(broken as Poke)).not.toThrow();
    }
  });
});
