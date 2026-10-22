import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { computeBkn, cookieHeader, type WebCredential } from './credential';
import { webRequestJson } from './http';

export interface GroupAlbumVideoUpload {
  groupId: string;
  albumId: string;
  albumName: string;
  fileName: string;
  video: Uint8Array | string;
  cover: Uint8Array;
  durationMs: number;
  width: number;
  height: number;
  beforeSend: () => void;
}
const root = 'https://h5.qzone.qq.com/webapp/json/sliceUpload/';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('视频上传响应结构未知，请刷新相册核对');
  return value as Record<string, unknown>;
}
export function parseAlbumVideoAck(value: unknown) {
  const outer = object(value),
    data = object(outer.data);
  if (outer.ret !== 0 || data.ret !== 0) throw new Error('视频上传未取得成功回执，请刷新相册核对');
  return data;
}
export function validateAlbumVideo(params: GroupAlbumVideoUpload) {
  if (
    !/^[1-9]\d{0,9}$/.test(params.groupId) ||
    BigInt(params.groupId) > 0xffffffffn ||
    !params.albumId ||
    !params.albumName
  )
    throw new Error('视频目标相册信息无效');
  if (
    typeof params.video !== 'string' &&
    (params.video.length < 16 ||
      Buffer.from(params.video.subarray(4, 8)).toString('ascii') !== 'ftyp')
  )
    throw new Error('请选择有效的 MP4 视频');
  if (params.cover.length < 4 || params.cover[0] !== 255 || params.cover[1] !== 216)
    throw new Error('视频封面须为 JPEG');
  for (const value of [params.width, params.height])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('视频封面尺寸无效');
  if (!Number.isSafeInteger(params.durationMs) || params.durationMs < 1)
    throw new Error('视频时长无效');
  if (!params.fileName || params.fileName.length > 255 || /[\r\n\0/\\]/.test(params.fileName))
    throw new Error('视频文件名无效');
}

