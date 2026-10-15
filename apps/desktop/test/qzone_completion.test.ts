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
  it.each([null, false])('stops without a warning when more=%s', async (more) => {
    const read = vi.fn(async () => detail('full body', more));
    const result = await completeQzonePostText(
      source(),
      read,
      () => {},
      () => true,
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      post: { content: 'full body', contentTruncated: false },
      issue: null,
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
  it('also stops quietly when a continuing response omits its flag', async () => {
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
    ).toMatchObject({ issue: null });
    expect(read).toHaveBeenCalledTimes(2);
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
