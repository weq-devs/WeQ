import { message } from '../../protobuf';
import { invokeOidb } from '../invoke';
import { GROUP_MESSAGE_POLICIES, type GroupMessagePolicy } from '../set-peer-preference';
import { requireUint32 } from '../write-validation';
import type { OidbNative } from '../../transport';

export interface GroupMessagePolicySnapshot {
  groupId: number;
  policy: GroupMessagePolicy | null;
  rawPolicy: number | null;
}

/** 0xFE5_2：使用标准群列表配置，仅解析个人消息策略，不缓存群资料。 */
export namespace GetGroupMessagePolicies {
  export const command = 0xfe5;
  export const subCommand = 2;
  export const reqSchema = message([
    {
      name: 'config',
      tag: 1,
      type: message([
        {
          name: 'group',
          tag: 1,
          type: message([
            { name: 'owner', tag: 1, type: 'bool' },
            { name: 'createdAt', tag: 2, type: 'bool' },
            { name: 'maxMembers', tag: 3, type: 'bool' },
            { name: 'memberCount', tag: 4, type: 'bool' },
            { name: 'name', tag: 5, type: 'bool' },
            { name: 'topTime', tag: 9, type: 'bool' },
            { name: 'muteUntil', tag: 10, type: 'bool' },
            { name: 'description', tag: 18, type: 'bool' },
            { name: 'question', tag: 19, type: 'bool' },
            { name: 'richDescription', tag: 21, type: 'bool' },
            { name: 'announcement', tag: 30, type: 'bool' },
          ]),
        },
        {
          name: 'personal',
          tag: 2,
          type: message([
            { name: 'role', tag: 2, type: 'bool' },
            { name: 'remark', tag: 3, type: 'bool' },
            { name: 'muteUntil', tag: 4, type: 'bool' },
            { name: 'policy', tag: 7, type: 'bool' },
          ]),
        },
      ]),
    },
  ]);
  export const respSchema = message([
    {
      name: 'groups',
      tag: 2,
      repeated: true,
      type: message([
        { name: 'groupId', tag: 3, type: 'uint32' },
        { name: 'personal', tag: 5, type: message([{ name: 'policy', tag: 7, type: 'uint32' }]) },
      ]),
    },
  ]);
  export type Params = Record<string, never>;
  export const serialize = (_params: Params): Record<string, unknown> => ({
    config: {
      group: {
        owner: true,
        createdAt: true,
        maxMembers: true,
        memberCount: true,
        name: true,
        topTime: true,
        muteUntil: true,
        description: true,
        question: true,
        richDescription: true,
        announcement: true,
      },
      personal: { role: true, remark: true, muteUntil: true, policy: true },
    },
  });
  export function deserialize(body: Record<string, unknown>): GroupMessagePolicySnapshot[] {
    if (!Array.isArray(body.groups)) throw new Error('服务端未返回群消息策略');
    return body.groups.map((row: Record<string, unknown>) => {
      if (typeof row.groupId !== 'number') throw new Error('群号字段缺失');
      const groupId = requireUint32(row.groupId, '群号');
      if (groupId === 0) throw new Error('群号必须为正整数');
      const personal = row.personal as Record<string, unknown> | undefined;
      const rawPolicy =
        typeof personal?.policy === 'number' ? requireUint32(personal.policy, '消息策略') : null;
      return {
        groupId,
        rawPolicy,
        policy: GROUP_MESSAGE_POLICIES.find((value) => value === rawPolicy) ?? null,
      };
    });
  }
  export const invoke = (nt: OidbNative, pid: number): Promise<GroupMessagePolicySnapshot[]> =>
    invokeOidb(nt, pid, GetGroupMessagePolicies, {});
}
