import { message } from '../protobuf';
import { invokeOidb } from './invoke';
import { requireUid, responseObject } from './write-validation';
import type { OidbNative } from '../transport';

const TARGET = message([
  { name: 'uin', tag: 3, type: 'uint64' },
  { name: 'uid', tag: 7, type: 'string' },
]);
const CHANGE = message([
  { name: 'target', tag: 1, type: TARGET },
  { name: 'remark', tag: 2, type: 'string' },
]);

export interface SetFriendRemarkParams {
  uid: string;
  remark: string;
}

export namespace SetFriendRemark {
  export const command = 0x912e;
  export const subCommand = 0;
  export const needSign = false;
  export const reqSchema = message([
    { name: 'change', tag: 1, type: CHANGE },
    { name: 'scene', tag: 2, type: 'uint32', force: true },
  ]);
  export const respSchema = message([
    { name: 'result', tag: 1, type: CHANGE },
    {
      name: 'error',
      tag: 3,
      type: message([
        { name: 'code', tag: 2, type: 'int32' },
        { name: 'message', tag: 3, type: 'string' },
      ]),
    },
  ]);
  export function serialize(p: SetFriendRemarkParams): Record<string, unknown> {
    if (!p.remark) throw new Error('清除好友备注请使用独立清除命令');
    return { change: { target: { uid: requireUid(p.uid) }, remark: p.remark }, scene: 0 };
  }
  export function deserialize(body: Record<string, unknown>): SetFriendRemarkParams {
    if (body.error !== undefined) {
      const error = responseObject(body.error, '好友备注错误');
      throw new Error(
        `好友备注设置失败：${String(error.code ?? '未知')} ${String(error.message ?? '')}`,
      );
    }
    const result = responseObject(body.result, '好友备注');
    const target = responseObject(result.target, '好友备注目标');
    if (typeof result.remark !== 'string') throw new Error('好友备注响应缺少确认值');
    return { uid: requireUid(String(target.uid ?? '')), remark: result.remark };
  }
  export async function invoke(
    nt: OidbNative,
    pid: number,
    p: SetFriendRemarkParams,
  ): Promise<void> {
    const result = await invokeOidb(nt, pid, SetFriendRemark, p);
    if (result.uid !== p.uid || result.remark !== p.remark)
      throw new Error('好友备注响应目标或值不匹配');
  }
}

export namespace ClearFriendRemark {
  export const command = 0x912f;
  export const subCommand = 0;
  export const needSign = false;
  export const reqSchema = message([{ name: 'target', tag: 1, type: TARGET }]);
  export const respSchema = message([]);
  export const serialize = (p: { uid: string }): Record<string, unknown> => ({
    target: { uid: requireUid(p.uid) },
  });
  export const deserialize = (_body: Record<string, unknown>): void => {};
  export const invoke = (nt: OidbNative, pid: number, p: { uid: string }): Promise<void> =>
    invokeOidb(nt, pid, ClearFriendRemark, p);
}
