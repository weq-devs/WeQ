import {
  BufferChunkSource,
  fetchHighwaySession,
  uploadHighwayHttp,
} from '../../highway/highway-client';
import { computeHashes } from '../../highway/hash-file';
import { assertUploadableImage, detectImageFormat } from '../../highway/image-format';
import { encode, message } from '../../protobuf';
import type { TrpcNative } from '../../transport';
import { invokeLegacyOidb } from '../legacy';
import { requireUin } from '../write-validation';

export const PERSONALITY_PHOTO_HIGHWAY_COMMAND = 39;
export interface PersonalityPhotoUploadResult {
  photoId: string;
  url: string;
}
export function buildPersonalityPhotoExtend(
  labelId: string,
  count: number,
  index: number,
  timestamp: number,
): Uint8Array {
  const label = requireUin(labelId);
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 100 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count ||
    !Number.isInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > 0xffffffff
  )
    throw new Error('标签上传批次无效');
  const bytes = Buffer.alloc(28);
  bytes.writeBigUInt64BE(label);
  bytes.writeUInt32BE(count, 8);
  bytes.writeUInt32BE(index, 12);
  bytes.writeUInt32BE(timestamp, 24);
  return bytes;
}
export function parsePersonalityPhotoUpload(value: Uint8Array): PersonalityPhotoUploadResult {
  const bytes = Buffer.from(value);
  if (!bytes.length) throw new Error('上传响应缺少业务结果');
  if (bytes[0] !== 0) throw new Error(`照片上传失败：${bytes[0]}`);
  if (bytes.length < 17) throw new Error('照片上传响应被截断');
  const length = bytes.readUInt32BE(13);
  const photoId = bytes.readBigUInt64BE(5).toString();
  if (!length || length > 65536 || bytes.length < 17 + length || photoId === '0')
    throw new Error('照片上传响应无效');
  const url = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(17, 17 + length));
  return { photoId, url };
}
export async function uploadPersonalityPhoto(
  nt: TrpcNative,
  pid: number,
  params: {
    uin: string;
    labelId: string;
    source: Uint8Array;
    count?: number;
    index?: number;
    timestamp?: number;
    beforeSend?: () => void;
  },
): Promise<PersonalityPhotoUploadResult> {
  requireUin(params.uin);
  if (!params.source.length || params.source.length > 20 * 1024 * 1024)
    throw new Error('请选择 20 MB 以内的图片');
  assertUploadableImage(params.source);
  const format = detectImageFormat(params.source);
  if (!format.width || !format.height) throw new Error('无法读取图片尺寸');
  const extend = buildPersonalityPhotoExtend(
    params.labelId,
    params.count ?? 1,
    params.index ?? 0,
    params.timestamp ?? Math.floor(Date.now() / 1000),
  );
  params.beforeSend?.();
  const session = await fetchHighwaySession(nt, pid);
  params.beforeSend?.();
  let result: PersonalityPhotoUploadResult | undefined;
  await uploadHighwayHttp({
    session,
    uin: params.uin,
    commandId: PERSONALITY_PHOTO_HIGHWAY_COMMAND,
    source: new BufferChunkSource(params.source),
    fileMd5: computeHashes(params.source).md5,
    extend,
    beforeSend: params.beforeSend,
    onResponse(response) {
      if (response.segmentResult) throw new Error(`照片分片上传失败：${response.segmentResult}`);
      if (response.final) result = parsePersonalityPhotoUpload(response.extend);
    },
  });
  if (!result) throw new Error('上传响应缺少照片标识');
  return result;
}
/** 标签照片删除也供上传验收清理使用。 */
export async function deletePersonalityPhoto(
  nt: TrpcNative,
  pid: number,
  uin: string,
  labelId: string,
  photoId: string,
) {
  for (const value of [uin, labelId, photoId]) requireUin(value);
  const schema = message([
    { name: 'uin', tag: 2, type: 'uint64' },
    { name: 'label', tag: 3, type: 'uint64' },
    { name: 'photos', tag: 4, type: 'uint64', repeated: true },
  ]);
  await invokeLegacyOidb(
    nt,
    pid,
    0x90c,
    0,
    'OidbSvc.0x90c',
    encode(schema, { uin, label: labelId, photos: [photoId] }),
    { allowEmptyBody: true },
  );
}
