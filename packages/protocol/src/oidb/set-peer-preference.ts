import { message } from '../protobuf';
import { invokeOidb } from './invoke';
import { requireUid, requireUint32, responseObject } from './write-validation';
import type { OidbNative } from '../transport';

export const SNS_FRIEND_PIN = 13578;
export const SNS_GROUP_PIN = 13569;
export const SNS_FRIEND_DISTURB = 13579;

export type PeerPreferenceTarget =
  | { kind: 'c2c'; uid: string }
  | { kind: 'group'; groupId: number };

export interface SetPeerPinParams {
  target: PeerPreferenceTarget;
  enabled: boolean;
  timestamp?: number;
}

const SNS_ITEM = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'value', tag: 2, type: 'bytes' },
]);
const SNS_TARGET = message([
  { name: 'uid', tag: 1, type: 'string' },
  { name: 'groupId', tag: 2, type: 'uint64' },
  { name: 'item', tag: 400, type: SNS_ITEM },
]);
const SNS_REQ = message([
  { name: 'sequence', tag: 1, type: 'uint32', force: true },
  { name: 'target', tag: 2, type: SNS_TARGET },
  { name: 'domain', tag: 3, type: 'uint32' },
]);

function seconds(value = Math.floor(Date.now() / 1000)): number {
  return requireUint32(value, 'timestamp');
}

function timeBytes(timestamp: number, disturb: boolean): Uint8Array {
  const bytes = Buffer.alloc(disturb ? 8 : 4);
  bytes.writeUInt32BE(seconds(timestamp));
  if (disturb) bytes.writeUInt32BE(0xffffffff, 4);
  return bytes;
}

export namespace SetPeerPin {
  export const command = 0x5d6;
  export const needSign = false;
  export const reqSchema = SNS_REQ;
  export const respSchema = message([]);
  export const resolveSubCommand = (p: SetPeerPinParams): number =>
    p.target.kind === 'group' ? 1 : 18;
  export function serialize(p: SetPeerPinParams): Record<string, unknown> {
    const group = p.target.kind === 'group';
    return {
      sequence: 0,
      domain: group ? 11 : 1,
      target: {
        ...(p.target.kind === 'group'
          ? { groupId: BigInt(requireUint32(p.target.groupId, 'groupId')) }
          : { uid: requireUid(p.target.uid) }),
        item: {
          type: group ? SNS_GROUP_PIN : SNS_FRIEND_PIN,
          ...(p.enabled ? { value: timeBytes(seconds(p.timestamp), false) } : {}),
        },
      },
    };
  }
  export const deserialize = (_body: Record<string, unknown>): void => {};
  export const invoke = (nt: OidbNative, pid: number, p: SetPeerPinParams): Promise<void> =>
    invokeOidb(nt, pid, SetPeerPin, p);
}

export interface SetFriendDisturbParams {
  uid: string;
  enabled: boolean;
  timestamp?: number;
}

export namespace SetFriendDisturb {
  export const command = 0x5d6;
  export const subCommand = 19;
  export const needSign = true;
  export const reqSchema = SNS_REQ;
  // 官方 worker 取 tag 3 结果项；未核实其字段前保留原字节，不猜错误码槽。
  export const respSchema = message([{ name: 'results', tag: 3, repeated: true, type: 'bytes' }]);
  export function serialize(p: SetFriendDisturbParams): Record<string, unknown> {
    return {
      sequence: 0,
      domain: 1,
      target: {
        uid: requireUid(p.uid),
        item: {
          type: SNS_FRIEND_DISTURB,
          ...(p.enabled ? { value: timeBytes(seconds(p.timestamp), true) } : {}),
        },
      },
    };
  }
  export function deserialize(_body: Record<string, unknown>): 'unconfirmed' {
    return 'unconfirmed';
  }
  export const invoke = (
    nt: OidbNative,
    pid: number,
    p: SetFriendDisturbParams,
  ): Promise<'unconfirmed'> => invokeOidb(nt, pid, SetFriendDisturb, p);
}

export const GROUP_MESSAGE_POLICIES = [1, 4, 2, 3] as const;
export type GroupMessagePolicy = (typeof GROUP_MESSAGE_POLICIES)[number];
export interface SetGroupMessagePolicyParams {
  groupId: number;
  selfUid: string;
  policy: GroupMessagePolicy;
}

export namespace SetGroupMessagePolicy {
  export const command = 0xa80;
  export const subCommand = 1;
  export const needSign = true;
  export const reqSchema = message([
    {
      name: 'body',
      tag: 1,
      type: message([
        { name: 'groupId', tag: 1, type: 'uint32' },
        {
          name: 'setting',
          tag: 2,
          type: message([
            { name: 'selfUid', tag: 1, type: 'string' },
            { name: 'policy', tag: 4, type: 'uint32' },
          ]),
        },
        { name: 'field3', tag: 3, type: 'uint32' },
        { name: 'field4', tag: 4, type: 'uint32' },
      ]),
    },
  ]);
  export const respSchema = message([
    {
      name: 'body',
      tag: 1,
      type: message([
        { name: 'groupId', tag: 1, type: 'uint32' },
        { name: 'code', tag: 2, type: 'uint32' },
      ]),
    },
  ]);
  export function serialize(p: SetGroupMessagePolicyParams): Record<string, unknown> {
    if (!GROUP_MESSAGE_POLICIES.includes(p.policy)) throw new Error('群消息接收策略无效');
    return {
      body: {
        groupId: requireUint32(p.groupId, 'groupId'),
        setting: { selfUid: requireUid(p.selfUid), policy: p.policy },
        field3: 1,
        field4: 2,
      },
    };
  }
  export function deserialize(body: Record<string, unknown>): number {
    const result = responseObject(body.body, '群消息策略');
    if (result.code !== undefined && result.code !== 0)
      throw new Error(`群消息策略设置失败：${String(result.code)}`);
    return requireUint32(Number(result.groupId), '响应群号');
  }
  export async function invoke(
    nt: OidbNative,
    pid: number,
    p: SetGroupMessagePolicyParams,
  ): Promise<void> {
    const groupId = await invokeOidb(nt, pid, SetGroupMessagePolicy, p);
    if (groupId !== p.groupId) throw new Error('群消息策略响应目标不匹配');
  }
}
