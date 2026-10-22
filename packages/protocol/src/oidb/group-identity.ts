import { message } from '../protobuf';
import { invokeOidb } from './invoke';
import { requireUin, requireUint32, responseObject } from './write-validation';
import type { OidbNative } from '../transport';

export interface GroupIdentityTitle {
  id: string;
  name: string;
  selected: boolean | null;
  settableId: number | null;
  specValue: number | null;
  popText: string;
}
export interface GroupIdentitySnapshot {
  groupId: number;
  memberUin: string;
  level: { value: number | null; name: string; progress: number | null } | null;
  titles: GroupIdentityTitle[];
  selectedTitleId: string | null;
  selectionKnown: boolean;
}

function writableTitleId(id: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(id)) return null;
  const value = Number(id);
  return Number.isSafeInteger(value) && value <= 0xffffffff ? value : null;
}

/** 官方 getIdentityList：UIN-form，选中标记不从头衔文本推断。 */
export namespace GetGroupIdentity {
  export const command = 0x9436;
  export const subCommand = 0;
  export const uinForm = true;
  export const reqSchema = message([
    { name: 'groupId', tag: 1, type: 'uint64', force: true },
    { name: 'memberUin', tag: 2, type: 'uint64', force: true },
  ]);
  export const respSchema = message([
    { name: 'userInfo', tag: 1, type: message([{ name: 'uin', tag: 1, type: 'uint64' }]) },
    {
      name: 'level',
      tag: 2,
      type: message([
        { name: 'curLevel', tag: 1, type: 'uint32' },
        { name: 'name', tag: 2, type: 'string' },
        { name: 'progress', tag: 3, type: 'uint32' },
      ]),
    },
    {
      name: 'titles',
      tag: 3,
      repeated: true,
      type: message([
        { name: 'titleId', tag: 1, type: 'string' },
        { name: 'name', tag: 2, type: 'string' },
        { name: 'isSet', tag: 3, type: 'bool' },
        { name: 'specValue', tag: 4, type: 'int32' },
        { name: 'popText', tag: 5, type: 'string' },
      ]),
    },
  ]);
  export function serialize(p: { groupId: number; memberUin: string }): Record<string, unknown> {
    return {
      groupId: BigInt(requireUint32(p.groupId, '群号')),
      memberUin: requireUin(p.memberUin),
    };
  }
  export function deserialize(
    body: Record<string, unknown>,
  ): Omit<GroupIdentitySnapshot, 'groupId'> {
    const user = responseObject(body.userInfo, '头衔成员');
    const memberUin = requireUin(String(user.uin)).toString();
    const seen = new Set<string>();
    const titles = ((body.titles ?? []) as unknown[]).map((raw): GroupIdentityTitle => {
      const title = responseObject(raw, '头衔');
      if (typeof title.titleId !== 'string' || !title.titleId || seen.has(title.titleId))
        throw new Error('头衔标识缺失或重复');
      seen.add(title.titleId);
      return {
        id: title.titleId,
        name: typeof title.name === 'string' ? title.name : '',
        selected: typeof title.isSet === 'boolean' ? title.isSet : null,
        settableId: writableTitleId(title.titleId),
        specValue: typeof title.specValue === 'number' ? title.specValue : null,
        popText: typeof title.popText === 'string' ? title.popText : '',
      };
    });
    const selected = titles.filter((title) => title.selected === true);
    const level = body.level === undefined ? null : responseObject(body.level, '群等级');
    return {
      memberUin,
      level: level
        ? {
            value: typeof level.curLevel === 'number' ? level.curLevel : null,
            name: typeof level.name === 'string' ? level.name : '',
            progress: typeof level.progress === 'number' ? level.progress : null,
          }
        : null,
      titles,
      selectedTitleId: selected.length === 1 ? selected[0]!.id : null,
      selectionKnown:
        selected.length === 1 ||
        (titles.length > 0 && titles.every((title) => title.selected === false)),
    };
  }
  export async function invoke(
    nt: OidbNative,
    pid: number,
    p: { groupId: number; memberUin: string },
  ): Promise<GroupIdentitySnapshot> {
    const result = await invokeOidb(nt, pid, GetGroupIdentity, p);
    if (result.memberUin !== p.memberUin) throw new Error('头衔响应成员与读取目标不一致');
    return { ...result, groupId: p.groupId };
  }
}

/** 官方 setIdentityTitleInfo，仅修改当前登录者在指定群的展示选择。 */
export namespace SetGroupIdentity {
  export const command = 0x9437;
  export const subCommand = 0;
  export const uinForm = true;
  export const reqSchema = message([
    { name: 'groupId', tag: 1, type: 'uint64', force: true },
    { name: 'titleId', tag: 2, type: 'uint32', force: true },
  ]);
  export const respSchema = message([]);
  export function serialize(p: { groupId: number; titleId: number }): Record<string, unknown> {
    return {
      groupId: BigInt(requireUint32(p.groupId, '群号')),
      titleId: requireUint32(p.titleId, '头衔标识', true),
    };
  }
  export const deserialize = (_body: Record<string, unknown>): void => {};
  export const invoke = (
    nt: OidbNative,
    pid: number,
    p: { groupId: number; titleId: number },
  ): Promise<void> => invokeOidb(nt, pid, SetGroupIdentity, p);
}
