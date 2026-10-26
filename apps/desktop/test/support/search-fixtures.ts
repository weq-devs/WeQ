import type { ContactSearchHit } from '../../src/renderer/src/components/search/types';

export function contactSearchHit(overrides: Partial<ContactSearchHit> = {}): ContactSearchHit {
  return {
    category: 'contact',
    uid: 'u_fixture',
    uin: '',
    nick: '合成好友',
    remark: '',
    avatarUrl: null,
    isFriend: true,
    hasConversation: false,
    temporary: false,
    aliases: [],
    groups: [],
    ...overrides,
  };
}
