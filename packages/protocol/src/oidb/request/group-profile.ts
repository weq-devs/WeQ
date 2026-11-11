import { message } from '../../protobuf';
import { responseObject } from '../write-validation';

export interface GroupPortraitInfo {
  id: number | null;
  left: number | null;
  top: number | null;
  right: number | null;
  bottom: number | null;
}
export interface GroupProfileExtras {
  grade: number | null;
  activeMemberCount: number | null;
  freezeState: number | null;
  freezeReason: number | null;
  portraitSequence: number | null;
  portrait: {
    count: number | null;
    defaultId: number | null;
    pictures: GroupPortraitInfo[];
  } | null;
}

const portraitInfo = message([
  { name: 'id', tag: 1, type: 'uint32' },
  { name: 'left', tag: 2, type: 'uint32' },
  { name: 'top', tag: 3, type: 'uint32' },
  { name: 'right', tag: 4, type: 'uint32' },
  { name: 'bottom', tag: 5, type: 'uint32' },
]);

/** Android GroupInfo FieldMap；0x88d_110 真回包已验证这些字段。 */
export const GROUP_PROFILE_FIELDS = message([
  { name: 'grade', tag: 36, type: 'uint32', force: true },
  { name: 'activeMemberCount', tag: 37, type: 'uint32', force: true },
  { name: 'portraitSequence', tag: 43, type: 'uint32', force: true },
  {
    name: 'portrait',
    tag: 44,
    type: message([
      { name: 'count', tag: 1, type: 'uint32' },
      { name: 'pictures', tag: 2, type: portraitInfo, repeated: true },
      { name: 'defaultId', tag: 3, type: 'uint32' },
    ]),
  },
  { name: 'freezeState', tag: 91, type: 'uint32', force: true },
  { name: 'freezeReason', tag: 100, type: 'uint32', force: true },
]);

function optionalNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new Error('群扩展资料数字字段无效');
  return value;
}

export function parseGroupProfileExtras(row: Record<string, unknown>): GroupProfileExtras {
  let portrait: GroupProfileExtras['portrait'] = null;
  if (row.portrait !== undefined) {
    const raw = responseObject(row.portrait, '群头像资料');
    if (raw.pictures !== undefined && !Array.isArray(raw.pictures))
      throw new Error('群头像列表无效');
    const pictures = ((raw.pictures ?? []) as unknown[]).map((value) => {
      const picture = responseObject(value, '群头像');
      return {
        id: optionalNumber(picture, 'id'),
        left: optionalNumber(picture, 'left'),
        top: optionalNumber(picture, 'top'),
        right: optionalNumber(picture, 'right'),
        bottom: optionalNumber(picture, 'bottom'),
      };
    });
    portrait = {
      count: optionalNumber(raw, 'count'),
      defaultId: optionalNumber(raw, 'defaultId'),
      pictures,
    };
  }
  return {
    grade: optionalNumber(row, 'grade'),
    activeMemberCount: optionalNumber(row, 'activeMemberCount'),
    freezeState: optionalNumber(row, 'freezeState'),
    freezeReason: optionalNumber(row, 'freezeReason'),
    portraitSequence: optionalNumber(row, 'portraitSequence'),
    portrait,
  };
}
