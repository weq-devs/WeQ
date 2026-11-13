import type { ContactWorkspaceTab } from './profileNavigation';

export const CONTACT_WORKSPACE_SECTIONS = [
  ['profile', '个人资料'],
  ['marks', '与我的关系'],
  ['group', '群内资料'],
  ['personality', '个性展示'],
] as const;
export const SELF_WORKSPACE_SECTIONS = [
  CONTACT_WORKSPACE_SECTIONS[0],
  CONTACT_WORKSPACE_SECTIONS[2],
  CONTACT_WORKSPACE_SECTIONS[3],
  ['giftwall', '礼物墙'],
] as const;
export type ContactWorkspaceSection =
  | (typeof CONTACT_WORKSPACE_SECTIONS)[number][0]
  | (typeof SELF_WORKSPACE_SECTIONS)[number][0];

/** 旧链接仍可直达内容，但不再生成独立一级页。 */
export function contactWorkspaceSection(tab: ContactWorkspaceTab): ContactWorkspaceSection {
  if (tab === 'portrait') return 'marks';
  if (tab === 'questions') return 'personality';
  if (tab === 'marks' || tab === 'group' || tab === 'personality' || tab === 'giftwall') return tab;
  return 'profile';
}

export type ContactHistorySection = Exclude<ContactWorkspaceSection, 'group' | 'giftwall'>;
export function contactHistorySection(category: string): ContactHistorySection | 'group' {
  const name = category.split('.').at(-1) ?? category;
  if (/^(listUserGroups|getMemberInfo|getMembersByUids|getMembersByUins)$/.test(name))
    return 'group';
  if (
    /^(getFriendMutualMark|commonRelationships|friendClue|getFriendRemark|getFriendNotes|friendRoster|listCategories|intimacy)$/.test(
      name,
    ) ||
    /^metric\.(addedAt|direction|commonFriends|commonGroups|source|sourceGroup)$/.test(category)
  )
    return 'marks';
  if (
    /^(getFriendDress|getSelfDress|personalityLabels|personalityPhotos|getQqShow|fetchShow|anonymousDetail|anonymousComments|anonymousQuestions)$/.test(
      name,
    )
  )
    return 'personality';
  return 'profile';
}
