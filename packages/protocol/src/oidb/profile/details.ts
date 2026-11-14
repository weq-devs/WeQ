import type { TrpcNative, OidbNative } from '../../transport';
import { getCloudProfile } from './cloud-profile';
import { invokeLegacyOidb } from '../legacy';
import { requireUin } from '../write-validation';
import {
  decodeQqRegion,
  formatQqRegion,
  QQ_REGIONS,
  parseLegacyProfileBody,
} from './editable-profile';

export const PROFILE_DETAIL_FIELDS = {
  company: 24008,
  personalDescription: 20019,
  email: 20011,
  hometown: 24002,
  school: 20021,
  profession: 27037,
} as const;
export type ProfileDetailField = keyof typeof PROFILE_DETAIL_FIELDS;
export interface ProfileDetailInfo {
  targetUin: string;
  company: string | null;
  personalDescription: string | null;
  email: string | null;
  /** 兼容先前查询缓存没有此字段的情况。 */
  hometown?: string[] | null;
  hometownText?: string | null;
  school?: string | null;
  profession?: number | null;
  errors: Partial<Record<ProfileDetailField, string>>;
}
const decoder = new TextDecoder('utf-8', { fatal: true });

/** 详细资料的个人说明是 20019；不能使用签名 102 或好友扩展备注 0x43c。 */
export async function getProfileDetails(
  nt: TrpcNative,
  pid: number,
  targetUin: string,
): Promise<ProfileDetailInfo> {
  const uin = requireUin(targetUin);
  if (uin > 0xffffffffn) throw new Error('详细资料目标 QQ 号超出支持范围');
  const district = 20043;
  const keys = [...Object.values(PROFILE_DETAIL_FIELDS), district];
  const request = Buffer.alloc(7 + keys.length * 2);
  request.writeUInt32BE(Number(uin));
  request.writeUInt16BE(keys.length, 5);
  keys.forEach((key, index) => {
    request.writeUInt16BE(key, 7 + index * 2);
  });
  const values = parseLegacyProfileBody(
    await invokeLegacyOidb(nt, pid, 0x480, 9, 'OidbSvc.0x480_9_IMCore', request, { strict: true }),
    targetUin,
  );
  const errors: ProfileDetailInfo['errors'] = {};
  const read = (field: Exclude<ProfileDetailField, 'hometown' | 'profession'>) => {
    const bytes = values.get(PROFILE_DETAIL_FIELDS[field]);
    if (bytes === undefined) return null;
    try {
      return decoder.decode(bytes);
    } catch {
      errors[field] = '文本格式无法识别';
      return null;
    }
  };
  const hometown = decodeQqRegion(values.get(PROFILE_DETAIL_FIELDS.hometown), values.get(district));
  if (values.has(PROFILE_DETAIL_FIELDS.hometown) && !hometown) errors.hometown = '地区格式无法识别';
  const occupation = values.get(PROFILE_DETAIL_FIELDS.profession);
  const profession = occupation?.length === 4 ? Buffer.from(occupation).readUInt32BE() : null;
  if (occupation && occupation.length !== 0 && occupation.length !== 4)
    errors.profession = '职业格式无法识别';
  return {
    targetUin,
    company: read('company'),
    personalDescription: read('personalDescription'),
    email: read('email'),
    hometown,
    hometownText: formatQqRegion(hometown, QQ_REGIONS),
    school: read('school'),
    profession,
    errors,
  };
}

export interface ProfileRegion {
  targetUin: string;
  region: string[] | null;
  regionText: string | null;
}
/** 所在地使用现代资料字段 20032，与旧家乡 TLV 保持独立。 */
export async function getProfileRegion(
  nt: OidbNative,
  pid: number,
  targetUin: string,
): Promise<ProfileRegion> {
  const data = await getCloudProfile(nt, pid, targetUin, [20032]);
  const bytes = data.bytes.get(20032);
  const region = decodeQqRegion(bytes);
  if (bytes && !region) throw new Error('所在地地区格式无法识别');
  return { targetUin, region, regionText: formatQqRegion(region, QQ_REGIONS) };
}
