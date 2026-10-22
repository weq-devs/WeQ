import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  uploadGroupAlbumVideo,
  parseAlbumVideoAck,
  type GroupAlbumVideoUpload,
} from '../src/account/web/group_album_video';

afterEach(() => vi.unstubAllGlobals());
function video(size: number) {
  const bytes = Buffer.alloc(size);
  bytes.write('ftyp', 4);
  return bytes;
}
const cred = { uin: '10001', skey: 'synthetic', pskey: 'synthetic' };
const ack = (data: object) => new Response(JSON.stringify({ ret: 0, data: { ret: 0, ...data } }));
function params(bytes: Uint8Array | string): GroupAlbumVideoUpload {
  return {
    groupId: '10003',
    albumId: 'synthetic-album',
    albumName: '合成相册',
    fileName: 'video.mp4',
    video: bytes,
    cover: Uint8Array.of(255, 216, 255, 217),
    durationMs: 9000000,
    width: 160,
    height: 90,
    beforeSend: () => {},
  };
}
describe('群相册视频分片与封面关联', () => {
  it('双层业务码和完成标志独立检查，封面不要求 photoInfo', () => {
    expect(() => parseAlbumVideoAck({ ret: 0, data: { ret: 1 } })).toThrow();
    expect(() => parseAlbumVideoAck({ ret: 0, data: {} })).toThrow();
    expect(parseAlbumVideoAck({ ret: 0, data: { ret: 0, flag: 1 } })).toEqual({ ret: 0, flag: 1 });
  });
  it('不限制文件大小与时长，按服务器分片并用真实视频 ID 绑定封面', async () => {
    const size = 2 * 1024 * 1024 + 16;
    const bodies: Array<Record<string, unknown>> = [];
    const urls: string[] = [];
    let uploadOffset = 0;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (url.includes('FileBatchControl')) {
        const control = (body.control_req as Array<Record<string, unknown>>)[0]!;
        return control.appid === 'video_qun'
          ? ack({ flag: 0, offset: 0, slice_size: 1024 * 1024, session: 'synthetic-session' })
          : ack({ flag: 1 });
      }
      expect(body.offset).toBe(uploadOffset);
      expect(Buffer.from(String(body.data), 'base64').length).toBeLessThanOrEqual(1024 * 1024);
      expect(body).not.toHaveProperty('token');
      uploadOffset = Number(body.end);
      return ack({
        flag: uploadOffset === size ? 1 : 0,
        ...(uploadOffset === size ? { biz: { sVid: 'synthetic-video-id' } } : {}),
      });
    });
    vi.stubGlobal('fetch', fetch);
    const dir = await mkdtemp(join(tmpdir(), 'weq-video-test-'));
    try {
      const path = join(dir, 'video.mp4');
      await writeFile(path, video(size));
      expect(await uploadGroupAlbumVideo(cred, params(path))).toEqual({
        videoId: 'synthetic-video-id',
      });
      expect(uploadOffset).toBe(size);
      const last = (bodies.at(-1)!.control_req as Array<Record<string, unknown>>)[0]!;
      expect(last.biz_req).toMatchObject({
        sAlbumID: 'synthetic-album',
        stExtendInfo: { mapParams: { vid: 'synthetic-video-id' } },
      });
      expect(urls.filter((url) => url.includes('FileUploadVideo?'))).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('写请求超时或中间片失败不重放，也不把视频传输成功当成相册发布成功', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(ack({ flag: 1, biz: { sVid: 'synthetic-id' } }))
      .mockRejectedValueOnce(new Error('网络断开'));
    vi.stubGlobal('fetch', fetch);
    await expect(uploadGroupAlbumVideo(cred, params(video(16)))).rejects.toThrow(
      '封面关联尚未确认',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('每个网络请求前重核账号，切换后不继续封面写入', async () => {
    const p = params(video(16));
    let switched = false;
    p.beforeSend = () => {
      if (switched) throw new Error('切换');
    };
    const fetch = vi.fn(async () => {
      switched = true;
      return ack({ flag: 1, biz: { sVid: 'synthetic-id' } });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(uploadGroupAlbumVideo(cred, p)).rejects.toThrow('封面关联尚未确认');
    expect(fetch).toHaveBeenCalledOnce();
  });
});