export async function uploadGroupAlbumVideo(cred: WebCredential, params: GroupAlbumVideoUpload) {
  validateAlbumVideo(params);
  if (!cred.pskey) throw new Error('视频上传缺少空间域票据');
  const gtk = String(computeBkn(cred.pskey));
  const nowMs = Date.now();
  const handle = typeof params.video === 'string' ? await open(params.video, 'r') : null;
  try {
    const info = handle ? await handle.stat() : null;
    const videoBytes = typeof params.video === 'string' ? null : params.video;
    const videoSize = info?.size ?? videoBytes?.length ?? 0;
    if (!Number.isSafeInteger(videoSize) || videoSize < 16 || (info && !info.isFile()))
      throw new Error('视频文件不可读取');
    const readVideo = async (offset: number, length: number) => {
      params.beforeSend();
      if (videoBytes) return videoBytes.subarray(offset, offset + length);
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const result = await handle!.read(buffer, filled, length - filled, offset + filled);
        if (!result.bytesRead) throw new Error('视频文件在上传期间发生变化');
        filled += result.bytesRead;
      }
      return buffer;
    };
    if (Buffer.from((await readVideo(0, 16)).subarray(4, 8)).toString('ascii') !== 'ftyp')
      throw new Error('请选择有效的 MP4 视频');
    const hash = createHash('sha1');
    for (let offset = 0; offset < videoSize; offset += 1024 * 1024)
      hash.update(await readVideo(offset, Math.min(1024 * 1024, videoSize - offset)));
    const videoChecksum = hash.digest('hex');
    const uploadedHash = createHash('sha1');
    const headers = {
      'Content-Type': 'application/json',
      Referer: `https://user.qzone.qq.com/${cred.uin}`,
    };
    const post = async (path: string, body: unknown, query = new URLSearchParams()) => {
      query.set('g_tk', gtk);
      params.beforeSend();
      return parseAlbumVideoAck(
        await webRequestJson<unknown>(`${root}${path}?${query}`, {
          method: 'POST',
          redirect: 'error',
          cookie: cookieHeader(cred),
          headers,
          body: JSON.stringify(body),
          timeoutMs: 60000,
        }),
      );
    };
    const transfer = async (
      kind: 'video' | 'cover',
      size: number,
      checksum: string,
      read: (offset: number, length: number) => Promise<Uint8Array>,
      biz: Record<string, unknown>,
    ) => {
      const video = kind === 'video';
      const cmd = video ? 'FileUploadVideo' : 'FileUpload',
        appid = video ? 'video_qun' : 'qun';
      let data = await post(`FileBatchControl/${checksum}`, {
        control_req: [
          {
            uin: cred.uin,
            token: { type: 4, data: cred.pskey, appid: 5 },
            appid,
            checksum,
            check_type: video ? 1 : 0,
            file_len: size,
            env: { refer: 'qzone', deviceInfo: 'h5' },
            model: 0,
            biz_req: biz,
            session: '',
            asy_upload: 0,
            cmd,
          },
        ],
      });
      if (data.flag === 0) {
        const offset = data.offset ?? 0;
        const sliceSize = data.slice_size;
        if (
          offset !== 0 ||
          typeof sliceSize !== 'number' ||
          !Number.isSafeInteger(sliceSize) ||
          sliceSize < 1 ||
          sliceSize > 16 * 1024 * 1024
        )
          throw new Error('服务器返回的上传范围无法确认；未发送视频片段');
        if (typeof data.session !== 'string' || !data.session || data.session.length > 4096)
          throw new Error('上传会话信息无效');
        const session = data.session;
        for (let start = 0, seq = 0; start < size; seq++) {
          const end = Math.min(start + sliceSize, size);
          const chunk = await read(start, end - start);
          if (chunk.length !== end - start) throw new Error('上传片段长度与服务器范围不一致');
          if (video) uploadedHash.update(chunk);
          const query = new URLSearchParams({
            seq: String(seq),
            retry: '0',
            offset: String(start),
            end: String(end),
            total: String(size),
            type: 'json',
          });
          data = await post(
            cmd,
            {
              uin: cred.uin,
              appid,
              session,
              offset: start,
              data: Buffer.from(chunk).toString('base64'),
              checksum: '',
              check_type: video ? 1 : 0,
              retry: 0,
              seq,
              end,
              cmd,
              slice_size: sliceSize,
              biz_req: video ? {} : { iUploadType: 0 },
            },
            query,
          );
          if ((end < size && data.flag !== 0) || (end === size && data.flag !== 1))
            throw new Error('服务器分片完成状态异常，请刷新相册核对，不会重发片段');
          start = end;
        }
        if (video && uploadedHash.digest('hex') !== checksum)
          throw new Error('视频读取期间内容发生变化，已停止封面关联，请先核对相册');
      }
      if (data.flag !== 1) throw new Error('上传完成状态未确认，请刷新相册核对');
      return data;
    };
    const base = {
      sPicTitle: params.fileName,
      sPicDesc: '',
      sAlbumName: '',
      sAlbumID: '',
      iAlbumTypeID: 0,
      iBitmap: 0,
      iUploadType: 3,
      iUpPicType: 0,
      iBatchID: 0,
      sPicPath: '',
      iPicWidth: 0,
      iPicHight: 0,
      iWaterType: 0,
      iDistinctUse: 0,
      sTitle: params.fileName,
      sDesc: '',
      iFlag: 0,
      iUploadTime: nowMs,
      iPlayTime: params.durationMs,
      sCoverUrl: '',
      iIsNew: 111,
      iIsOriginalVideo: 0,
      iIsFormatF20: 0,
      clarityType: 0,
      isFormatF20: true,
      extend_info: {
        video_type: '3',
        domainid: '5',
        photo_num: '0',
        video_num: '1',
        qun_id: params.groupId,
      },
    };
    const data = await transfer('video', videoSize, videoChecksum, readVideo, base);
    const vid = object(data.biz).sVid;
    if (typeof vid !== 'string' || !vid || vid.length > 1024)
      throw new Error('视频已传输但未取得视频标识，请勿重复上传');
    try {
      await transfer(
        'cover',
        params.cover.length,
        createHash('md5').update(params.cover).digest('hex'),
        async (offset, length) => params.cover.subarray(offset, offset + length),
        {
          sPicTitle: `${params.fileName}.jpg`,
          sPicDesc: '',
          sAlbumName: params.albumName,
          sAlbumID: params.albumId,
          iAlbumTypeID: 0,
          iBitmap: 0,
          iUploadType: 0,
          iUpPicType: 0,
          iBatchID: nowMs * 1000,
          mutliPicInfo: {},
          iPicWidth: params.width,
          iPicHight: params.height,
          iWaterType: 0,
          iNeedFeeds: 1,
          iUploadTime: Math.ceil(nowMs / 1000),
          iDistinctUse: 0,
          mapExt: { appid: 'qun', userid: params.groupId },
          stExtendInfo: { mapParams: { vid, photo_num: '0', video_num: '1' } },
          stExternalMapExt: { is_client_upload_cover: '1', is_pic_video_mix_feeds: '1' },
        },
      );
    } catch {
      throw new Error('视频已传输，封面关联尚未确认。请刷新相册核对，不要重复上传视频。');
    }
    return { videoId: vid };
  } finally {
    await handle?.close();
  }
}
