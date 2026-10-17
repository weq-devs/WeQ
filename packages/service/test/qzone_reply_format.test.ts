import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseQzoneCommentPage,
  qzoneReplyBody,
  supplementQzoneComments,
} from '../src/account/web/qzone_comments';
import { WebQueryService } from '../src/account/web';
import type { QzoneInteraction } from '../src/account/web/qzone_interaction';
afterEach(() => vi.unstubAllGlobals());

describe('structured Qzone reply format', () => {
  it('reads structured comments without issuing any homepage feed request', async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toContain('emotion_cgi_getcmtreply_v6');
      return new Response(
        JSON.stringify({ code: 0, data: { hostUin: 10001, tid: 'post', total: 0, comments: [] } }),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const service = Object.create(WebQueryService.prototype) as WebQueryService;
    Reflect.set(service, 'creds', {
      forDomain: async () => ({ uin: '10001', skey: 'synthetic', pskey: 'synthetic' }),
    });
    expect(await service.getQzoneStructuredComments('10001', 'post')).toMatchObject({
      comments: [],
      commentCountInclusive: 0,
      fieldCoverage: { comments: 'complete', replies: 'complete', likes: 'unobserved' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not duplicate a reply when structured and HTML bodies have different recipient formatting', async () => {
    const prefix = '@{uin:10001,nick:测试用户,who:1} ';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 0,
              data: {
                hostUin: 10001,
                tid: 'post',
                total: 1,
                comments: [
                  {
                    id: 0,
                    poster: { id: 10001, name: '测试用户' },
                    content: '根评论',
                    postTime: 1,
                    extendData: { replyNum: 2 },
                    replies: [
                      {
                        id: 1,
                        poster: { id: 10002, name: '回复者' },
                        content: prefix + '回复正文',
                        postTime: 2,
                      },
                    ],
                  },
                ],
              },
            }),
          ),
      ),
    );
    const root = {
      id: '0',
      uin: '10001',
      nickname: '测试用户',
      content: '根评论',
      time: 1,
      isReply: false,
      images: [],
    };
    const reply = {
      id: '0_1_10002',
      replyId: '1',
      parentCommentId: '0',
      uin: '10002',
      nickname: '回复者',
      content: prefix + '回复正文',
      time: 2,
      isReply: true,
      images: [],
      replyToUin: '10001',
    };
    const results = new Map<string, QzoneInteraction>([
      ['post', { comments: [root, reply], likes: [] }],
    ]);
    await supplementQzoneComments(
      { uin: '10001', skey: 'synthetic', pskey: 'synthetic' },
      '10001',
      [{ tid: 'post' }],
      results,
    );
    expect(results.get('post')?.comments.filter((c) => c.isReply)).toHaveLength(1);
    expect(results.get('post')?.fieldCoverage?.replies).toBe('observed');
    expect(results.get('post')?.comments.find((c) => c.isReply)?.content).toBe('回复正文');
  });
  it('separates an automatic recipient token from the reply body', () => {
    expect(
      qzoneReplyBody('@{uin:10001,nick:测试用户,who:1} 上机第一把居然鸟了 没想到', '10001'),
    ).toEqual({ content: '上机第一把居然鸟了 没想到', recipient: '10001' });
  });
  it('does not strip an authored mention or a different recipient by guessing', () => {
    for (const content of [
      '@{uin:10001,nick:测试用户} 正文',
      '@{uin:10003,nick:其他用户,who:1} 正文',
      '正文里回复某人：内容',
    ])
      expect(qzoneReplyBody(content, '10001')).toEqual({ content });
  });
  it('preserves additional authored mentions after the automatic prefix', () => {
    expect(
      qzoneReplyBody('@{uin:10001,nick:测试用户,who:1} @{uin:10003,nick:其他用户} 看看', '10001')
        .content,
    ).toBe('@{uin:10003,nick:其他用户} 看看');
  });
  it('keeps raw reply identity and reply relationship separate from text', () => {
    const prefix = '@{uin:10001,nick:测试用户,who:1} ';
    const result = parseQzoneCommentPage(
      {
        code: 0,
        data: {
          hostUin: 10001,
          tid: 'post',
          total: 1,
          comments: [
            {
              id: 0,
              poster: { id: 10001, name: '测试用户' },
              content: prefix + '根评论原文',
              postTime: 1,
              extendData: { replyNum: 1 },
              replies: [
                {
                  id: 1,
                  poster: { id: 10002, name: '回复者' },
                  content: prefix + '回复正文',
                  postTime: 2,
                },
              ],
            },
          ],
        },
      },
      '10001',
      'post',
    );
    expect(result.comments[0]?.content).toBe(prefix + '根评论原文');
    expect(result.replies[0]).toMatchObject({
      id: '0_r_1_10002',
      replyId: '1',
      parentCommentId: '0',
      isReply: true,
      content: '回复正文',
      replyToUin: '10001',
      replyToNickname: '测试用户',
      replyToCommentId: '0',
    });
  });
});
