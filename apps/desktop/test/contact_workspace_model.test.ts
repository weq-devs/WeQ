import { describe, expect, it } from 'vitest';
import {
  CONTACT_WORKSPACE_SECTIONS,
  SELF_WORKSPACE_SECTIONS,
  contactHistorySection,
  contactWorkspaceSection,
} from '../src/renderer/src/lib/contactWorkspace';
import { contactWorkspaceTabSchema } from '../src/renderer/src/lib/profileNavigation';

describe('联系人资料章节', () => {
  it('已撤下的勋章墙不再接受导航或出现在本人和他人目录', () => {
    expect(contactWorkspaceTabSchema.safeParse('medals').success).toBe(false);
    for (const sections of [CONTACT_WORKSPACE_SECTIONS, SELF_WORKSPACE_SECTIONS])
      expect(sections.map(([key]) => key)).not.toContain('medals');
  });
  it('目录只有内容页，不再把历史、画像、问答或编辑作为一级页', () => {
    expect(CONTACT_WORKSPACE_SECTIONS.map(([, title]) => title)).toEqual([
      '个人资料',
      '与我的关系',
      '群内资料',
      '个性展示',
    ]);
  });
  it.each([
    ['giftwall', 'giftwall'],
    ['details', 'profile'],
    ['signatures', 'profile'],
    ['history', 'profile'],
    ['edit', 'profile'],
    ['portrait', 'marks'],
    ['questions', 'personality'],
    ['group', 'group'],
  ] as const)('旧入口 %s 进入 %s', (input, expected) =>
    expect(contactWorkspaceSection(input)).toBe(expected),
  );
  it('本人保留礼物墙在最后，不含与自己的关系', () => {
    expect(SELF_WORKSPACE_SECTIONS.map(([, title]) => title)).toEqual([
      '个人资料',
      '群内资料',
      '个性展示',
      '礼物墙',
    ]);
  });
  it.each([
    ['qqWrite.commonRelationships', 'marks'],
    ['metric.commonGroups', 'marks'],
    ['metric.addedAt', 'marks'],
    ['webQuery.getFriendMutualMark', 'marks'],
    ['profileExtras.anonymousQuestions', 'personality'],
    ['dressup.getQqShow', 'personality'],
    ['groupInfo.listUserGroups', 'group'],
    ['getProfile', 'profile'],
    ['profileExtras.signatureHistory', 'profile'],
    ['metric.level', 'profile'],
  ] as const)('历史类别 %s 归入 %s', (input, expected) =>
    expect(contactHistorySection(input)).toBe(expected),
  );
});
