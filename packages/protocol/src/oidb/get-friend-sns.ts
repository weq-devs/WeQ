import { message } from '../protobuf';
import { invokeOidb } from './invoke';
import { SNS_FRIEND_DISTURB } from './set-peer-preference';
import { requireUid, requireUin, requireUint32, responseObject } from './write-validation';
import type { OidbNative } from '../transport';

export interface FriendSnsPage {
  selfUin?: string;
  cookie?: Uint8Array;
  friends: Array<{ uid: string; uin: string; disturb: boolean | null; disturbPresent: boolean }>;
}

/** 0xFD4_1 完整名册查询；游标来自上一页，不使用增量缓存。 */
export namespace GetFriendSnsPage {
  export const command = 0xfd4;
  export const subCommand = 1;
  export const reqSchema = message([
    { name: 'count', tag: 2, type: 'uint32' },
    { name: 'field4', tag: 4, type: 'uint32', force: true },
    { name: 'cookie', tag: 5, type: 'bytes' },
    { name: 'field6', tag: 6, type: 'uint32' },
    { name: 'field7', tag: 7, type: 'uint32' },
    {
      name: 'profiles',
      tag: 10001,
      repeated: true,
      type: message([
        { name: 'type', tag: 1, type: 'uint32' },
        {
          name: 'filter',
          tag: 2,
          type: message([{ name: 'numbers', tag: 1, type: 'uint32', repeated: true }]),
        },
      ]),
    },
    { name: 'snsKeys', tag: 10002, type: 'uint32', repeated: true },
    { name: 'field10003', tag: 10003, type: 'uint32' },
  ]);
  export const respSchema = message([
    { name: 'cookie', tag: 2, type: 'bytes' },
    { name: 'isEnd', tag: 3, type: 'bool' },
    { name: 'selfUin', tag: 7, type: 'uint64' },
    {
      name: 'friends',
      tag: 101,
      repeated: true,
      type: message([
        { name: 'uid', tag: 1, type: 'string' },
        { name: 'uin', tag: 3, type: 'uint64' },
        {
          name: 'sns',
          tag: 10002,
          repeated: true,
          type: message([
            { name: 'key', tag: 1, type: 'uint32' },
            { name: 'value', tag: 2, type: 'bytes', force: true },
          ]),
        },
      ]),
    },
  ]);
  export function serialize(p: { cookie?: Uint8Array }): Record<string, unknown> {
    return {
      count: 300,
      field4: 0,
      field6: 1,
      field7: 0x7fffffff,
      profiles: [
        { type: 1, filter: { numbers: [103, 102, 20002, 27394] } },
        { type: 4, filter: { numbers: [100, 101, 102] } },
      ],
      snsKeys: [13578, SNS_FRIEND_DISTURB, 13573, 13572, 13568],
      field10003: 4051,
      ...(p.cookie?.length ? { cookie: p.cookie } : {}),
    };
  }
  export function deserialize(body: Record<string, unknown>): FriendSnsPage {
    if (
      body.selfUin === undefined &&
      body.cookie === undefined &&
      body.friends === undefined &&
      body.isEnd === undefined
    )
      throw new Error('好友名册响应为空或无法识别');
    const seen = new Set<string>();
    const friends = ((body.friends ?? []) as unknown[]).map((entry) => {
      const row = responseObject(entry, '好友');
      const uid = requireUid(String(row.uid));
      if (seen.has(uid)) throw new Error('好友名册返回重复目标');
      seen.add(uid);
      const keys = new Set<number>();
      let disturb: boolean | null = null;
      for (const raw of (row.sns ?? []) as unknown[]) {
        const item = responseObject(raw, '好友 SNS');
        const key = requireUint32(Number(item.key), 'SNS 标识');
        if (keys.has(key)) throw new Error('好友名册返回重复 SNS 属性');
        keys.add(key);
        if (key !== SNS_FRIEND_DISTURB) continue;
        if (!(item.value instanceof Uint8Array)) throw new Error('好友 SNS 属性缺少值');
        const bytes = item.value;
        if (bytes.length === 0) disturb = false;
        else if (bytes.length === 8 && bytes.subarray(4).every((byte) => byte === 0xff))
          disturb = true;
      }
      return {
        uid,
        uin: requireUin(String(row.uin)).toString(),
        disturb,
        disturbPresent: keys.has(SNS_FRIEND_DISTURB),
      };
    });
    return {
      ...(body.selfUin === undefined
        ? {}
        : { selfUin: requireUin(String(body.selfUin)).toString() }),
      ...(body.cookie instanceof Uint8Array ? { cookie: body.cookie } : {}),
      friends,
    };
  }
  export const invoke = (
    nt: OidbNative,
    pid: number,
    p: { cookie?: Uint8Array },
  ): Promise<FriendSnsPage> => invokeOidb(nt, pid, GetFriendSnsPage, p);
}
