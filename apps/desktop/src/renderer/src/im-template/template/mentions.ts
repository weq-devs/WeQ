// @ts-nocheck
import type { Conversation, GroupMember, User } from './types';
import { displayUserName } from './user';
import { mentionName } from '../../lib/mentionIdentity';

export function mentionLabel(user: Pick<User, 'displayName' | 'username'>) {
  return displayUserName(user).trim();
}

export function mentionText(user: Pick<User, 'id' | 'identityValue'> & { nick?: string }) {
  return user.id === 'all'
    ? '@全体成员'
    : `@${mentionName({ uid: user.id, uin: user.identityValue, nick: user.nick })}`;
}

export function filterMentionMembers(
  conversation: Conversation | undefined,
  query: string,
  currentUserId: string,
) {
  if (conversation?.type !== 'group') {
    return [];
  }

  const normalizedQuery = normalizeMentionQuery(query);
  const self = conversation.members.find(
    (member) => member.id === currentUserId || member.identityValue === currentUserId,
  );
  const everyone: GroupMember = {
    id: 'all',
    identityLabel: '',
    identityValue: '',
    username: '全体成员',
    displayName: '全体成员',
    avatarUrl: null,
    role: 'member',
    joinedAt: '',
  };
  const candidates = [
    ...(self && (self.role === 'owner' || self.role === 'admin') ? [everyone] : []),
    ...conversation.members.filter(
      (member) => member.id !== currentUserId && member.identityValue !== currentUserId,
    ),
  ];
  if (!normalizedQuery) {
    return candidates;
  }

  return candidates
    .map((member, index) => ({
      member,
      index,
      rank: mentionMatchRank(member, normalizedQuery),
    }))
    .filter((item) => item.rank < Number.POSITIVE_INFINITY)
    .sort((first, second) => first.rank - second.rank || first.index - second.index)
    .map((item) => item.member);
}

export function messageMentionsUser(body: string | null | undefined, user?: User) {
  if (!body || !user) {
    return false;
  }

  const aliases = [user.displayName, user.username, user.identityValue]
    .map((value) => value.trim())
    .filter((value, index, values) => value && values.indexOf(value) === index);

  return aliases.some((alias) => {
    const pattern = new RegExp(
      `(^|[\\s，。,.!?！？:：;；])@${escapeRegExp(alias)}(?=$|[\\s，。,.!?！？:：;；])`,
      'i',
    );
    return pattern.test(body);
  });
}

function mentionSearchText(member: GroupMember) {
  return normalizeMentionQuery(
    [displayUserName(member), member.username, member.identityValue, member.identityLabel].join(
      ' ',
    ),
  );
}

function mentionMatchRank(member: GroupMember, query: string) {
  const preferredFields = [displayUserName(member), member.username, member.identityValue].map(
    normalizeMentionQuery,
  );

  if (preferredFields.some((field) => field.startsWith(query))) {
    return 0;
  }

  return mentionSearchText(member).includes(query) ? 1 : Number.POSITIVE_INFINITY;
}

function normalizeMentionQuery(value: string) {
  return value.trim().toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
