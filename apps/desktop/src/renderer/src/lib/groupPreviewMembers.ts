import type { GroupMember } from '../im-template/template/types';

/** 本人占位使用 self:UIN，真实成员使用 UID；合并时识别两种身份并保留群资料。 */
export function mergeGroupPreviewMembers(members: readonly GroupMember[]): GroupMember[] {
  const result: GroupMember[] = [];
  const indices = new Map<string, number>();
  for (const member of members) {
    const keys = [member.id, member.uid]
      .filter((value): value is string => Boolean(value))
      .map((value) => `uid:${value}`);
    for (const value of [member.uin, member.identityValue]) {
      if (value && /^[1-9]\d*$/.test(value)) keys.push(`uin:${value}`);
    }
    const index = keys.map((key) => indices.get(key)).find((value) => value !== undefined);
    const target = index ?? result.length;
    const previous = result[target];
    if (!previous || !member.id.startsWith('self:') || previous.id.startsWith('self:')) {
      result[target] = member;
    }
    for (const key of keys) indices.set(key, target);
  }
  return result;
}
