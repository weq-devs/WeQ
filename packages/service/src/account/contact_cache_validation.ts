import type { GroupProfileExtras } from '@weq/protocol';
import type { GroupRosterMember } from './group_member_roster';

const numberOrNull = (value: unknown) =>
  value === null ||
  (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff);

/** 迁移与原缓存读取复用相同契约，不把无法回读的文件标成迁移成功。 */
export function validGroupProfile(value: unknown): value is GroupProfileExtras {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (
    row.joinedAt !== undefined &&
    row.joinedAt !== null &&
    (!numberOrNull(row.joinedAt) || Number(row.joinedAt) <= 1)
  )
    return false;
  if (
    !['grade', 'activeMemberCount', 'freezeState', 'freezeReason', 'portraitSequence'].every(
      (key) => numberOrNull(row[key]),
    )
  )
    return false;
  if (row.portrait === null) return true;
  if (!row.portrait || typeof row.portrait !== 'object') return false;
  const portrait = row.portrait as Record<string, unknown>;
  return (
    numberOrNull(portrait.count) &&
    numberOrNull(portrait.defaultId) &&
    Array.isArray(portrait.pictures) &&
    portrait.pictures.length <= 1000 &&
    portrait.pictures.every(
      (picture: unknown) =>
        picture &&
        typeof picture === 'object' &&
        ['id', 'left', 'top', 'right', 'bottom'].every((key) =>
          numberOrNull(Reflect.get(picture, key)),
        ),
    )
  );
}

export function validGroupRosterMember(value: unknown): value is GroupRosterMember {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'uid' in value &&
      typeof value.uid === 'string' &&
      value.uid &&
      'uin' in value &&
      typeof value.uin === 'string' &&
      /^\d+$/.test(value.uin) &&
      'nick' in value &&
      typeof value.nick === 'string' &&
      'card' in value &&
      typeof value.card === 'string' &&
      'memberLevel' in value &&
      typeof value.memberLevel === 'number' &&
      Number.isFinite(value.memberLevel),
  );
}
