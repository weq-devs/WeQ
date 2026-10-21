import { describe, expect, it } from 'vitest';
import { atAllMentionState, nextMentionIndex } from '../src/renderer/src/lib/atAllMention';
import { filterMentionMembers } from '../src/renderer/src/im-template/template/mentions';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

describe('@全体成员候选', () => {
  it('自己尚未出现在分页成员列表时仍有全体候选，按全体成员搜索能命中', () => {
    const demo = createTemplateDemoData();
    const source = demo.conversations.find((item) => item.type === 'group')!;
    const conversation = { ...source, members: [] };
    expect(filterMentionMembers(conversation, '', demo.user.id).map((item) => item.id)).toEqual([
      'all',
    ]);
    expect(filterMentionMembers(conversation, '全体', demo.user.id).map((item) => item.id)).toEqual(
      ['all'],
    );
    expect(filterMentionMembers(conversation, '不存在', demo.user.id)).toEqual([]);
  });
  const quota = { canAtAll: true, remainCountForUin: 2, remainCountForGroup: 4 };
  it('管理员和群主匹配远端可用状态以及个人／群双额度', () => {
    for (const role of ['owner', 'admin']) {
      expect(
        atAllMentionState({ online: true, data: { role, canManage: true, quota } }),
      ).toMatchObject({ selectable: true, summary: '个人 2 · 群 4' });
    }
    for (const changed of [
      { canAtAll: false },
      { remainCountForUin: 0 },
      { remainCountForGroup: 0 },
      { remainCountForGroup: -1 },
    ]) {
      expect(
        atAllMentionState({
          online: true,
          data: { role: 'admin', canManage: true, quota: { ...quota, ...changed } },
        }).selectable,
      ).toBe(false);
    }
  });
  it('普通成员、未知权限、加载、错误及离线均不可选，不伪造额度为零', () => {
    for (const input of [
      { online: false },
      { online: true, loading: true },
      { online: true, error: true },
      { online: true, data: { role: 'member', canManage: false, quota: null } },
      { online: true, data: { role: null, canManage: false, quota: null } },
    ]) {
      const state = atAllMentionState(input);
      expect(state.selectable).toBe(false);
      expect(state.summary).not.toContain('个人 0');
    }
  });
  it('键盘导航跳过不可选的全体项，并保持环绕；仅有禁用项时不选中', () => {
    const members = [{ id: 'all' }, { id: 'one' }, { id: 'two' }];
    expect(nextMentionIndex(members, -1, 1, false)).toBe(1);
    expect(nextMentionIndex(members, -1, -1, false)).toBe(2);
    expect(nextMentionIndex(members, 1, -1, false)).toBe(2);
    expect(nextMentionIndex(members, 2, 1, true)).toBe(0);
    expect(nextMentionIndex([{ id: 'all' }], -1, 1, false)).toBe(-1);
  });
});
