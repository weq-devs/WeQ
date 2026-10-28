/**
 * 空友爱看（推荐域 3）协议离线单测 —— 不联网，全部走 mock 的 gotrpc 网关。
 *
 * 重点覆盖三处容易回归的地方：游标跨页锚点（广告项不能当锚）、
 * 身份整体透传（不接受调用方另造 union_id）、写操作缺回执不得当成功。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeBkn, type WebCredential } from '../src/account/web/credential';
import * as publicQzone from '../src/account/web/qzone_public';

vi.mock('../src/account/web/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/account/web/http')>()),
  webRequestJson: vi.fn(),
}));

const { webRequestJson } = await import('../src/account/web/http');
const query = vi.mocked(webRequestJson);

const CREDENTIAL: WebCredential = {
  uin: '10001',
  skey: 'synthetic-skey',
  pskey: 'synthetic-pskey',
};
const UNION = {
  uf_key: 'feed-1',
  ugc_id: '9007199254740999',
  feed_id: 'feed-id',
  ext_ids: [{ numeric: '9007199254740999' }],
};
const FEED = {
  cell_common: { union_id: UNION, feed_type: 1, domain_type: 3, cur_like_key: 'like-key' },
  cell_feed_transfer: { opaque: 'transfer' },
  cell_user_info: { user: { uid: 'author-uid', uin: '20002', nick: '作者' } },
  cell_unknown: { keep: true },
};
const USER = { uin: '10001', uid: 'self-uid', nick: '我' };
const COMMENT = {
  id: 'comment-1',
  user: { uin: '20002', uid: 'comment-uid', nick: '' },
  reply_attach_info: 'reply-first',
  opaque: true,
};
const REPLY = { id: 'reply-1', user: { uin: '30003', uid: 'reply-uid', nick: '' } };
const BASE_PARAMS = { union_id: UNION, cell_feed_transfer: FEED.cell_feed_transfer };

/** 让本条用例后续的每一次调用都返回同一个成功信封（beforeEach 会重置）。 */
function ok(data: Record<string, unknown>) {
  return query.mockResolvedValue({ retcode: 0, data });
}

function callOf(index = 0) {
  const [url, init] = query.mock.calls[index]!;
  return {
    url,
    method: init.method,
    headers: init.headers ?? {},
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  };
}

beforeEach(() => query.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('gotrpc 信封', () => {
  it('用 h5 网关 + 当前账号 g_tk，并把 oidb 命令号放进请求头', async () => {
    ok({ results: [{ uin: '10001', entrances: { can_upvote: true } }] });
    await publicQzone.getQzonePublicCapabilities(CREDENTIAL);

    const call = callOf();
    // 断言用 computeBkn 现算，别把 hash 结果抄成字面量。
    expect(call.url).toBe(
      'https://h5.qzone.qq.com/http2rpc/gotrpc/v1/trpc.public_qzone.entrance_ctrl.EntranceCtrl/BatchEntranceWhitelist' +
        `?g_tk=${computeBkn(CREDENTIAL.pskey)}`,
    );
    expect(call.method).toBe('POST');
    expect(call.headers['x-oidb']).toBe(
      JSON.stringify({ uint32_command: '0x9741', uint32_service_type: '0' }),
    );
    expect(call.headers['x-web-qua']).toBe('V1_HT5_QZ_9.9.32_001_IDC_B');
    expect(call.headers.Referer).toBe('https://h5.qzone.qq.com/pc-qzone/index.html');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.body).toEqual({ uins: ['10001'], entrance_types: [1, 15] });
  });

  it.each([
    ['非对象响应', null],
    ['缺 data', { retcode: 0 }],
    ['data 不是对象', { retcode: 0, data: [] }],
    ['retcode 非零', { retcode: 4003, message: 'need login' }],
  ])('%s 都抛错，不当成功', async (_name, response) => {
    query.mockResolvedValueOnce(response);
    await expect(publicQzone.getQzonePublicFeedDetail(CREDENTIAL, FEED)).rejects.toThrow(
      /GetFeedDetail/,
    );
  });

  it('票据类错码抛 WebAuthError，其余错码抛普通 Error', async () => {
    query.mockResolvedValueOnce({ retcode: -10000, message: '使用人数过多' });
    await expect(publicQzone.getQzonePublicComments(CREDENTIAL, FEED, 'c')).rejects.toMatchObject({
      name: 'WebAuthError',
      code: -10000,
    });
    query.mockResolvedValueOnce({ retcode: 403, message: 'denied' });
    const error = await publicQzone
      .getQzonePublicComments(CREDENTIAL, FEED, 'c')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).not.toBe('WebAuthError');
  });

  it('入口查询只取当前账号那一项', async () => {
    ok({
      results: [
        { uin: '20002', entrances: { can_upvote: false } },
        { uin: '10001', entrances: { public_qzone_entrance_switch: true, can_upvote: true } },
      ],
    });
    await expect(publicQzone.getQzonePublicCapabilities(CREDENTIAL)).resolves.toEqual({
      public_qzone_entrance_switch: true,
      can_upvote: true,
    });
    ok({ results: [{ uin: '20002', entrances: {} }] });
    await expect(publicQzone.getQzonePublicCapabilities(CREDENTIAL)).rejects.toThrow(/entrances/);
  });
});

