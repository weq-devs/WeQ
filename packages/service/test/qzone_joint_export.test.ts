import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';
import type { QzoneEmotion } from '../src/account/web/qzone';
import type { QzoneAlbumPhoto } from '../src/account/web/qzone_album';
import { QzoneMediaStore } from '../src/account/export/qzone_media_store';

const state = vi.hoisted(() => ({ urls: [] as string[], different: false, fail: false }));
vi.mock('../src/account/media_url', async (original) => ({
  ...(await original<typeof import('../src/account/media_url')>()),
  downloadUrlToFile: async (url: string, destination: string) => {
    state.urls.push(url);
    if (state.fail) return { ok: false, reason: '合成下载失败' };
    const bytes = Buffer.from(
      `89504e470d0a1a0a${state.different && url.includes('other') ? 'ff' : '00'}`,
      'hex',
    );
    writeFileSync(destination, bytes);
    return {
      ok: true,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: 'image/png',
    };
  },
}));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'weq-qzone-joint-'));
  state.urls = [];
  state.different = false;
  state.fail = false;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const image = 'https://synthetic.invalid/image.png';
const post: QzoneEmotion = {
  tid: 'post-a',
  content: '合成说说',
  time: 100,
  commentNum: 0,
  isPrivate: false,
  images: [image],
  videos: [],
};
const photo = (url = image): QzoneAlbumPhoto => ({
  id: 'photo-a',
  name: '合成图片',
  desc: '',
  url,
  thumbUrl: '',
  uploadTime: 100,
  isVideo: false,
  picKey: '',
  width: 1,
  height: 1,
});
async function run(
  opts: { posts?: boolean; otherUrl?: string; repeats?: boolean; video?: boolean } = {},
) {
  const fetchMsgList = vi.fn(async () => ({ list: [structuredClone(post)], total: 1 }));
  const fetchAlbumPage = vi.fn(async () => ({
    albums: [
      {
        id: 'album-a',
        name: '合成相册',
        mediaCount: 1,
        coverUrl: '',
        desc: '',
        createTime: 1,
        priv: 0,
      },
    ],
    total: 1,
    nextOffset: null,
    warning: null,
  }));
  const manager = new ExportTaskManager({} as MsgService, join(root, 'cache'), {
    qzone: {
      fetchMsgList,
      fetchAlbumPage,
      fetchAlbumPhotos: async () => ({
        photos: [
          {
            ...photo(opts.otherUrl),
            isVideo: Boolean(opts.video),
            picKey: opts.video ? 'video-key' : '',
          },
        ],
        totalInAlbum: opts.repeats ? 100 : 1,
      }),
      fetchAlbumVideo: async () => '',
    },
  });
  const id = await manager.startTask({
    savePolicy: { mode: 'preset', directory: root },
    qzone: true,
    qzonePosts: opts.posts !== false,
    qzoneAlbums: true,
    kind: 'c2c',
    conv: '20002',
    name: '合成空间',
    format: 'html',
    formats: ['json', 'html'],
    total: 0,
    media: {
      exportMedia: true,
      completeMessages: false,
      completeMedia: false,
      downloadVideo: false,
      downloadFile: false,
      downloadPtt: false,
      transcribeVoice: false,
    },
  });
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toMatch(/completed|failed/));
  if (manager.getTask(id)?.status === 'completed')
    await vi.waitFor(() => expect(manager.getTask(id)?.save?.status).toBe('saved'));
  return { task: manager.getTask(id)!, manager, fetchMsgList, fetchAlbumPage };
}
it('同一任务导出别人空间的说说与相册，相同 URL 只下载一次并引用同一文件', async () => {
  const { task, fetchAlbumPage } = await run();
  expect(task.status).toBe('completed');
  expect(fetchAlbumPage).toHaveBeenCalledWith('20002', 0, expect.any(AbortSignal));
  expect(state.urls).toEqual([image]);
  const files = readdirSync(join(task.bundleDir!, 'media'));
  expect(files).toHaveLength(1);
  const albums = JSON.parse(readFileSync(join(task.bundleDir!, 'albums', 'index.json'), 'utf8'));
  expect(albums.albums[0].media[0].localPath).toBe(`media/${files[0]}`);
  const posts = JSON.parse(readFileSync(join(task.bundleDir!, '合成空间.json'), 'utf8'));
  expect(posts[0].localMedia[image]).toBe(albums.albums[0].media[0].localPath);
  expect(readFileSync(join(task.bundleDir!, 'albums', 'index.html'), 'utf8')).toContain(
    `../media/${files[0]}`,
  );
  expect(readFileSync(join(task.bundleDir!, '合成空间.html'), 'utf8')).toContain(
    `media/${files[0]}`,
  );
});
it('不同 URL 的相同内容只保留一份文件，不按图片名字或 URL 路径猜相同', async () => {
  const { task } = await run({ otherUrl: 'https://synthetic.invalid/other.png?quality=original' });
  expect(state.urls).toHaveLength(2);
  expect(readdirSync(join(task.bundleDir!, 'media'))).toHaveLength(1);
});
it('原图与缩略图实际字节不同就保留两份，不因相似 URL 而错误合并', async () => {
  state.different = true;
  const { task } = await run({ otherUrl: 'https://synthetic.invalid/other.png?quality=thumb' });
  expect(readdirSync(join(task.bundleDir!, 'media'))).toHaveLength(2);
});
it('只选相册不读取或生成说说，媒体仍保存到同一个空间包', async () => {
  const { task, fetchMsgList } = await run({ posts: false });
  expect(task.status).toBe('completed');
  expect(fetchMsgList).not.toHaveBeenCalled();
  expect(readdirSync(join(task.bundleDir!, 'albums'))).toContain('index.json');
  expect(readdirSync(task.bundleDir!)).not.toContain('合成空间.json');
  expect(task.stages.find((stage) => stage.key === 'message')?.status).toBe('skipped');
});
it('相册分页重复会保留已取得的内容和失败清单，不反复下载或冒称完整', async () => {
  const { task } = await run({ repeats: true });
  expect(task.status).toBe('completed');
  expect(task.stages.find((stage) => stage.key === 'file')?.failed).toBe(1);
  expect(state.urls).toEqual([image]);
});
it('失败下载不写入可复用池，后续相册允许重试', async () => {
  const media = new QzoneMediaStore(join(root, 'media'));
  state.fail = true;
  expect((await media.save(image, 'image')).ok).toBe(false);
  state.fail = false;
  expect((await media.save(image, 'image')).ok).toBe(true);
  expect(state.urls).toHaveLength(2);
});
it('相册视频仅能取得封面时保留复用图片，但不计为完整视频', async () => {
  const { task } = await run({ video: true });
  const albums = JSON.parse(readFileSync(join(task.bundleDir!, 'albums', 'index.json'), 'utf8'));
  expect(albums.albums[0].media[0]).toMatchObject({
    downloadedAs: 'image',
    error: '视频本体不可用，已保留封面。',
  });
  expect(task.stages.find((stage) => stage.key === 'file')?.failed).toBe(1);
  expect(state.urls).toEqual([image]);
});
it('取消后不继续下载或创建替代媒体', async () => {
  const media = new QzoneMediaStore(join(root, 'media'));
  const controller = new AbortController();
  controller.abort();
  await expect(media.save(image, 'image', controller.signal)).rejects.toThrow();
  expect(state.urls).toHaveLength(0);
});
