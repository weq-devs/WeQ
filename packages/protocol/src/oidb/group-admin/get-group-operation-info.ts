import { randomInt } from 'node:crypto';
import { message } from '../../protobuf';
import { invokeOidb } from '../invoke';
import { requireUint32 } from '../write-validation';
import type { OidbNative } from '../../transport';

/** Android 9.3.85 的 0x88d GroupInfo / 0xef0 GroupInfoExt FieldMap。 */
const EXT = message([{ name: 'essencePrivilege', tag: 14, type: 'uint32', force: true }]);
const INFO = message([
  { name: 'muteAllUntil', tag: 45, type: 'uint64', force: true },
  { name: 'muteUntil', tag: 46, type: 'uint32', force: true },
  { name: 'privilegeFlag', tag: 56, type: 'uint32', force: true },
  { name: 'isConf', tag: 79, type: 'uint32', force: true },
  { name: 'allowMemberKick', tag: 86, type: 'uint32', force: true },
  { name: 'memberRenameSwitch', tag: 88, type: 'uint32', force: true },
  { name: 'extension', tag: 109, type: EXT },
]);

export interface GroupOperationInfo {
  muteAll: boolean | null;
  muteUntil: number | null;
  memberCanUpload: boolean | null;
  memberCanRename: boolean | null;
  allowMemberKick: boolean | null;
  memberCanEssence: boolean | null;
}

function optional(row: Record<string, unknown>, key: string): number | null {
  if (row[key] === undefined) return null;
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('群权限数字字段无效');
  return value;
}

function muteAllEnabled(value: unknown): boolean | null {
  if (value === undefined) return null;
  if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isSafeInteger(value)))
    throw new Error('群禁言时间字段无效');
  if (value < 0 || value > 0xffffffffffffffffn) throw new Error('群禁言时间字段无效');
  return value > 0;
}

export namespace GetGroupOperationInfo {
  export const command = 0x88d;
  // 110 是入群资料查询，成功回包也可能不返回全员禁言等操作字段。
  export const subCommand = 0;
  export const reqSchema = message([
    { name: 'appId', tag: 1, type: 'uint32' },
    {
      name: 'groups',
      tag: 2,
      repeated: true,
      type: message([
        { name: 'groupCode', tag: 1, type: 'uint64' },
        { name: 'info', tag: 2, type: INFO },
      ]),
    },
  ]);
  export const respSchema = message([
    {
      name: 'groups',
      tag: 1,
      repeated: true,
      type: message([
        { name: 'groupCode', tag: 1, type: 'uint64' },
        { name: 'result', tag: 2, type: 'uint32' },
        { name: 'info', tag: 3, type: INFO },
      ]),
    },
  ]);
  export const serialize = (p: { groupId: number }) => {
    if (p.groupId === 0) throw new Error('groupId 必须为正整数');
    return {
      appId: randomInt(1, 0x7fffffff),
      groups: [
        {
          groupCode: requireUint32(p.groupId, 'groupId'),
          info: {
            muteAllUntil: 0n,
            muteUntil: 0,
            privilegeFlag: 0,
            isConf: 0,
            allowMemberKick: 0,
            memberRenameSwitch: 0,
            extension: { essencePrivilege: 0 },
          },
        },
      ],
    };
  };
  export function deserialize(
    body: Record<string, unknown>,
  ): Array<GroupOperationInfo & { groupId: string }> {
    if (!Array.isArray(body.groups)) throw new Error('群权限响应缺少群资料');
    return body.groups.map((value: Record<string, unknown>) => {
      if (value.result !== undefined && value.result !== 0) throw new Error('服务端拒绝读取群权限');
      if (!value.info || typeof value.info !== 'object') throw new Error('群权限响应缺少字段');
      const info = value.info as Record<string, unknown>;
      const privilege = optional(info, 'privilegeFlag');
      const rename = optional(info, 'memberRenameSwitch');
      const conf = optional(info, 'isConf');
      const kick = optional(info, 'allowMemberKick');
      const ext =
        info.extension && typeof info.extension === 'object'
          ? (info.extension as Record<string, unknown>)
          : {};
      const essence = optional(ext, 'essencePrivilege');
      return {
        groupId: String(value.groupCode),
        muteAll: muteAllEnabled(info.muteAllUntil),
        muteUntil: optional(info, 'muteUntil'),
        memberCanUpload: privilege === null ? null : (privilege & 2) === 0,
        memberCanRename:
          rename === 2 ? true : rename === 1 ? false : conf === null ? null : conf === 1,
        allowMemberKick: kick === null ? null : kick === 1,
        memberCanEssence: essence === null ? null : essence === 2,
      };
    });
  }
  export async function invoke(
    nt: OidbNative,
    pid: number,
    params: { groupId: number },
  ): Promise<GroupOperationInfo> {
    const rows = await invokeOidb(nt, pid, GetGroupOperationInfo, params);
    const row = rows.find((value) => value.groupId === String(params.groupId));
    if (!row) throw new Error('群权限响应与目标群不一致');
    return row;
  }
}