describe('推荐流分页', () => {
  it('短页与纯广告页都按服务端 has_more 续页，锚点沿用最近一条非广告动态', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(12345);
    const ad = { cell_common: { feed_type: 3, union_id: { uf_key: 'ad' } } };
    query
      .mockResolvedValueOnce({
        retcode: 0,
        data: { feeds: [{ feed: FEED }], has_more: true, attach_info: 'page-2', extra: 'keep' },
      })
      .mockResolvedValueOnce({
        retcode: 0,
        data: { feeds: [{ feed: ad }], has_more: true, attach_info: 'page-3' },
      })
      .mockResolvedValueOnce({ retcode: 0, data: { feeds: [], has_more: false } });

    const first = await publicQzone.getQzonePublicFeeds(CREDENTIAL);
    expect(first).toMatchObject({ feeds: [FEED], has_more: true, extra: 'keep' });
    expect(callOf(0).body).toEqual({ refresh_id: '10001_12345' });

    const second = await publicQzone.getQzonePublicFeeds(CREDENTIAL, first.next_cursor!);
    expect(callOf(1).body).toEqual({
      refresh_id: '10001_12345',
      attach_info: 'page-2',
      last_client_feed_union_id: UNION,
    });

    const last = await publicQzone.getQzonePublicFeeds(CREDENTIAL, second.next_cursor!);
    expect(callOf(2).body).toEqual({
      refresh_id: '10001_12345',
      attach_info: 'page-3',
      last_client_feed_union_id: UNION,
    });
    expect(last).toEqual({ feeds: [], has_more: false, next_cursor: null });
  });

  it('保留未知 cell 字段，但不用它们当分页锚点', async () => {
    const unknown = { cell_common: { feed_type: 4 }, cell_unknown: { keep: true } };
    ok({ feeds: [{ feed: FEED }, { feed: unknown }], has_more: true, attach_info: 'next' });
    const first = await publicQzone.getQzonePublicFeeds(CREDENTIAL);
    expect(first.feeds).toEqual([FEED, unknown]);

    ok({ feeds: [{ feed: unknown }], has_more: true, attach_info: 'after-unknown' });
    const next = await publicQzone.getQzonePublicFeeds(CREDENTIAL, first.next_cursor!);
    ok({ feeds: [], has_more: false });
    await publicQzone.getQzonePublicFeeds(CREDENTIAL, next.next_cursor!);
    expect(callOf(2).body.last_client_feed_union_id).toEqual(UNION);
  });

  it('畸形或跨账号游标在网络请求前就被拒', async () => {
    ok({ feeds: [{ feed: FEED }], has_more: true, attach_info: 'next' });
    const first = await publicQzone.getQzonePublicFeeds(CREDENTIAL);
    query.mockClear();

    const other: WebCredential = { ...CREDENTIAL, uin: '20002' };
    for (const cursor of [
      '',
      '!',
      'a'.repeat(65537),
      Buffer.from('{}').toString('base64url'),
      first.next_cursor!,
    ]) {
      await expect(publicQzone.getQzonePublicFeeds(other, cursor)).rejects.toThrow(/cursor/);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { feeds: [], has_more: true },
    { feeds: [{ feed: null }], has_more: false },
    { feeds: null, has_more: false },
    { feeds: [], has_more: 1 },
  ])('分页响应异常要报错（%j）', async (data) => {
    ok(data);
    await expect(publicQzone.getQzonePublicFeeds(CREDENTIAL)).rejects.toThrow(
      /GetPublicRecomFeeds/,
    );
  });
});

