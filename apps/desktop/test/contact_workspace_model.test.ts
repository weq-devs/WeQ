import { describe, expect, it } from 'vitest';
import {
  CONTACT_WORKSPACE_SECTIONS,
  SELF_WORKSPACE_SECTIONS,
  contactHistorySection,
  contactWorkspaceSection,
} from '../src/renderer/src/lib/contactWorkspace';

describe('联系人四页结构', () => {
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
  it('本人页按资料、群内资料、展示、礼物墙排列，不含与自己的关系', () => {
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
