/**
 * 草稿内存副本的记账规则单测。
 *
 * 盯的是一个具体的旧 bug：「用户把输入框清空 → 离开会话 → 草稿没被清掉」。
 * 根因是清空被记成了「删掉这个 key」，于是落库时分不清「清空了」和「没动过」，
 * 就把上一次落库的正文又写了回去。把这条不变式钉死在测试里。
 */

import { describe, expect, it } from 'vitest';
import { localDraftToWrite, setLocalDraft } from '../src/account/draft_edit';

describe('setLocalDraft', () => {
  it('普通输入原样记住', () => {
    expect(setLocalDraft({}, 'u_a', '你好')).toEqual({ u_a: '你好' });
  });

  it('清空后 key 仍在（值为空串），不是消失', () => {
    const after = setLocalDraft({ u_a: '你好' }, 'u_a', '');
    expect(Object.hasOwn(after, 'u_a')).toBe(true);
    expect(after.u_a).toBe('');
  });

  it('只填空白也算清空', () => {
    expect(setLocalDraft({ u_a: '你好' }, 'u_a', '   \n').u_a).toBe('');
  });

  it('保留首尾空白的原文（只在判定清空时 trim）', () => {
    expect(setLocalDraft({}, 'u_a', '  你好  ').u_a).toBe('  你好  ');
  });

  it('不修改入参', () => {
    const before = { u_a: '你好' };
    setLocalDraft(before, 'u_b', '嗨');
    expect(before).toEqual({ u_a: '你好' });
  });

  it('只影响目标会话', () => {
    expect(setLocalDraft({ u_a: '你好', u_b: '嗨' }, 'u_a', '')).toEqual({ u_a: '', u_b: '嗨' });
  });
});

describe('localDraftToWrite', () => {
  it('有正文就写正文', () => {
    expect(localDraftToWrite({ u_a: '你好' }, 'u_a')).toBe('你好');
  });

  it('空串就是「删掉草稿」的信号', () => {
    expect(localDraftToWrite({ u_a: '' }, 'u_a')).toBe('');
  });

  it('没有记录时给空串，绝不回退到别处的旧值', () => {
    expect(localDraftToWrite({}, 'u_a')).toBe('');
  });
});

describe('清空 → 落库（回归：旧 bug 会写回旧正文）', () => {
  it('打了字再删光，落库拿到的是空串而不是旧正文', () => {
    // 1. 输入「你好」，落库成功；
    const afterType = setLocalDraft({}, 'u_a', '你好');
    expect(localDraftToWrite(afterType, 'u_a')).toBe('你好');

    // 2. 用户把内容删光，离开会话 —— 要写回空串（= 让后端删草稿）。
    const afterClear = setLocalDraft(afterType, 'u_a', '');
    expect(localDraftToWrite(afterClear, 'u_a')).toBe('');

    // 3. 而旧实现是 delete 掉 key，于是第 2 步的取值会落回「已落库的旧正文」。
    const oldBuggyWay: Record<string, string> = { ...afterType };
    delete oldBuggyWay.u_a;
    const fellBackToOldText = oldBuggyWay.u_a ?? afterType.u_a ?? '';
    expect(fellBackToOldText).toBe('你好');
  });
});
