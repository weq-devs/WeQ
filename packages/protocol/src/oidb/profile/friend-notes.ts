import { decode, encode, message } from '../../protobuf';
import type { TrpcNative } from '../../transport';
import { invokeLegacyOidb } from '../legacy';
import { requireUin } from '../write-validation';

/** 当前账号为好友填写的备注资料，不是好友公开资料。 */
export interface FriendNotes {
  company: string;
  phones: string[];
  descriptions: string[];
}

export const friendNoteCardSchema = message([
  { name: 'id', tag: 1, type: 'bytes' },
  { name: 'name', tag: 3, type: 'string' },
  { name: 'company', tag: 4, type: 'string', force: true },
  { name: 'phones', tag: 6, type: 'string', repeated: true },
  { name: 'descriptions', tag: 7, type: 'string', repeated: true },
  { name: 'targetUin', tag: 8, type: 'uint64' },
  { name: 'source', tag: 9, type: 'uint32' },
]);

/** 保留未编辑字段的原始 wire（包括图片、OCR、未知扩展和显式默认值）。 */
function rawFields(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 524288) throw new Error('好友备注名片为空或超限');
  decode(message([]), bytes, { strict: true });
  let offset = 0;
  const varint = () => {
    let value = 0n;
    let shift = 0n;
    let byte: number;
    do {
      byte = bytes[offset++]!;
      value |= BigInt(byte & 127) << shift;
      shift += 7n;
    } while (byte & 128);
    return value;
  };
  const result: Array<{ tag: number; bytes: Uint8Array }> = [];
  while (offset < bytes.length) {
    const start = offset;
    const key = Number(varint());
    const wire = key & 7;
    if (wire === 0) varint();
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else {
      const length = Number(varint());
      offset += length;
    }
    result.push({ tag: Math.floor(key / 8), bytes: bytes.subarray(start, offset) });
  }
  return result;
}

export function parseFriendNoteCard(bytes: Uint8Array, targetUin: string) {
  const fields = rawFields(bytes);
  for (const tag of [1, 3, 4, 8, 9]) {
    if (fields.filter((field) => field.tag === tag).length > 1)
      throw new Error('好友备注名片单值字段重复');
  }
  const card = decode(friendNoteCardSchema, bytes, { strict: true });
  if (!(card.id instanceof Uint8Array) || !card.id.length) throw new Error('好友备注名片缺少 ID');
  if (card.targetUin !== requireUin(targetUin)) throw new Error('好友备注名片关联目标不匹配');
  return {
    id: card.id,
    company: (card.company as string | undefined) ?? '',
    phones: (card.phones as string[] | undefined) ?? [],
    descriptions: (card.descriptions as string[] | undefined) ?? [],
  };
}

export function validateFriendNotes(notes: FriendNotes) {
  if (typeof notes.company !== 'string' || notes.company.length > 1024)
    throw new Error('我备注的公司文本过长');
  for (const [label, values] of [
    ['电话', notes.phones],
    ['描述', notes.descriptions],
  ] as const) {
    if (
      !Array.isArray(values) ||
      values.length > 100 ||
      values.some((value) => typeof value !== 'string' || !value.length || value.length > 4096)
    )
      throw new Error(`我备注的${label}列表无效`);
  }
}

export function replaceFriendNotes(original: Uint8Array, targetUin: string, notes: FriendNotes) {
  validateFriendNotes(notes);
  parseFriendNoteCard(original, targetUin);
  return Buffer.concat([
    ...rawFields(original)
      .filter((field) => ![4, 6, 7].includes(field.tag))
      .map((field) => field.bytes),
    encode(friendNoteCardSchema, {
      company: notes.company,
      phones: notes.phones,
      descriptions: notes.descriptions,
    }),
  ]);
}

const idRequest = message([{ name: 'id', tag: 1, type: 'bytes' }]);
const detailResponse = message([
  { name: 'id', tag: 1, type: 'bytes' },
  { name: 'card', tag: 2, type: 'bytes' },
]);
const cardRequest = message([{ name: 'card', tag: 1, type: 'bytes' }]);

export async function readFriendNoteDetail(
  nt: TrpcNative,
  pid: number,
  id: Uint8Array,
  targetUin: string,
) {
  const bytes = await invokeLegacyOidb(
    nt,
    pid,
    0x43c,
    5,
    'OidbSvc.0x43c_5',
    encode(idRequest, { id }),
    { strict: true },
  );
  const fields = rawFields(bytes);
  if ([1, 2].some((tag) => fields.filter((field) => field.tag === tag).length !== 1))
    throw new Error('好友备注详情字段缺失或重复');
  const body = decode(detailResponse, bytes, { strict: true });
  if (
    !(body.id instanceof Uint8Array) ||
    !Buffer.from(body.id).equals(Buffer.from(id)) ||
    !(body.card instanceof Uint8Array)
  )
    throw new Error('好友备注详情 ID 不匹配或内容缺失');
  const card = parseFriendNoteCard(body.card, targetUin);
  if (!Buffer.from(card.id).equals(Buffer.from(id))) throw new Error('好友备注详情内层 ID 不匹配');
  return body.card;
}

export async function writeFriendNoteCard(
  nt: TrpcNative,
  pid: number,
  card: Uint8Array,
  create = false,
) {
  const sub = create ? 1 : 3;
  const response = await invokeLegacyOidb(
    nt,
    pid,
    0x43c,
    sub,
    `OidbSvc.0x43c_${sub}`,
    encode(cardRequest, { card }),
    { strict: true },
  );
  if (create) {
    const body = decode(idRequest, response, { strict: true });
    if (!(body.id instanceof Uint8Array) || !body.id.length)
      throw new Error('好友备注新增响应缺少 ID，请刷新核对');
    return body.id;
  }
  return null;
}

export function newFriendNoteCard(targetUin: string, name: string, notes: FriendNotes) {
  validateFriendNotes(notes);
  return encode(friendNoteCardSchema, {
    ...notes,
    name,
    targetUin: requireUin(targetUin),
    source: 1,
  });
}
