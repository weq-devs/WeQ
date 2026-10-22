import regionRows from './qq-regions.json';
import { encode, message } from '../../protobuf';
import { sendOidb, type PacketNative } from '../../transport';
import { requireUin } from '../write-validation';
import { getCloudProfile } from './cloud-profile';
import { invokeLegacyOidb } from '../legacy';

export interface QqRegion {
  code: string;
  name: string;
  children: QqRegion[];
}
export const QQ_REGIONS: QqRegion[] = [];
for (const row of regionRows) {
  let siblings = QQ_REGIONS;
  for (let depth = 0; depth < 4; depth++) {
    const code = row[depth * 2]!,
      name = row[depth * 2 + 1]!;
    let node = siblings.find((entry) => entry.code === code);
    if (!node) {
      node = { code, name, children: [] };
      siblings.push(node);
    }
    siblings = node.children;
  }
}
export const QQ_PROFESSIONS = [
  '计算机／互联网／通信',
  '生产／工艺／制造',
  '医疗／护理／制药',
  '金融／银行／投资／保险',
  '商业／服务业／个体经营',
  '文化／广告／传媒',
  '娱乐／艺术／表演',
  '律师／法务',
  '教育／培训',
  '公务员／行政／事业单位',
  '模特',
  '空姐',
  '学生',
  '其他职业',
].map((label, index) => ({ value: index + 1, label }));
export type EditableProfilePatch = {
  birthday?: string;
  region?: string[];
  email?: string;
  school?: string;
  profession?: number;
  hometown?: string[];
};
const keys = {
  school: 20021,
  email: 20011,
  profession: 27037,
  hometown: 24002,
  district: 20043,
} as const;

