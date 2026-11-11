import { decode, encode, message } from './protobuf';
import { sendPacket, type TrpcNative } from './transport';
import { invokeLegacyOidb } from './oidb/legacy';
import { requireUin, requireUint32, responseObject } from './oidb/write-validation';

export type GroupMemberNotifyMode = 'default' | 'concerned' | 'shielded';
export interface GroupMemberNotifyState {
  groupId: number;
  memberUin: string;
  mode: GroupMemberNotifyMode | null;
  rawMode: number | null;
  complete: boolean;
}
export interface GroupMemberNotifyTarget {
  groupId: number;
  memberUin: string;
}

const member = message([{ name: 'uin', tag: 1, type: 'uint64' }]);
const group = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  { name: 'concerned', tag: 3, type: member, repeated: true },
  { name: 'shielded', tag: 5, type: member, repeated: true },
  { name: 'defaults', tag: 6, type: 'uint64', repeated: true },
]);
const writeRequest = message([
  {
    name: 'write',
    tag: 1,
    type: message([{ name: 'groups', tag: 1, type: group, repeated: true }]),
  },
]);
const cardRequest = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  { name: 'uin', tag: 2, type: 'uint64' },
  { name: 'newClient', tag: 3, type: 'bool' },
  { name: 'clientType', tag: 4, type: 'uint32' },
  { name: 'richCardVersion', tag: 5, type: 'uint32' },
]);
const cardResponse = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  {
    name: 'member',
    tag: 3,
    type: message([
      { name: 'uin', tag: 1, type: 'uint64' },
      { name: 'result', tag: 2, type: 'uint32' },
      { name: 'error', tag: 3, type: 'string' },
      { name: 'concernType', tag: 30, type: 'uint32' },
    ]),
  },
]);

function target(p: GroupMemberNotifyTarget) {
  return { groupCode: BigInt(requireUint32(p.groupId, '群号')), uin: requireUin(p.memberUin) };
}

export function groupMemberNotifySubCommand(mode: GroupMemberNotifyMode): number {
  switch (mode) {
    case 'default':
      return 9;
    case 'concerned':
      return 2;
    case 'shielded':
      return 7;
    default:
      throw new Error('群内消息提醒状态无效');
  }
}

export function encodeGroupMemberNotify(
  p: GroupMemberNotifyTarget & { mode: GroupMemberNotifyMode },
) {
  const { groupCode, uin } = target(p);
  groupMemberNotifySubCommand(p.mode);
  return encode(writeRequest, {
    write: {
      groups: [
        {
          groupCode,
          ...(p.mode === 'default'
            ? { defaults: [uin] }
            : p.mode === 'concerned'
              ? { concerned: [{ uin }] }
              : { shielded: [{ uin }] }),
        },
      ],
    },
  });
}

export function decodeGroupMemberNotify(
  bytes: Uint8Array,
  p: GroupMemberNotifyTarget,
): GroupMemberNotifyState {
  const expected = target(p);
  const body = decode(cardResponse, bytes, { strict: true });
  const row = responseObject(body.member, '群成员提醒');
  if (body.groupCode !== expected.groupCode || row.uin !== expected.uin)
    throw new Error('群成员提醒返回目标不一致');
  if (row.result === undefined) throw new Error('服务端未返回群成员提醒状态，请稍后重新读取');
  if (row.result !== 0)
    throw new Error(
      `群成员提醒读取失败（${String(row.result ?? '未知')}）${typeof row.error === 'string' ? `：${row.error}` : ''}`,
    );
  const rawMode = typeof row.concernType === 'number' ? row.concernType : null;
  const mode =
    rawMode === 0 ? 'default' : rawMode === 1 ? 'concerned' : rawMode === 2 ? 'shielded' : null;
  return { ...p, mode, rawMode, complete: mode !== null };
}

export async function getGroupMemberNotify(
  nt: TrpcNative,
  pid: number,
  p: GroupMemberNotifyTarget,
) {
  const { groupCode, uin } = target(p);
  const bytes = await sendPacket(
    nt,
    pid,
    'group_member_card.get_group_member_card_info',
    encode(cardRequest, { groupCode, uin, newClient: true, clientType: 1, richCardVersion: 1 }),
  );
  return decodeGroupMemberNotify(bytes, p);
}

export async function setGroupMemberNotify(
  nt: TrpcNative,
  pid: number,
  p: GroupMemberNotifyTarget & { mode: GroupMemberNotifyMode },
) {
  const sub = groupMemberNotifySubCommand(p.mode);
  await invokeLegacyOidb(nt, pid, 0x8bb, sub, `OidbSvc.0x8bb_${sub}`, encodeGroupMemberNotify(p), {
    strict: true,
    allowEmptyBody: true,
  });
}
