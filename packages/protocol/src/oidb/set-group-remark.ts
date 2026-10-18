import { message } from '../protobuf';
import { invokeOidb } from './invoke';
import { requireUint32, responseObject } from './write-validation';
import type { OidbNative } from '../transport';

export interface SetGroupRemarkParams {
  groupId: number;
  remark: string;
}

export namespace SetGroupRemark {
  export const command = 0xf16;
  export const subCommand = 1;
  export const needSign = false;
  export const reqSchema = message([
    {
      name: 'body',
      tag: 1,
      type: message([
        { name: 'groupId', tag: 1, type: 'uint64' },
        { name: 'remark', tag: 3, type: 'string', force: true },
      ]),
    },
  ]);
  export const respSchema = message([
    {
      name: 'body',
      tag: 1,
      type: message([
        { name: 'groupId', tag: 1, type: 'uint64' },
        { name: 'groupUin', tag: 2, type: 'uint64' },
        { name: 'code', tag: 3, type: 'int32' },
      ]),
    },
  ]);
  export const serialize = (p: SetGroupRemarkParams): Record<string, unknown> => ({
    body: { groupId: BigInt(requireUint32(p.groupId, 'groupId')), remark: p.remark },
  });
  export function deserialize(body: Record<string, unknown>): bigint | null {
    if (body.body === undefined) return null;
    const result = responseObject(body.body, '群备注');
    if (result.code !== undefined && result.code !== 0)
      throw new Error(`群备注设置失败：${String(result.code)}`);
    if (typeof result.groupId !== 'bigint') throw new Error('群备注响应缺少群号');
    return result.groupId;
  }
  export async function invoke(
    nt: OidbNative,
    pid: number,
    p: SetGroupRemarkParams,
  ): Promise<void> {
    const target = await invokeOidb(nt, pid, SetGroupRemark, p);
    if (target !== null && target !== BigInt(p.groupId)) throw new Error('群备注响应目标不匹配');
  }
}
