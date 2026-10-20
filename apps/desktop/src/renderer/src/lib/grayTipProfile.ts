import type { Conversation, Message, User } from '../im-template/template/types';
import { profileTargetUser, type ProfileTarget } from './profileNavigation';
import { selfIdentityValues } from './selfIdentity';

/** 同一人可在同条灰条里重复出现，按身份内的出现次数区分，不依赖全局数组位置。 */
export function createGrayTipPersonKey() {
  const occurrences = new Map<string, number>();
  return (identities: readonly unknown[], name: string) => {
    const base = JSON.stringify(identities.some(Boolean) ? identities : [name]);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return `${base}:${occurrence}`;
  };
}

/** 只合并节点的明确身份与精确命中的成员资料，不拿昵称或行发送者补空身份。 */
export function grayTipProfileTarget(
  identities: readonly unknown[],
  name: string,
  conversation?: Conversation,
  message?: Message,
  user?: User,
): ProfileTarget | undefined {
  const keys = identities
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(
      (identity) =>
        Boolean(profileTargetUser({ identity, name })) ||
        (identity.startsWith('self:') &&
          selfIdentityValues(user).includes(identity) &&
          Boolean(profileTargetUser({ identity: identity.slice(5), name }))),
    );
  if (!keys.length) return;
  const people = [
    ...(conversation?.type === 'group'
      ? conversation.members
      : conversation?.type === 'direct'
        ? [conversation.otherUser]
        : []),
    ...(user ? [user] : []),
    ...(message?.sender ? [message.sender] : []),
  ];
  const values = (person: User) => [
    ...selfIdentityValues(person),
    ...('uin' in person && typeof person.uin === 'string' ? [person.uin] : []),
  ];
  const matches = people.filter((person) => values(person).some((value) => keys.includes(value)));
  const users = [...keys, ...matches.flatMap(values)]
    .map((identity) => profileTargetUser({ identity, name }))
    .filter((person) => person !== null);
  const uids = new Set(users.map((person) => person.id).filter(Boolean));
  const uins = new Set(
    users.filter((person) => person.identityLabel === 'QQ').map((person) => person.identityValue),
  );
  if (uids.size > 1 || uins.size > 1) return;
  const identity = [...uids][0] || [...uins][0];
  if (!identity) return;
  const code =
    conversation?.type === 'group' ? conversation.group.identityValue || conversation.id : '';
  return {
    identity,
    uin: [...uins][0],
    name,
    avatarUrl: matches[0]?.avatarUrl,
    ...(conversation?.type === 'group' && /^[1-9]\d*$/.test(code)
      ? { group: { code, name: conversation.group.name } }
      : {}),
  };
}
