// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  completeQzonePostText,
  qzoneImageCompletionScope,
} from '../src/renderer/src/lib/qzoneCompletion';
import type { QzoneEmotion } from '../src/renderer/src/views/qzone_types';

const source = (): QzoneEmotion => ({
  tid: 'synthetic',
  content: 'a',
  contentTruncated: true,
  time: 1,
  commentNum: 0,
  isPrivate: false,
  images: [],
  videos: [],
});
const detail = (content: string, contentHasMore: boolean | null) => ({
  content,
  contentHasMore,
  repost: null,
  repostHasMore: null,
});

describe('visible Qzone body continuation', () => {
  it('原生正文补充直接更新原帖，不清除尚未确认的截断状态或重复拉取', async () => {
    const read = vi.fn(async () => ({
      ...detail('原生补充正文', null),
      contentSource: 'native' as const,
    }));
    const result = await completeQzonePostText(
      source(),
      read,
      () => {},
      () => true,
    );
    expect(result.post).toMatchObject({ content: '原生补充正文', contentTruncated: true });
    expect(result.issue).toContain('完整性');
    expect(read).toHaveBeenCalledOnce();
  });
  it('places borrowed original media completion in the repost scope', () => {
    const post = source();
    post.images = ['same'];
    post.repost = {
      tid: 'original',
      uin: '10002',
      nickname: '原作者',
      content: '原文',
      images: ['same'],
      videos: [],
    };
    expect(qzoneImageCompletionScope(post)).toBe('repost');
    post.images.push('own');
    expect(qzoneImageCompletionScope(post)).toBe('post');
  });
  it('never associates similar URLs or unknown media by resemblance', () => {
    const post = source();
    post.images = ['https://a.qpic.cn/image?variant=one'];
    post.repost = {
      tid: 'original',
      uin: '10002',
      nickname: '原作者',
      content: '原文',
      images: ['https://a.qpic.cn/image?variant=two'],
      videos: [],
    };
    expect(qzoneImageCompletionScope(post)).toBe('post');
    post.images = [];
    expect(qzoneImageCompletionScope(post)).toBe('post');
  });
  it.each([null, false])('未知正文标记保留未确认、明确完成才清除截断：%s', async (more) => {
    const read = vi.fn(async () => detail('full body', more));
    const result = await completeQzonePostText(
      source(),
      read,
      () => {},
      () => true,
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      post: { content: 'full body', contentTruncated: more === null },
      issue: more === null ? '正文完整性尚未确认' : null,
    });
  });
  it('automatically continues only on explicit more, replacing whole bodies in place', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(detail('ab', true))
      .mockResolvedValueOnce(detail('abc', false));
    const progress = vi.fn();
    const original = source();
    expect(await completeQzonePostText(original, read, progress, () => true)).toMatchObject({
      post: { content: 'abc', contentTruncated: false },
      issue: null,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls.map(([post]) => post.content)).toEqual(['ab', 'abc']);
    expect(original.content).toBe('a');
  });
  it('后续响应缺失完整性标记时停止循环，但保留未确认状态', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(detail('ab', true))
      .mockResolvedValueOnce(detail('abc', null));
    expect(
      await completeQzonePostText(
        source(),
        read,
        () => {},
        () => true,
      ),
    ).toMatchObject({ post: { contentTruncated: true }, issue: '正文完整性尚未确认' });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('原帖已完整而转发原文状态未知时，不误清原文截断状态', async () => {
    const post = source();
    post.contentTruncated = false;
    const original = {
      tid: 'original',
      uin: '10002',
      nickname: '原作者',
      content: '原文',
      images: [],
      videos: [],
      contentTruncated: true,
    };
    post.repost = original;
    const read = vi.fn(async () => ({
      ...detail('完整正文', false),
      repost: { ...original, content: '原文补充' },
      repostHasMore: null,
    }));
    const result = await completeQzonePostText(
      post,
      read,
      () => {},
      () => true,
    );
    expect(result.post.repost).toMatchObject({ content: '原文补充', contentTruncated: true });
    expect(result.issue).toBe('正文完整性尚未确认');
    expect(read).toHaveBeenCalledOnce();
  });
  it('stops repeated and cycling bodies without discarding the longest observed text', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(detail('abc', true))
      .mockResolvedValueOnce(detail('abcd', true))
      .mockResolvedValueOnce(detail('abc', true));
    const result = await completeQzonePostText(
      source(),
      read,
      () => {},
      () => true,
    );
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.post.content).toBe('abcd');
    expect(result.issue).toBe('正文仍被截断，接口未返回更多内容');
  });
  it('bounds continuously changing truncated responses to five reads', async () => {
    let n = 1;
    const read = vi.fn(async () => detail('a'.repeat(++n), true));
    const result = await completeQzonePostText(
      source(),
      read,
      () => {},
      () => true,
    );
    expect(read).toHaveBeenCalledTimes(5);
    expect(result.issue).toBe('正文仍被截断，已达到本轮补全上限');
  });
  it('keeps already acquired text if a later read fails', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(detail('abc', true))
      .mockRejectedValueOnce(new Error('synthetic failure'));
    expect(
      await completeQzonePostText(
        source(),
        read,
        () => {},
        () => true,
      ),
    ).toMatchObject({ post: { content: 'abc' }, issue: '全文补全失败' });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('does not make new reads after cancellation or apply a late response', async () => {
    const progress = vi.fn();
    const read = vi.fn(async () => detail('late body', true));
    await completeQzonePostText(source(), read, progress, () => false);
    expect(read).not.toHaveBeenCalled();
    let active = true;
    read.mockImplementation(async () => {
      active = false;
      return detail('late body', true);
    });
    const result = await completeQzonePostText(source(), read, progress, () => active);
    expect(result.post.content).toBe('a');
    expect(progress).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('continues an exactly matched repost independently of the root body', async () => {
    const post = source();
    post.repost = {
      tid: 'original',
      uin: '10002',
      nickname: 'fixture',
      content: 'quote',
      contentTruncated: true,
      images: [],
      videos: [],
    };
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        ...detail('a', false),
        repost: { ...post.repost, content: 'quote longer' },
        repostHasMore: true,
      })
      .mockResolvedValueOnce({
        ...detail('a', false),
        repost: { ...post.repost, content: 'quote longer full' },
        repostHasMore: false,
      });
    expect(
      await completeQzonePostText(
        post,
        read,
        () => {},
        () => true,
      ),
    ).toMatchObject({
      post: { repost: { content: 'quote longer full', contentTruncated: false } },
      issue: null,
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('does not follow or overwrite an unrelated repost', async () => {
    const post = source();
    post.repost = {
      tid: 'original',
      uin: '10002',
      nickname: 'fixture',
      content: 'quote',
      images: [],
      videos: [],
    };
    const read = vi.fn(async () => ({
      ...detail('full', false),
      repost: { ...post.repost!, tid: 'different', content: 'wrong quote' },
      repostHasMore: true,
    }));
    const result = await completeQzonePostText(
      post,
      read,
      () => {},
      () => true,
    );
    expect(result.post.repost?.content).toBe('quote');
    expect(read).toHaveBeenCalledTimes(1);
  });
});
