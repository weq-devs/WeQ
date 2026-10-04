/**
 * 群关键词提醒的匹配内核 + 配置归一化的单测。
 *
 * 匹配是「收到新消息」这条链路上唯一有判断逻辑的一段，值得钉死：
 *   - 关键词空 / 规则缺失 → 不提醒；
 *   - 大小写不敏感、子串匹配，多关键词取第一个命中；
 *   - memberUids 非空时只认列表内成员，空时 = 全部成员；
 *   - 只在 text / at 元素上匹配（图片 / 表情不参与）。
 */

import { describe, expect, it } from 'vitest';
import type { Element } from '@weq/codec';
import {
  matchesRule,
  type GroupKeywordEntry,
  type GroupKeywordRule,
} from '../src/account/group_keyword';

function text(value: string): Element {
  return { kind: 'text', textContent: value } as Element;
}

function at(value: string): Element {
  return { kind: 'at', textContent: value } as Element;
}

function image(): Element {
  return { kind: 'pic' } as Element;
}

const entry = (keyword: string, memberUids: string[] = []): GroupKeywordEntry => ({
  keyword,
  memberUids,
});

const rule = (keywords: Array<string | GroupKeywordEntry>): GroupKeywordRule => ({
  keywords: keywords.map((k) => (typeof k === 'string' ? entry(k) : k)),
});

describe('matchesRule', () => {
  it('命中返回原关键词，未命中返回 null', () => {
    expect(matchesRule(rule(['紧急']), { senderUid: 'u_a', elements: [text('这事很紧急')] })).toBe(
      '紧急',
    );
    expect(matchesRule(rule(['紧急']), { senderUid: 'u_a', elements: [text('没事')] })).toBeNull();
  });

  it('规则缺失 / 关键词为空 → 不提醒', () => {
    expect(matchesRule(undefined, { senderUid: 'u_a', elements: [text('紧急')] })).toBeNull();
    expect(matchesRule(rule([]), { senderUid: 'u_a', elements: [text('紧急')] })).toBeNull();
  });

  it('大小写不敏感', () => {
    expect(matchesRule(rule(['Alert']), { senderUid: 'u_a', elements: [text('ALERT!!')] })).toBe(
      'Alert',
    );
  });

  it('多个关键词取第一个命中的', () => {
    const r = rule(['第一个', '第二个']);
    expect(matchesRule(r, { senderUid: 'u_a', elements: [text('第二个到了')] })).toBe('第二个');
    expect(matchesRule(r, { senderUid: 'u_a', elements: [text('第一个第二个')] })).toBe('第一个');
  });

  it('memberUids 非空时只认列表内成员', () => {
    const r = rule([entry('报名', ['u_a'])]);
    expect(matchesRule(r, { senderUid: 'u_a', elements: [text('报名')] })).toBe('报名');
    expect(matchesRule(r, { senderUid: 'u_b', elements: [text('报名')] })).toBeNull();
  });

  it('空 memberUids = 全部成员', () => {
    const r = rule([entry('报名', [])]);
    expect(matchesRule(r, { senderUid: 'u_anyone', elements: [text('报名')] })).toBe('报名');
  });

  it('每个关键词各自带成员范围，互不覆盖', () => {
    // 「喵喵喵1」限定 u_a，「喵喵喵2」限定 u_b —— 曾经成员范围存在群一级，
    // 设第二个词会把第一个词的范围覆盖掉，正是用户报的 bug。
    const r = rule([entry('喵喵喵1', ['u_a']), entry('喵喵喵2', ['u_b'])]);
    expect(matchesRule(r, { senderUid: 'u_a', elements: [text('喵喵喵1')] })).toBe('喵喵喵1');
    expect(matchesRule(r, { senderUid: 'u_a', elements: [text('喵喵喵2')] })).toBeNull();
    expect(matchesRule(r, { senderUid: 'u_b', elements: [text('喵喵喵2')] })).toBe('喵喵喵2');
    // 第一个词的范围没有被第二个词覆盖：u_a 仍能触发「喵喵喵1」。
    expect(matchesRule(r, { senderUid: 'u_a', elements: [text('喵喵喵1')] })).toBe('喵喵喵1');
  });

  it('范围外的词跳过，继续匹配后面的词', () => {
    const r = rule([entry('报名', ['u_a']), entry('签到', [])]);
    // u_b 不在「报名」范围里，但「签到」不限人 —— 不能被前一个词整条否决。
    expect(matchesRule(r, { senderUid: 'u_b', elements: [text('报名')] })).toBeNull();
    expect(matchesRule(r, { senderUid: 'u_b', elements: [text('签到')] })).toBe('签到');
  });

  it('只在 text / at 上匹配，图片不参与', () => {
    expect(matchesRule(rule(['报名']), { senderUid: 'u_a', elements: [image()] })).toBeNull();
    expect(matchesRule(rule(['@全体']), { senderUid: 'u_a', elements: [at('@全体')] })).toBe(
      '@全体',
    );
  });

  it('拼接多个元素后整体匹配', () => {
    const r = rule(['报名接龙']);
    expect(
      matchesRule(r, {
        senderUid: 'u_a',
        elements: [text('大家'), at('@群主'), text('报名接龙')],
      }),
    ).toBe('报名接龙');
  });
});
