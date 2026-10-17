import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { collectQzone, writeQzone, type QzoneExportDeps } from '../src/account/export/qzone_export';
import type { QzoneEmotion } from '../src/account/web/qzone';

const post: QzoneEmotion = {
  tid: 'synthetic-post',
  time: Date.parse('2026-10-16T17:02:03Z') / 1000,
  forwardNum: 3,
  content: '摘要',
  contentTruncated: true,
  imageTotal: 2,
  imageReturned: 1,
  images: ['https://qpic.cn/one.jpg'],
  videos: [],
  isPrivate: false,
  commentNum: 0,
  repost: {
    tid: 'original',
    uin: '10002',
    nickname: '原作者',
    content: '原帖摘要',
    contentTruncated: true,
    images: [],
    videos: [],
  },
};
let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

function deps(): QzoneExportDeps {
  return {
    fetchMsgList: async () => ({ total: 1, list: [structuredClone(post)] }),
    fetchPostDetail: async () => ({
      post,
      content: '完整正文',
      contentHasMore: false,
      contentComplete: true,
      repost: { ...post.repost!, content: '完整原帖' },
      repostHasMore: false,
      repostComplete: true,
    }),
    fetchPostImages: async () => ['https://qpic.cn/one.jpg', 'https://qpic.cn/two.jpg'],
  };
}

it('导出补取截断正文、准确原帖与缺图，HTML/TXT 保留转发原文', async () => {
  const data = await collectQzone({ targetUin: '10001', onProgress: () => {} }, deps());
  expect(data.rows[0]).toMatchObject({
    content: '完整正文',
    contentTruncated: false,
    images: ['https://qpic.cn/one.jpg', 'https://qpic.cn/two.jpg'],
    repost: { content: '完整原帖', contentTruncated: false },
    contentEvidence: { body: 'complete', images: 'expanded' },
  });
  root = await mkdtemp(join(tmpdir(), 'weq-qzone-completion-'));
  for (const format of ['html', 'txt'] as const) {
    const outputPath = join(root, `posts.${format}`);
    await writeQzone(format, data, {
      name: '测试空间',
      targetUin: '10001',
      outputPath,
      localMedia: false,
    });
    const content = await readFile(outputPath, 'utf8');
    expect(content).toContain('完整正文');
    expect(content).toContain('完整原帖');
    expect(content).toContain('原作者');
    expect(content).toContain('转发 3');
    expect(content).toContain('2026-10-17 01:02:03');
  }
});

it('补全失败或没有完整标记时不把摘要标成全文，不覆盖其它原帖', async () => {
  const source = deps();
  source.fetchPostDetail = async () => ({
    post,
    content: '更长的观察正文',
    contentHasMore: null,
    contentComplete: false,
    repost: { ...post.repost!, tid: 'unrelated', content: '错误原文' },
    repostHasMore: false,
    repostComplete: true,
  });
  source.fetchPostImages = async () => {
    throw new Error('附图读取失败');
  };
  const data = await collectQzone({ targetUin: '10001', onProgress: () => {} }, source);
  expect(data.rows[0]).toMatchObject({
    contentTruncated: true,
    repost: { content: '原帖摘要' },
    contentEvidence: { body: 'truncated', images: 'failed' },
  });
});

it('取消后不继续附图请求', async () => {
  const source = deps();
  const control = new AbortController();
  source.fetchPostDetail = async () => {
    control.abort();
    throw new Error('取消');
  };
  const fetchImages = vi.fn();
  source.fetchPostImages = fetchImages;
  await expect(
    collectQzone({ targetUin: '10001', signal: control.signal, onProgress: () => {} }, source),
  ).rejects.toBeDefined();
  expect(fetchImages).not.toHaveBeenCalled();
});

it('转发借用的原帖附图只补入原帖，不错误归到转发者', async () => {
  const source = deps();
  source.fetchMsgList = async () => ({
    total: 1,
    list: [
      {
        ...structuredClone(post),
        contentTruncated: false,
        repost: { ...post.repost!, contentTruncated: false, images: [...post.images] },
      },
    ],
  });
  const data = await collectQzone({ targetUin: '10001', onProgress: () => {} }, source);
  expect(data.rows[0]?.images).toEqual(post.images);
  expect(data.rows[0]?.repost?.images).toEqual([
    'https://qpic.cn/one.jpg',
    'https://qpic.cn/two.jpg',
  ]);
});