describe('详情 / 评论 / 回复', () => {
  it('详情、评论、回复各自保留上游字段与独立分页状态', async () => {
    const detail = {
      feed: { feed: { ...FEED, cell_comment: { comments: [COMMENT] } } },
      attach_info: 'comments-next',
      has_more: true,
    };
    ok(detail);
    await expect(publicQzone.getQzonePublicFeedDetail(CREDENTIAL, FEED)).resolves.toEqual(detail);
    expect(callOf(0).body).toEqual({
      ...BASE_PARAMS,
      feed_action_domain_type: 3,
      from_page: 1,
    });
    expect(callOf(0).headers['x-oidb']).toBe(
      JSON.stringify({ uint32_command: '0x97b1', uint32_service_type: '1' }),
    );

    ok({ cell_comment: { comments: [COMMENT] }, attach_info: 'comments-end', has_more: false });
    await publicQzone.getQzonePublicComments(CREDENTIAL, FEED, 'comments-next');
    expect(callOf(1).body).toEqual({ ...BASE_PARAMS, attach_info: 'comments-next' });

    ok({ replys: [REPLY], reply_attach_info: 'reply-next', has_more: true });
    await publicQzone.getQzonePublicReplies(CREDENTIAL, FEED, COMMENT, '', 20);
    expect(callOf(2).body).toEqual({
      ...BASE_PARAMS,
      cur_comment: COMMENT,
      comment_attach_info: '',
      reply_attach_info: 'reply-first',
      page_size: 20,
    });

    await publicQzone.getQzonePublicReplies(CREDENTIAL, FEED, COMMENT, 'reply-next', 5);
    expect(callOf(3).body.reply_attach_info).toBe('reply-next');
    expect(callOf(3).body.page_size).toBe(5);
  });

  it('缺少 union_id 的目标在发请求前就拒掉', async () => {
    // 目标校验发生在发出请求之前：async 包装保证是 reject 而不是同步 throw。
    await expect(publicQzone.getQzonePublicFeedDetail(CREDENTIAL, {})).rejects.toThrow(/union_id/);
    await expect(
      publicQzone.getQzonePublicComments(CREDENTIAL, { cell_common: { union_id: {} } }, 'cursor'),
    ).rejects.toThrow(/union_id/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('互动写操作', () => {
  it.each([
    [true, 'Upvote', '0x9d18', 1, { upvote: { num: 1 } }],
    [false, 'Downvote', '0x9d19', 1, { upvote: { num: 0 } }],
  ] as const)('推 %s → %s', async (enable, method, command, serviceType, result) => {
    ok(result);
    await expect(publicQzone.setQzonePublicUpvote(CREDENTIAL, FEED, enable)).resolves.toEqual(
      result,
    );
    expect(callOf().url).toContain(`${method}?`);
    expect(callOf().url).toContain('trpc.public_qzone.interaction.UFOComment');
    expect(callOf().headers['x-oidb']).toBe(
      JSON.stringify({
        uint32_command: command,
        uint32_service_type: String(serviceType),
      }),
    );
    expect(callOf().body).toEqual(BASE_PARAMS);
  });

  it.each([
    [true, 'DoLike', '0x9699', 1, { like: { num: 1 } }],
    [false, 'UnLike', '0x969c', 1, { like: { num: 0 } }],
  ] as const)(
    '赞 %s → %s（与推走不同服务）',
    async (enable, method, command, serviceType, result) => {
      ok(result);
      await expect(publicQzone.setQzonePublicLike(CREDENTIAL, FEED, enable)).resolves.toEqual(
        result,
      );
      expect(callOf().url).toContain(`interaction_writer.InteractionWriter/${method}?`);
      expect(callOf().headers['x-oidb']).toBe(
        JSON.stringify({
          uint32_command: command,
          uint32_service_type: String(serviceType),
        }),
      );
      expect(callOf().body).toEqual({ ...BASE_PARAMS, like_key: 'like-key', like_type: 1 });
    },
  );

  it('评论点赞用评论自带的 like.id，回复用 like_type 3', async () => {
    ok({ like: { count: 1 } });
    await publicQzone.setQzonePublicCommentLike(
      CREDENTIAL,
      FEED,
      { ...COMMENT, like: { id: 'comment-like-key' } },
      true,
    );
    expect(callOf().body).toEqual({
      ...BASE_PARAMS,
      like_key: 'comment-like-key',
      like_type: 2,
    });

    await publicQzone.setQzonePublicCommentLike(CREDENTIAL, FEED, COMMENT, false, {
      ...REPLY,
      like: { id: 'reply-like-key' },
    });
    expect(callOf(1).body).toEqual({
      ...BASE_PARAMS,
      like_key: 'reply-like-key',
      like_type: 3,
    });

    await expect(
      publicQzone.setQzonePublicCommentLike(CREDENTIAL, FEED, COMMENT, true),
    ).rejects.toThrow(/like_key/);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('文本正文编码成单个 RichItem，富文本数组与回复身份原样透传', async () => {
    ok({ comment: COMMENT });
    await publicQzone.commentQzonePublic(CREDENTIAL, FEED, USER, '中文 & +\n第二行');
    expect(callOf().body).toEqual({
      ...BASE_PARAMS,
      comment: { user: USER, content: [{ type: 0, content: '中文 & +\n第二行' }] },
    });

    const rich = [
      { type: 0, content: '文字' },
      { type: 2, unknown: { keep: true } },
    ];
    ok({ reply: REPLY });
    await publicQzone.replyQzonePublic(CREDENTIAL, FEED, USER, COMMENT, rich);
    expect(callOf(1).body).toEqual({
      ...BASE_PARAMS,
      comment: COMMENT,
      reply: { user: USER, target_user: COMMENT.user, content: rich },
    });

    await publicQzone.replyQzonePublic(CREDENTIAL, FEED, USER, COMMENT, '回复', REPLY);
    expect((callOf(2).body.reply as Record<string, unknown>).target_user).toEqual(REPLY.user);
  });

  it('删除与转发都带上完整对象，不做二次拼装', async () => {
    ok({ unknown: 'keep' });
    await publicQzone.deleteQzonePublicComment(CREDENTIAL, FEED, COMMENT);
    expect(callOf(0).body).toEqual({ ...BASE_PARAMS, comment: COMMENT });

    await publicQzone.deleteQzonePublicReply(CREDENTIAL, FEED, COMMENT, REPLY);
    expect(callOf(1).body).toEqual({ ...BASE_PARAMS, comment: COMMENT, reply: REPLY });

    await publicQzone.forwardQzonePublicFeed(CREDENTIAL, FEED);
    expect(callOf(2).body).toEqual({ ...BASE_PARAMS, reason: '' });
    expect(callOf(2).url).toContain('/trpc.qzone.feeds_writer.FeedsWriter/ForwardFeed?');
    expect(callOf(2).headers['x-oidb']).toBe(
      JSON.stringify({ uint32_command: '0x969a', uint32_service_type: '1' }),
    );
  });

  it('关注按推荐域 uid、其他域 uin 选目标', async () => {
    ok({ ret_code: '0' });
    await publicQzone.setQzonePublicFollow(CREDENTIAL, FEED, true);
    expect(callOf(0).body).toEqual({
      follow_from_type: 1,
      target_uid: 'author-uid',
      follow_feed_id: 'feed-1',
      cell_feed_transfer: FEED.cell_feed_transfer,
    });

    const other = {
      ...FEED,
      cell_common: { ...FEED.cell_common, domain_type: 1 },
    };
    await publicQzone.setQzonePublicFollow(CREDENTIAL, other, false);
    expect(callOf(1).body.target_uin).toBe('20002');
    expect(callOf(1).url).toContain('/Unfollow?');
    expect(callOf(1).headers['x-oidb']).toBe(
      JSON.stringify({ uint32_command: '0x9d1b', uint32_service_type: '1' }),
    );

    ok({ ret_code: 403, ret_msg: 'denied' });
    await expect(publicQzone.setQzonePublicFollow(CREDENTIAL, FEED, true)).rejects.toThrow(
      'ret_code=403 denied',
    );
  });

  it('缺少操作身份时不发请求', async () => {
    await expect(publicQzone.forwardQzonePublicFeed(CREDENTIAL, {})).rejects.toThrow(/union_id/);
    await expect(
      publicQzone.setQzonePublicLike(CREDENTIAL, { cell_common: { union_id: UNION } }, true),
    ).rejects.toThrow(/like_key/);
    await expect(
      publicQzone.setQzonePublicFollow(CREDENTIAL, { cell_common: { union_id: UNION } }, true),
    ).rejects.toThrow(/uid\/uin/);
    await expect(publicQzone.replyQzonePublic(CREDENTIAL, FEED, USER, {}, 'text')).rejects.toThrow(
      /user/,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('写操作不重试，成功回执缺字段也不算成功', async () => {
    query.mockRejectedValueOnce(new Error('connection closed'));
    await expect(publicQzone.commentQzonePublic(CREDENTIAL, FEED, USER, 'text')).rejects.toThrow(
      'connection closed',
    );

    ok({});
    await expect(publicQzone.setQzonePublicLike(CREDENTIAL, FEED, true)).rejects.toThrow(
      /缺少 like/,
    );
    await expect(publicQzone.setQzonePublicUpvote(CREDENTIAL, FEED, false)).rejects.toThrow(
      /缺少 upvote/,
    );
    await expect(publicQzone.commentQzonePublic(CREDENTIAL, FEED, USER, 'text')).rejects.toThrow(
      /缺少 comment/,
    );
    await expect(
      publicQzone.replyQzonePublic(CREDENTIAL, FEED, USER, COMMENT, 'text'),
    ).rejects.toThrow(/缺少 reply/);
    expect(query).toHaveBeenCalledTimes(5);
    for (const [, init] of query.mock.calls) expect(init.retry).toBeUndefined();
  });

  it('读接口才带读重试预算', async () => {
    ok({ feeds: [], has_more: false });
    await publicQzone.getQzonePublicFeeds(CREDENTIAL);
    expect(query.mock.calls[0]![1].retry).toEqual({ maxAttempts: 2 });
  });
});
