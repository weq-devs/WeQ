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
import { matchesRule, type GroupKeywordRule } from '../src/account/group_keyword';

function text(value: string): Element {
  return { kind: 'text', textContent: value } as Element;
}

function at(value: string): Element {
  return { kind: 'at', textContent: value } as Element;
}

function image(): Element {
  return { kind: 'pic' } as Element;
}

const rule = (keywords: string[], memberUids: string[] = []): GroupKeywordRule => ({
  keywords,
  memberUids,
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
    const r = rule(['报名'], ['u_a']);
    expect(matchesRule(r, { senderUid: 'u_a', elements: [text('报名')] })).toBe('报名');
    expect(matchesRule(r, { senderUid: 'u_b', elements: [text('报名')] })).toBeNull();
  });

  it('空 memberUids = 全部成员', () => {
    const r = rule(['报名'], []);
    expect(matchesRule(r, { senderUid: 'u_anyone', elements: [text('报名')] })).toBe('报名');
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
