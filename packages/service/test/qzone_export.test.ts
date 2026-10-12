/**
 * QQ 空间说说导出的多格式契约：一次拉取（{@link collectQzone}）供各格式共用，
 * HTML 必须带上评论区 / 点赞名单与展开按钮。
 *
 * 回归点：早先按格式各拉一次、只让第一份格式携带互动与配图，结果排在后面的 HTML
 * 只剩「💬 N 条评论」计数，评论区和点赞名单整个丢掉（「导出的 html 不对」）。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectQzone, writeQzone } from '../src/account/export/qzone_export';
import type { QzoneEmotion, QzoneMsgListResult } from '../src/account/web/qzone';
import type { QzoneComment, QzoneLike } from '../src/account/web/qzone_interaction';

function emotion(over: Partial<QzoneEmotion> = {}): QzoneEmotion {
  return {
    tid: 'tid-1',
    content: '随便说点什么',
    time: 1_700_000_000,
    commentNum: 0,
    isPrivate: false,
    images: [],
    videos: [],
    ...over,
  };
}

function comment(over: Partial<QzoneComment>): QzoneComment {
  return {
    id: '1',
    uin: '10001',
    nickname: '评论者',
    content: '评论内容',
    time: 1_700_000_100,
    isReply: false,
    images: [],
    ...over,
  };
}

function like(uin: string): QzoneLike {
  return { uin, nickname: `用户${uin}`, time: 0, customItemId: '' };
}

describe('collectQzone / writeQzone', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qzone-export-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** 4 条一级评论（超出默认展开的 3 条）+ 1 条回复 + 12 个赞（超出默认 10 人）。 */
  const roots = [1, 2, 3, 4].map((n) =>
    comment({ id: String(n), uin: `1000${n}`, nickname: `评论者${n}`, content: `第 ${n} 条评论` }),
  );
  const reply = comment({
    id: '1_r_9_10009',
    uin: '10009',
    nickname: '回复者',
    content: '回复内容',
    isReply: true,
    parentCommentId: '1',
    replyToUin: '10001',
    replyToNickname: '评论者1',
  });
  const likes = Array.from({ length: 12 }, (_, i) => like(String(20000 + i)));

  it('一次拉取，json / html 共用同一份互动数据', async () => {
    let msgListCalls = 0;
    const deps = {
      fetchMsgList: async (): Promise<QzoneMsgListResult> => {
        msgListCalls += 1;
        return { total: 1, list: [emotion({ commentNum: 4 })] };
      },
      fetchInteractions: async () => new Map([['tid-1', { comments: [...roots, reply], likes }]]),
    };

    const data = await collectQzone(
      { targetUin: '10000', includeInteraction: true, onProgress: () => {} },
      deps,
    );
    expect(msgListCalls).toBe(1);
    expect(data.rows[0]?.comments).toHaveLength(5);
    expect(data.rows[0]?.likes).toHaveLength(12);
    expect(data.interaction).toMatchObject({ posts: 1, comments: 5, likes: 12, failed: false });
    expect(data.rows[0]?.interactionCoverage).toEqual({
      comments: 'observed',
      replies: 'observed',
      likes: 'observed',
    });

    const jsonPath = join(dir, 'qzone.json');
    const htmlPath = join(dir, 'qzone.html');
    const write = { name: 'H3CoF6', targetUin: '10000', localMedia: true };
    await writeQzone('json', data, { ...write, outputPath: jsonPath });
    await writeQzone('html', data, { ...write, outputPath: htmlPath });

    const json = JSON.parse(await readFile(jsonPath, 'utf8')) as Array<{
      comments: unknown[];
      likes: unknown[];
    }>;
    expect(json[0]?.comments).toHaveLength(5);
    expect(json[0]?.likes).toHaveLength(12);

    const html = await readFile(htmlPath, 'utf8');
    expect(html).toContain('<section class=\x22comments\x22>');
    expect(html).toContain('第 1 条评论');
    expect(html).toContain('回复内容');
    expect(html).toContain('点赞名单已取得，完整性未核验');
    expect(html).toContain('查看已取得的 5 条评论');
    expect(html).toContain('comments-toggle'); // 4 条一级评论 → 「查看全部 4 条评论」
    expect(html).toContain('<span class=\x22likes\x22>');
    expect(html).toContain('like-toggle'); // 12 人赞 → 「等 12 人赞了」
  });

  it('records a failed likes top-up as incomplete interaction coverage', async () => {
    const deps = {
      fetchMsgList: async (): Promise<QzoneMsgListResult> => ({ total: 1, list: [emotion()] }),
      fetchInteractions: async () =>
        new Map([['tid-1', { comments: [], likes: [], coverage: 'observed' as const }]]),
      fetchLikes: async () => {
        throw new Error('likes unavailable');
      },
    };
    const data = await collectQzone(
      { targetUin: '10000', includeInteraction: true, onProgress: () => {} },
      deps,
    );
    expect(data.interaction).toMatchObject({ failed: true, likesFailed: 1 });
    expect(data.rows[0]?.interactionCoverage).toEqual({
      comments: 'observed',
      replies: 'observed',
      likes: 'failed',
    });
    expect(data.interaction?.coverage?.likes.failed).toBe(1);
  });

  it('does not treat an array-only empty result as verified completeness', async () => {
    const deps = {
      fetchMsgList: async (): Promise<QzoneMsgListResult> => ({ total: 1, list: [emotion()] }),
      fetchInteractions: async () =>
        new Map([['tid-1', { comments: [], likes: [], coverage: 'unobserved' as const }]]),
      fetchLikes: async () => [],
    };
    const data = await collectQzone(
      { targetUin: '10000', includeInteraction: true, onProgress: () => {} },
      deps,
    );
    expect(data.rows[0]?.interactionCoverage).toEqual({
      comments: 'unobserved',
      replies: 'unobserved',
      likes: 'unobserved',
    });
  });
  it('can retrieve verified zero likes independently when comments are unavailable', async () => {
    const data = await collectQzone(
      { targetUin: '10000', includeInteraction: true, onProgress: () => {} },
      {
        fetchMsgList: async () => ({ total: 1, list: [emotion()] }),
        fetchLikesResult: async () => ({
          likes: [],
          reportedTotal: 0,
          coverage: 'complete',
          reason: 'matched-count',
        }),
      },
    );
    expect(data.rows[0]?.interactionCoverage).toEqual({
      comments: 'unavailable',
      replies: 'unavailable',
      likes: 'complete',
    });
    expect(data.rows[0]?.likeCoverageEvidence).toEqual({
      reportedTotal: 0,
      receivedUnique: 0,
      reason: 'matched-count',
    });
  });

  it('retains HTML observations when a structured partial list disagrees', async () => {
    const data = await collectQzone(
      { targetUin: '10000', includeInteraction: true, onProgress: () => {} },
      {
        fetchMsgList: async () => ({ total: 1, list: [emotion()] }),
        fetchInteractions: async () =>
          new Map([
            [
              'tid-1',
              {
                comments: roots,
                likes: [like('20001'), like('20002')],
                fieldCoverage: {
                  comments: 'observed' as const,
                  replies: 'unobserved' as const,
                  likes: 'observed' as const,
                },
              },
            ],
          ]),
        fetchLikesResult: async () => ({
          likes: [like('20001')],
          reportedTotal: 1,
          coverage: 'complete',
          reason: 'matched-count',
        }),
      },
    );
    expect(data.rows[0]?.likes).toHaveLength(2);
    expect(data.rows[0]?.comments).toHaveLength(4);
    expect(data.rows[0]?.interactionCoverage).toEqual({
      comments: 'observed',
      replies: 'unobserved',
      likes: 'observed',
    });
    expect(data.rows[0]?.likeCoverageEvidence?.reason).toBe('observations-conflict');
  });

  it('continues independent likes after a comments transport failure without erasing body', async () => {
    const data = await collectQzone(
      { targetUin: '10000', includeInteraction: true, onProgress: () => {} },
      {
        fetchMsgList: async () => ({ total: 1, list: [emotion()] }),
        fetchInteractions: async () => {
          throw new Error('comments source unavailable');
        },
        fetchLikesResult: async () => ({
          likes: [like('20001')],
          reportedTotal: 1,
          coverage: 'complete',
          reason: 'matched-count',
        }),
      },
    );
    expect(data.rows[0]?.content).toBe('随便说点什么');
    expect(data.rows[0]?.interactionCoverage).toEqual({
      comments: 'failed',
      replies: 'failed',
      likes: 'complete',
    });
    expect(data.rows[0]?.likes).toHaveLength(1);
    expect(data.interaction?.failed).toBe(true);
  });

  it('does not report empty replies as observed just because comments were present', async () => {
    const data = await collectQzone(
      { targetUin: '10000', includeInteraction: true, onProgress: () => {} },
      {
        fetchMsgList: async () => ({ total: 1, list: [emotion()] }),
        fetchInteractions: async () =>
          new Map([
            [
              'tid-1',
              {
                comments: roots,
                likes: [],
                fieldCoverage: {
                  comments: 'observed' as const,
                  replies: 'unobserved' as const,
                  likes: 'unobserved' as const,
                },
              },
            ],
          ]),
      },
    );
    expect(data.rows[0]?.interactionCoverage).toEqual({
      comments: 'observed',
      replies: 'unobserved',
      likes: 'unobserved',
    });
  });
  it('forwards raw interaction captures separately before projecting coverage', async () => {
    const captures: Array<{ kind: string; tid?: string; response: string }> = [];
    await collectQzone(
      {
        targetUin: '10000',
        includeInteraction: true,
        onProgress: () => {},
        onRawInteraction: async (capture) => {
          captures.push(capture);
        },
      },
      {
        fetchMsgList: async () => ({ total: 1, list: [emotion()] }),
        fetchInteractions: async (_uin, _targets, _signal, captureRaw) => {
          await captureRaw?.('synthetic-feed-response');
          return new Map();
        },
        fetchLikesResult: async (_uin, _tid, _signal, captureRaw) => {
          await captureRaw?.('synthetic-like-response');
          return { likes: [], reportedTotal: 0, coverage: 'complete', reason: 'matched-count' };
        },
      },
    );
    expect(captures).toEqual([
      { kind: 'feeds', response: 'synthetic-feed-response' },
      { kind: 'likes', tid: 'tid-1', response: 'synthetic-like-response' },
    ]);
  });
});
