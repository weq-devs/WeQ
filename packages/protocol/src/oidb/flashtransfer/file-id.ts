// 构造 sub=103 的 fileId:客户端生成的 protobuf,base64url 编码。
// f2=SHA1, f3=filesize, f4=appid, f5=微秒时间戳, f6="prod", f10=TTL(主文件 1209600 / 封面图 8985599),
// f11=16B 会话ID, f15=3B, f16="gz"。f11/f15 随机生成,服务端不校验。
// appid 决定 fileId 落在哪个槽位:主文件 14901(0x93d4 f14.f1)、png 缩略图 14903、
// jpg 缩略图 14902。主文件必须用 14901,否则 fileId 不会被服务端采纳进 f14。

import { randomBytes } from 'node:crypto';
import { encode } from '../../protobuf';
import { FLASH_FILE_ID } from './schemas';

export const FLASH_FILE_ID_TTL_SECONDS = 1209600;
/** 封面图 fileId TTL(真实抓包 8985599 = 104 天-1s,主文件是 14 天-1s)。 */
export const FLASH_FILE_ID_TTL_THUMB_SECONDS = 8985599;
export const FLASH_APPID_MAIN = 14901;
export const FLASH_APPID_PNG_THUMB = 14903;
export const FLASH_APPID_JPG_THUMB = 14902;

export function buildFileId(sha1: Uint8Array, fileSize: number, appid = FLASH_APPID_MAIN): string {
  const isThumb = appid !== FLASH_APPID_MAIN;
  const fileId = {
    sha1: new Uint8Array(sha1),
    fileSize,
    appid,
    timestamp: BigInt(Date.now()) * 1000n, // 微秒时间戳
    env: 'prod',
    ttl: isThumb ? FLASH_FILE_ID_TTL_THUMB_SECONDS : FLASH_FILE_ID_TTL_SECONDS,
    sessionId: randomBytes(16),
    field15: randomBytes(3),
    region: 'gz',
  };
  return Buffer.from(encode(FLASH_FILE_ID, fileId)).toString('base64url');
}
