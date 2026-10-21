import { randomInt } from 'node:crypto';
import { message } from '../../protobuf';
import { invokeOidb } from '../invoke';
import { requireUint32 } from '../write-validation';
import type { OidbNative } from '../../transport';

/** 来源：Lagrange.Core 20c2ba0 的 D88DGroupInfo 与 FetchStrangerGroupInfoService。 */
const INFO = message([
  { name: 'option', tag: 7, type: 'uint32', force: true },
  { name: 'name', tag: 15, type: 'string', force: true },
  { name: 'question', tag: 24, type: 'string', force: true },
]);
export interface GroupJoinInfo {
  groupId: number;
  name: string;
  option: number | null;
  question: string | null;
  questionState: 'available' | 'not-required' | 'unavailable';
}
export namespace GetGroupJoinInfo {
  export const command = 0x88d;
  export const subCommand = 110;
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
    { name: 'error', tag: 2, type: 'string' },
  ]);
  export const serialize = ({ groupId }: { groupId: number }): Record<string, unknown> => {
    const groupCode = requireUint32(groupId, 'groupId');
    if (groupCode === 0) throw new Error('群号必须为正整数');
    return {
      appId: randomInt(1, 0x7fffffff),
      groups: [{ groupCode, info: { option: 0, name: '', question: '' } }],
    };
  };
  export function deserialize(body: Record<string, unknown>): GroupJoinInfo[] {
    if (!Array.isArray(body.groups) || body.groups.length === 0)
      throw new Error('服务端未返回群资料');
    return body.groups.map((row: Record<string, unknown>) => {
      if (row.result !== undefined && row.result !== 0) throw new Error('服务端拒绝读取群资料');
      const info = row.info as Record<string, unknown> | undefined;
      if (!info) throw new Error('服务端未返回群资料');
      const groupId = Number(row.groupCode);
      requireUint32(groupId, 'groupId');
      if (groupId === 0) throw new Error('群号必须为正整数');
      const option = typeof info.option === 'number' ? info.option : null;
      const question =
        typeof info.question === 'string' && info.question.trim() ? info.question : null;
      return {
        groupId,
        name: typeof info.name === 'string' ? info.name : '',
        option,
        question,
        questionState: question
          ? 'available'
          : option === 1 || option === 2
            ? 'not-required'
            : 'unavailable',
      };
    });
  }
  export async function invoke(
    nt: OidbNative,
    pid: number,
    params: { groupId: number },
  ): Promise<GroupJoinInfo> {
    if (params.groupId <= 0) throw new Error('群号必须为正整数');
    const rows = await invokeOidb(nt, pid, GetGroupJoinInfo, params);
    const match = rows.find((row) => row.groupId === params.groupId);
    if (!match) throw new Error('返回群号与查询目标不一致');
    return match;
  }
}
