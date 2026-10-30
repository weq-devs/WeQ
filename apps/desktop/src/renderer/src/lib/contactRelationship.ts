import { createContext, useContext } from 'react';

export type PersonRelationship = 'self' | 'friend' | 'nonfriend' | 'unknown';
export type GroupRelationship = 'member' | 'nonmember' | 'unknown';
export type Relationship = PersonRelationship | GroupRelationship;

export interface RelationshipDirectory {
  selfUid?: string;
  selfUin?: string;
  friends: ReadonlyMap<string, { categoryName?: string | null }>;
  friendsComplete: boolean;
  groups: ReadonlyMap<string, { listed: boolean; role?: string | null }>;
}

export const RelationshipDirectoryContext = createContext<RelationshipDirectory | null>(null);

export interface PersonIdentity {
  id?: string;
  uid?: string;
  identityValue?: string;
  isFriend?: boolean;
  friendshipKnown?: boolean;
}

export function personRelationship(
  person: PersonIdentity,
  directory: RelationshipDirectory | null = null,
): PersonRelationship {
  const uid = person.uid || person.id;
  if (
    person.id?.startsWith('self:') ||
    (directory?.selfUid && uid === directory.selfUid) ||
    (directory?.selfUin && person.identityValue === directory.selfUin)
  )
    return 'self';
  if (directory?.friends.has(uid ?? '') || directory?.friends.has(person.identityValue ?? ''))
    return 'friend';
  if (directory?.friendsComplete) return 'nonfriend';
  if (person.friendshipKnown === false) return 'unknown';
  return person.isFriend === true ? 'friend' : person.isFriend === false ? 'nonfriend' : 'unknown';
}

export interface GroupIdentity {
  id?: string;
  identityValue?: string;
  listed?: boolean;
  membershipKnown?: boolean;
  role?: string;
  roleKnown?: boolean;
}

export function groupRelationship(
  group: GroupIdentity,
  directory: RelationshipDirectory | null = null,
): GroupRelationship {
  const current = directory?.groups.get(group.identityValue || group.id || '');
  if (current) return current.listed ? 'member' : 'nonmember';
  if (group.listed === true && group.membershipKnown !== false) return 'member';
  if (group.membershipKnown !== true) return 'unknown';
  return group.listed === true ? 'member' : group.listed === false ? 'nonmember' : 'unknown';
}

export const relationshipLabels: Record<Relationship, string> = {
  self: '我自己',
  friend: '我的好友',
  nonfriend: '非好友',
  member: '我在群内',
  nonmember: '我不在群内',
  unknown: '关系待确认',
};

export function usePersonRelationship(person: PersonIdentity) {
  return personRelationship(person, useContext(RelationshipDirectoryContext));
}

export function useGroupRelationship(group: GroupIdentity) {
  return groupRelationship(group, useContext(RelationshipDirectoryContext));
}
