import { encode, decode, message } from '../../protobuf';
import { GetUserQqLevel } from './get-user-qq-level';
import { sendOidb, type PacketNative } from '../../transport';
import { requireUin, responseObject } from '../write-validation';
import { invokeLegacyOidb } from '../legacy';

export const cloudProfileResponse = message([
  {
    name: 'body',
    tag: 1,
    type: message([
      { name: 'uid', tag: 1, type: 'string' },
      {
        name: 'properties',
        tag: 2,
        type: message([
          {
            name: 'numbers',
            tag: 1,
            repeated: true,
            type: message([
              { name: 'key', tag: 1, type: 'uint32' },
              { name: 'value', tag: 2, type: 'uint32', force: true },
            ]),
          },
          {
            name: 'bytes',
            tag: 2,
            repeated: true,
            type: message([
              { name: 'key', tag: 1, type: 'uint32' },
              { name: 'value', tag: 2, type: 'bytes', force: true },
            ]),
          },
        ]),
      },
      { name: 'uin', tag: 3, type: 'uint32' },
    ]),
  },
]);
export async function getCloudProfile(nt: PacketNative, pid: number, uin: string, keys: number[]) {
  const number = requireUin(uin);
  if (number > 0xffffffffn) throw new Error('QQ 号超出支持范围');
  const body = responseObject(
    decode(
      cloudProfileResponse,
      await sendOidb(
        nt,
        pid,
        {
          command: 0xfe1,
          subCommand: 2,
          isUid: true,
          body: encode(GetUserQqLevel.reqSchema, {
            uin: Number(number),
            keys: keys.map((key) => ({ key })),
          }),
        },
        true,
      ),
    ).body,
    '云端资料',
  );
  if (body.uin !== undefined && String(body.uin) !== uin) throw new Error('云端资料号码不匹配');
  const props = responseObject(body.properties, '云端资料属性');
  const numbers = new Map<number, number>();
  const bytes = new Map<number, Uint8Array>();
  for (const raw of (props.numbers ?? []) as unknown[]) {
    const row = responseObject(raw, '数字属性');
    if (typeof row.key !== 'number' || typeof row.value !== 'number' || numbers.has(row.key))
      throw new Error('云端数字属性异常');
    numbers.set(row.key, row.value);
  }
  for (const raw of (props.bytes ?? []) as unknown[]) {
    const row = responseObject(raw, '字节属性');
    if (typeof row.key !== 'number' || !(row.value instanceof Uint8Array) || bytes.has(row.key))
      throw new Error('云端字节属性异常');
    bytes.set(row.key, row.value);
  }
  return { uid: typeof body.uid === 'string' ? body.uid : null, numbers, bytes };
}

export async function getCommonFriendCount(
  nt: PacketNative,
  pid: number,
  self: string,
  target: string,
) {
  const from = requireUin(self),
    to = requireUin(target);
  if (from > 0xffffffffn || to > 0xffffffffn || from === to)
    throw new Error('共同好友查询目标无效');
  const body = Buffer.alloc(10);
  body.writeUInt32BE(Number(from));
  body.writeUInt16BE(1, 4);
  body.writeUInt32BE(Number(to), 6);
  const reply = Buffer.from(await invokeLegacyOidb(nt, pid, 0x42d, 4, 'OidbSvc.0x42d_4', body));
  if (reply.length < 8 || reply.readUInt32BE() !== Number(from))
    throw new Error('共同好友响应身份异常');
  const successes = reply.readUInt16BE(4);
  if (successes === 0 && reply.readUInt16BE(6) === 1) return null;
  if (
    successes !== 1 ||
    reply.length !== 14 ||
    reply.readUInt32BE(6) !== Number(to) ||
    reply.readUInt16BE(12) !== 0
  )
    throw new Error('共同好友响应目标或记录异常');
  const count = reply.readInt16BE(10);
  return count >= 0 ? count : null;
}
const commonGroup = message([
  { name: 'groupUin', tag: 1, type: 'uint64' },
  { name: 'groupCode', tag: 2, type: 'uint64' },
  { name: 'name', tag: 3, type: 'string' },
]);
const commonGroupsRequest = message([
  { name: 'from', tag: 1, type: 'uint64' },
  { name: 'to', tag: 2, type: 'uint64' },
  { name: 'qzoneDna', tag: 4, type: 'bool', force: true },
  { name: 'newDna', tag: 6, type: 'bool', force: true },
]);
export const commonGroupsResponse = message([
  { name: 'from', tag: 1, type: 'uint64' },
  { name: 'to', tag: 2, type: 'uint64' },
  {
    name: 'info',
    tag: 12,
    type: message([
      { name: 'groups', tag: 1, repeated: true, type: commonGroup },
      { name: 'recent', tag: 2, type: commonGroup },
    ]),
  },
]);
export async function getCommonGroups(
  nt: PacketNative,
  pid: number,
  self: string,
  target: string,
  clientVersion: string,
) {
  if (!clientVersion) throw new Error('未取得当前 QQ 版本，无法查询共同群');
  const from = requireUin(self),
    to = requireUin(target);
  if (from === to) throw new Error('不能查询与自己的共同群');
  const response = decode(
    commonGroupsResponse,
    await invokeLegacyOidb(
      nt,
      pid,
      0xcf4,
      0,
      'OidbSvc.0xcf4',
      encode(commonGroupsRequest, { from, to, qzoneDna: true, newDna: false }),
      clientVersion,
    ),
  );
  if (
    (response.from !== undefined && response.from !== from) ||
    (response.to !== undefined && response.to !== to)
  )
    throw new Error('共同群响应目标不匹配');
  const info = responseObject(response.info, '共同群');
  const seen = new Set<string>();
  return ((info.groups ?? []) as unknown[]).map((raw) => {
    const row = responseObject(raw, '共同群记录');
    const groupCode = requireUin(String(row.groupCode)).toString();
    if (seen.has(groupCode)) throw new Error('共同群返回重复记录');
    seen.add(groupCode);
    return {
      groupCode,
      groupUin: row.groupUin === undefined ? null : requireUin(String(row.groupUin)).toString(),
      name: typeof row.name === 'string' ? row.name : '',
    };
  });
}
