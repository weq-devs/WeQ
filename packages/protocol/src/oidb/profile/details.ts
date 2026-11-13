import type { TrpcNative } from '../../transport';
import { invokeLegacyOidb } from '../legacy';
import { requireUin } from '../write-validation';
import { parseLegacyProfileBody } from './editable-profile';

export const PROFILE_DETAIL_FIELDS = {
  company: 24008,
  personalDescription: 20019,
  email: 20011,
} as const;
export type ProfileDetailField = keyof typeof PROFILE_DETAIL_FIELDS;
export interface ProfileDetailInfo {
  targetUin: string;
  company: string | null;
  personalDescription: string | null;
  email: string | null;
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
  const keys = Object.values(PROFILE_DETAIL_FIELDS);
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
  const read = (field: ProfileDetailField) => {
    const bytes = values.get(PROFILE_DETAIL_FIELDS[field]);
    if (bytes === undefined) return null;
    try {
      return decoder.decode(bytes);
    } catch {
      errors[field] = '文本格式无法识别';
      return null;
    }
  };
  return {
    targetUin,
    company: read('company'),
    personalDescription: read('personalDescription'),
    email: read('email'),
    errors,
  };
}