export function packQqRegionCode(code: string) {
  if (!/^[A-Za-z0-9]{0,4}$/.test(code)) throw new Error('地区代码无效');
  let value = 0;
  for (const byte of Buffer.from(code, 'ascii')) value = value * 256 + byte;
  return value;
}
export function encodeQqRegion(path: string[], layers: 3 | 4) {
  if (path.length !== layers) throw new Error('请选择完整地区');
  let siblings = QQ_REGIONS;
  const bytes = Buffer.alloc(layers * 4);
  path.forEach((code, index) => {
    const node = siblings.find((row) => row.code === code);
    if (!node) throw new Error('地区不在 QQ 官方目录中');
    bytes.writeUInt32BE(layers === 4 && code === '0' ? 0 : packQqRegionCode(code), index * 4);
    siblings = node.children;
  });
  return bytes;
}
function decodeRegion(bytes: Uint8Array | undefined, district?: Uint8Array) {
  if (bytes?.length !== 12 || (district && district.length !== 4)) return null;
  const buffer = district ? Buffer.concat([bytes, district]) : Buffer.from(bytes);
  let siblings = QQ_REGIONS;
  const path: string[] = [];
  for (let index = 0; index < buffer.length / 4; index++) {
    const code = buffer.readUInt32BE(index * 4);
    const node = siblings.find(
      (row) => (district && row.code === '0' ? 0 : packQqRegionCode(row.code)) === code,
    );
    if (!node) return null;
    path.push(node.code);
    siblings = node.children;
  }
  return path;
}
export function packQqBirthday(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('请选择完整公历生日');
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > days[month - 1]!)
    throw new Error('公历生日无效');
  return year * 65536 + month * 256 + day;
}
function uin32(uin: string) {
  const value = requireUin(uin);
  if (value > 0xffffffffn) throw new Error('QQ 号超出支持范围');
  return Number(value);
}
export function parseLegacyProfileBody(bytes: Uint8Array, uin: string) {
  const body = Buffer.from(bytes);
  if (body.length < 7 || body.readUInt32BE() !== uin32(uin))
    throw new Error('本人资料响应身份异常');
  const count = body.readUInt16BE(5);
  if (count > 64) throw new Error('本人资料字段超限');
  const result = new Map<number, Uint8Array>();
  let offset = 7;
  for (let i = 0; i < count; i++) {
    if (offset + 4 > body.length) throw new Error('本人资料 TLV 截断');
    const key = body.readUInt16BE(offset),
      length = body.readUInt16BE(offset + 2);
    offset += 4;
    if (!key || result.has(key) || offset + length > body.length)
      throw new Error('本人资料 TLV 异常');
    result.set(key, body.subarray(offset, offset + length));
    offset += length;
  }
  if (
    offset !== body.length &&
    !(body.length - offset === 2 && body.subarray(offset).every((value) => value === 0))
  )
    throw new Error('本人资料存在未知尾部');
  return result;
}
export async function readEditableProfile(
  nt: PacketNative,
  pid: number,
  uin: string,
  expectedUid?: string,
) {
  const legacyKeys = Object.values(keys);
  const request = Buffer.alloc(7 + legacyKeys.length * 2);
  request.writeUInt32BE(uin32(uin));
  request.writeUInt16BE(legacyKeys.length, 5);
  legacyKeys.forEach((key, i) => {
    request.writeUInt16BE(key, 7 + i * 2);
  });
  const [modernResult, legacyResult] = await Promise.allSettled([
    getCloudProfile(nt, pid, uin, [20031, 20032]),
    invokeLegacyOidb(nt, pid, 0x480, 9, 'OidbSvc.0x480_9_IMCore', request).then((bytes) =>
      parseLegacyProfileBody(bytes, uin),
    ),
  ]);
  const errors: Partial<Record<keyof EditableProfilePatch, string>> = {};
  const modern = modernResult.status === 'fulfilled' ? modernResult.value : null;
  const legacy =
    legacyResult.status === 'fulfilled' ? legacyResult.value : new Map<number, Uint8Array>();
  if (modern?.uid && expectedUid && modern.uid !== expectedUid)
    throw new Error('本人资料 UID 与当前账号不一致');
  if (!modern) {
    errors.birthday = '生日读取失败';
    errors.region = '当前地区读取失败';
  }
  if (legacyResult.status === 'rejected')
    for (const field of ['email', 'school', 'profession', 'hometown'] as const)
      errors[field] = '该项资料读取失败';
  const date = modern?.bytes.get(20031);
  let birthday: string | null = null;
  if (date?.length === 4) {
    const raw = Buffer.from(date);
    const formatted = `${String(raw.readUInt16BE()).padStart(4, '0')}-${String(raw[2]).padStart(2, '0')}-${String(raw[3]).padStart(2, '0')}`;
    try {
      packQqBirthday(formatted);
      birthday = formatted;
    } catch {
      /* 未确认的生日形态保持未知。 */
    }
  }
  const text = (key: number, field: 'email' | 'school') => {
    const bytes = legacy.get(key);
    if (bytes === undefined) return null;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      errors[field] = '该项资料文本格式无法识别';
      return null;
    }
  };
  const profession = legacy.get(keys.profession);
  return {
    birthday,
    region: decodeRegion(modern?.bytes.get(20032)),
    email: text(keys.email, 'email'),
    school: text(keys.school, 'school'),
    profession: profession?.length === 4 ? Buffer.from(profession).readUInt32BE() : null,
    hometown: legacy.has(keys.district)
      ? decodeRegion(legacy.get(keys.hometown), legacy.get(keys.district))
      : null,
    errors,
  };
}
const modernWrite = message([
  { name: 'uin', tag: 1, type: 'uint64' },
  {
    name: 'bytes',
    tag: 2,
    repeated: true,
    type: message([
      { name: 'key', tag: 1, type: 'uint32' },
      { name: 'value', tag: 2, type: 'bytes', force: true },
    ]),
  },
  {
    name: 'numbers',
    tag: 3,
    repeated: true,
    type: message([
      { name: 'key', tag: 1, type: 'uint32' },
      { name: 'value', tag: 2, type: 'uint64', force: true },
    ]),
  },
]);
export function encodeEditableProfile(patch: EditableProfilePatch) {
  if (Object.keys(patch).length !== 1) throw new Error('请逐项保存资料');
  const legacy = new Map<number, Uint8Array>();
  if (patch.birthday !== undefined)
    return {
      modern: { numbers: [{ key: 20031, value: BigInt(packQqBirthday(patch.birthday)) }] },
      legacy,
    };
  if (patch.region !== undefined)
    return { modern: { bytes: [{ key: 20032, value: encodeQqRegion(patch.region, 3) }] }, legacy };
  if (patch.email !== undefined || patch.school !== undefined) {
    const text = patch.email ?? patch.school!;
    if (Buffer.byteLength(text) > 996) throw new Error('文本超出 QQ 资料字段容量');
    legacy.set(patch.email !== undefined ? keys.email : keys.school, Buffer.from(text));
  } else if (patch.profession !== undefined) {
    if (!QQ_PROFESSIONS.some((row) => row.value === patch.profession))
      throw new Error('职业不在支持目录中');
    const value = Buffer.alloc(4);
    value.writeUInt32BE(patch.profession);
    legacy.set(keys.profession, value);
  } else if (patch.hometown !== undefined) {
    const value = encodeQqRegion(patch.hometown, 4);
    legacy.set(keys.hometown, value.subarray(0, 12));
    legacy.set(keys.district, value.subarray(12));
  } else throw new Error('资料字段未建模');
  return { modern: null, legacy };
}
export async function writeEditableProfile(
  nt: PacketNative,
  pid: number,
  uin: string,
  patch: EditableProfilePatch,
) {
  const values = encodeEditableProfile(patch);
  if (values.modern) {
    await sendOidb(
      nt,
      pid,
      {
        command: 0x112a,
        subCommand: 2,
        body: encode(modernWrite, { uin: requireUin(uin), ...values.modern }),
      },
      true,
    );
    return;
  }
  const chunks: Buffer[] = [];
  for (const [key, value] of values.legacy) {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(key);
    header.writeUInt16BE(value.length, 2);
    chunks.push(header, Buffer.from(value));
  }
  const header = Buffer.alloc(7);
  header.writeUInt32BE(uin32(uin));
  header.writeUInt16BE(values.legacy.size, 5);
  await invokeLegacyOidb(
    nt,
    pid,
    0x4ff,
    9,
    'OidbSvc.0x4ff_9_IMCore',
    Buffer.concat([header, ...chunks]),
  );
}
