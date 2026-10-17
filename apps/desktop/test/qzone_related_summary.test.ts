import { describe, expect, it } from 'vitest';
import {
  relatedPostExcerpt,
  relatedCommentTarget,
  relatedActionLine,
  type RelatedActivity,
} from '../src/renderer/src/lib/qzoneRelated';

describe('related notification excerpts', () => {
  it('resolves a reply without duplicating it as an unmatched comment', () => {
    const notice = {
      id: '1',
      replyId: '1',
      uin: '10002',
      isReply: true,
      content: '回复正文',
      images: [],
    };
    const reply = {
      id: '0_r_1_10002',
      replyId: '1',
      parentCommentId: '0',
      uin: '10002',
      isReply: true,
    };
    expect(relatedCommentTarget(notice, [{ id: '1', uin: '10002', isReply: false }, reply])).toBe(
      reply,
    );
    expect(
      relatedCommentTarget(notice, [reply, { ...reply, id: '2_r_1_10002', parentCommentId: '2' }]),
    ).toBeNull();
    expect(
      relatedCommentTarget({ ...notice, parentCommentId: '0' }, [
        reply,
        { ...reply, id: '2_r_1_10002', parentCommentId: '2' },
      ]),
    ).toBe(reply);
    const oldReply = { ...reply, id: '0_1_10002', replyId: undefined };
    expect(relatedCommentTarget(notice, [oldReply])).toBe(oldReply);
  });
  it('keeps action/comment text separate from the post excerpt', () => {
    const base: RelatedActivity = {
      kind: 'like',
      kinds: ['like'],
      action: '赞了我的说说',
      actorUin: '10002',
      actorName: '好友',
      target: '说说',
      post: null,
      comment: null,
      excerpt: '说说正文',
    };
    expect(relatedActionLine(base)).toBe('点赞了我');
    expect(
      relatedActionLine({
        ...base,
        kind: 'comment',
        comment: { id: '1', uin: '10002', isReply: true, content: '回复正文', images: [] },
      }),
    ).toBe('回复了我：回复正文');
  });
  it('uses text media placeholders and includes the forwarded original once', () => {
    expect(
      relatedPostExcerpt({
        content: '对！',
        images: ['original'],
        videos: [],
        repost: { content: '空友们看看对不对', images: ['original', 'other'], videos: [] },
      }),
    ).toBe('对！[转发：空友们看看对不对[图片][图片]]');
  });
  it('deduplicates a forwarded video by exact media identity', () => {
    expect(
      relatedPostExcerpt({
        content: '转发',
        images: [],
        videos: [{ videoId: 'one' }],
        repost: { content: '原文', images: [], videos: [{ videoId: 'one' }] },
      }),
    ).toBe('转发[转发：原文[视频]]');
  });
  it('truncates by code point without splitting a surrogate pair', () => {
    const value = relatedPostExcerpt({ content: '😀'.repeat(200), images: [], videos: [] }, 20);
    expect([...value]).toHaveLength(20);
    expect(value).toBe(`${'😀'.repeat(19)}…`);
  });
  it('formats mentions as visible nicknames instead of identity markup', () => {
    expect(
      relatedPostExcerpt({ content: '@{uin:10001,nick:测试用户} 看看', images: [], videos: [] }),
    ).toBe('@测试用户 看看');
  });
});
