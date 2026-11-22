/**
 * 空友爱看（推荐域 3）投影器单测。
 *
 * 夹具逐字取自 2026-10-28 用真实账号拉到的 `GetPublicRecomFeeds` / `GetFeedDetail`
 * 响应（只删掉与断言无关的 cell、把 URL 里的签名截短），形状与线上一致：
 * 作者只有 uid、`time` 是字符串、正文在 `cell_summary.summary[]`、
 * 媒体在 `cell_media.media_items[]`（视频在 `media_items[].video`）。
 *
 * 这里只测纯投影，不发网络请求、不读真库。
 */
import { describe, expect, it } from 'vitest';
import {
  canShareQzoneFeed,
  mergePublicComments,
  projectPublicCommentsPage,
  projectPublicComment,
  projectPublicDetail,
  projectPublicFeed,
  projectPublicUpvote,
  projectPublicRepliesPage,
  projectQzoneHomeFeed,
  publicCapabilities,
  publicMediaSource,
} from '../src/renderer/src/lib/qzonePublic';

const UNION = {
  uf_key: '33333333333333333333333333333333_1783003022_643537626635633438',
  ugc_id: 'CLcCEAAYju+Z0gYiACoAMgEwQhhkNTdiZjVj',
  feed_id: 'd57bf5c48e77466aff2b0800',
  ext_ids: [],
};

const IMAGE_URL = 'https://m.qpic.cn/psc?/V53sJWnE4MdIqR49X40Y00bYbf2pyDhF/abc!/b&ek=1&kp=1';
const VIDEO_URL =
  'https://photovideo.photo.qq.com/1074_0b53uoxdsvaacyablnxbx5vdfiyehe5ab3ka.f20.mp4?dis_k=05ee';
const COVER_URL = 'https://m.qpic.cn/psc?/V10Bky8U4fXjhf/cover!/b&bo=RAbyBkQG8gYWADA!';

const FEED = {
  cell_common: {
    feed_type: 1,
    feed_sub_type: 1,
    app_id: 311,
    domain_type: 3,
    time: '1783003022',
    cur_like_key:
      'http://user.qzone.qq.com/33333333333333333333333333333333/mood/d57bf5c48e77466aff2b0800',
    union_id: UNION,
  },
  cell_feed_transfer: 'CAMaACImCiRlNDVjMDBlNi0wMDE4LTRmYzM',
  cell_user_info: {
    user: {
      nick: '示例作者',
      uid: '33333333333333333333333333333333',
      uin: '',
      portrait: 'http://qh.qlogo.cn/g?b=oidb&ek=EXAMPLEAVATARTOKEN000000000000000&s=0',
      can_follow: 1,
      isfollowed: 0,
    },
  },
  cell_summary: {
    summary: [
      {
        content: '左滑揭晓这是个什么物种[em]e400385[/em]\n来到欧洲才知道世界上有正圆形的鸽子',
        type: 0,
      },
    ],
  },
  cell_media: {
    media_items: [
      { image: { default_url: { width: 276, height: 276, url: IMAGE_URL }, photo_url: [] } },
      {
        video: {
          id: '1074_0b53uoxdsvaacyablnxbx5vdfiyehe5ab3ka',
          url: VIDEO_URL,
          width: 512,
          height: 567,
          video_time: '1000',
          cover: { default_url: { width: 512, height: 567, url: COVER_URL }, photo_url: [] },
          video_url: [{ url: { url: `${VIDEO_URL}&spec=5` }, spec: 5 }],
        },
      },
    ],
  },
  cell_like: { num: 83911, liked: false },
  cell_comment: { num: 3261, comments: [] },
  cell_foward_info: { retweet_count: 520 },
  cell_visitor: { view_num: 7769849 },
  cell_unknown: { keep: true },
};

const COMMENT = {
  id: '2',
  time: '1788785005',
  reply_num: '12',
  reply_attach_info: '{"page_num":1,"reply_next_offset":10}',
  user: {
    nick: '示例评论者',
    uid: '11111111111111111111111111111111',
    uin: '',
    portrait: 'http://qh.qlogo.cn/g?b=oidb&ek=EXAMPLEAVATAR',
  },
  content: [{ content: '感谢拉挖稀让我知道串联酒精灯的后果', type: 0 }],
  like: {
    id: 'http://user.qzone.qq.com/C4FFD5EC/311/d39de6b7deac9e6a38b50400/cmt/2',
    count: 124,
    status: 0,
  },
  replys: [
    {
      id: '1',
      time: '1792769109',
      user: { nick: '示例回复者', uid: '22222222222222222222222222222222' },
      target_user: { nick: '示例评论者', uid: '11111111111111111111111111111111' },
      content: [{ content: '回复内容', type: 0 }],
      like: { id: 'reply-like', count: 4, status: 1 },
    },
  ],
};

describe('空友 feed 投影', () => {
  it('分享使用服务端给出的原始资源，不从动态编号猜测，也不展示被禁止的入口', () => {
    const feed = {
      cell_common: FEED.cell_common,
      cell_feed_transfer: 'opaque-feed-transfer',
      cell_operation: {
        share_outside: { share_access_resource: { busi_id: 'zone', resource_id: 'entry' } },
      },
    };
    expect(canShareQzoneFeed(feed)).toBe(true);
    expect(canShareQzoneFeed({ ...feed, cell_feed_transfer: undefined })).toBe(false);
    expect(canShareQzoneFeed({ ...feed, cell_operation: {} })).toBe(false);
    expect(canShareQzoneFeed({ ...feed, cell_common: { operate_mask: 1 << 17 } })).toBe(false);
  });
  it('主页按应用识别内容类型，站外卡片与普通说说详情保持各自的有效目标', () => {
    const app = (appId: number, uin = '10002', qqUrl = 'https://example.com/post') =>
      projectQzoneHomeFeed(
        projectPublicFeed({
          ...FEED,
          cell_user_info: { user: { uin } },
          cell_common: {
            ...FEED.cell_common,
            app_id: appId,
            title: '示例标题',
            union_id: { feed_id: '122700001234567800000000' },
          },
          cell_operation: { qq_url: qqUrl },
        })!,
      );
    expect(app(311)).toMatchObject({
      type: '说说',
      detailId: '122700001234567800000000',
      href: null,
    });
    expect(app(311, '10003').detailId).toBeNull();
    expect(app(2)).toEqual({
      type: '日志',
      title: '示例标题',
      detailId: null,
      href: 'https://example.com/post',
    });
    expect(app(4).type).toBe('相册');
    expect(app(202, '10002', 'javascript:alert(1)')).toMatchObject({
      type: '分享',
      href: null,
    });
    expect(app(999).type).toBe('视频');
  });
  it('推使用 upvoted 而非 liked，读取独立人数和用户预览', () => {
    const view = projectPublicFeed({
      ...FEED,
      cell_upvote: {
        num: '199',
        upvoted: true,
        liked: false,
        upvote_mans: [
          { user: { uin: '10002', uid: 'public-uid', nick: '合成推用户' } },
          { user: { uid: 'anonymous', nick: '匿名用户', portrait: COVER_URL } },
        ],
      },
    })!;
    expect(view.upvoted).toBe(true);
    expect(view.upvote).toEqual({
      count: 199,
      upvoted: true,
      users: [
        { uin: '10002', uid: 'public-uid', nickname: '合成推用户', portrait: undefined },
        { uin: '', uid: 'anonymous', nickname: '匿名用户', portrait: COVER_URL },
      ],
    });
    expect(projectPublicUpvote(null)).toBeNull();
    expect(projectPublicUpvote({ num: 0, upvoted: false })).toEqual({
      count: 0,
      upvoted: false,
      users: [],
    });
    expect(projectPublicUpvote({ liked: true })?.upvoted).toBeNull();
    for (const num of [-1, 1.5, 'bad', undefined])
      expect(projectPublicUpvote({ num })?.count).toBeNull();
  });
  it('转发次数保留服务端的零和非零，缺失不伪装成零', () => {
    expect(
      projectPublicFeed({ ...FEED, cell_foward_info: { retweet_count: 0 } })!.forwardCount,
    ).toBe(0);
    expect(
      projectPublicFeed({ ...FEED, cell_foward_info: { retweet_count: 73 } })!.forwardCount,
    ).toBe(73);
    expect(projectPublicFeed({ ...FEED, cell_foward_info: {} })!.forwardCount).toBeNull();
  });
  it('把真实 feed 的正文、媒体、计数与身份拆出来，原始对象原样保留', () => {
    const view = projectPublicFeed(FEED)!;
    expect(view.key).toBe(UNION.uf_key);
    // 互动要整体回传，不能被投影改写。
    expect(view.feed).toBe(FEED);
    expect(view.author).toMatchObject({
      uid: '33333333333333333333333333333333',
      uin: '',
      nick: '示例作者',
      canFollow: true,
      followed: false,
    });
    expect(view.time).toBe(1783003022);
    expect(view.text).toContain('[em]e400385[/em]');
    expect(view.text).not.toContain('\n\n');
    expect(view.likeCount).toBe(83911);
    expect(view.commentCount).toBe(3261);
    expect(view.forwardCount).toBe(520);
    expect(view.viewCount).toBe(7769849);
    expect(view.liked).toBe(false);
    expect(view.upvoted).toBe(false);
    expect(view.advertisement).toBe(false);
    expect(view.actionable).toBe(true);
    expect(view.media).toHaveLength(2);
    expect(view.media[0]).toMatchObject({ kind: 'image', src: IMAGE_URL, width: 276 });
    expect(view.media[1]).toMatchObject({
      kind: 'video',
      src: VIDEO_URL,
      poster: COVER_URL,
      durationMs: 1000,
      width: 512,
      height: 567,
    });
  });

  it('缺少 union_id 的动态仍可展示，但标成不可互动', () => {
    const view = projectPublicFeed({ ...FEED, cell_common: { feed_type: 1, time: '1' } }, 3)!;
    expect(view.actionable).toBe(false);
    expect(view.key).toBe('#3');
  });

  it('feed_type 3 认作广告；缺字段一律退化成「不显示」而不是抛错', () => {
    const ad = projectPublicFeed({ cell_common: { feed_type: 3, union_id: UNION } })!;
    expect(ad.advertisement).toBe(true);
    expect(ad.media).toEqual([]);
    expect(ad.text).toBe('');
    expect(ad.likeCount).toBeNull();
    expect(ad.commentCount).toBeNull();
    expect(ad.author.nick).toBe('');
    // 完全不是对象时返回 null，调用方据此跳过。
    expect(projectPublicFeed(null)).toBeNull();
    expect(projectPublicFeed([])).toBeNull();
  });

  it('只放行 QQ 系媒体域名', () => {
    expect(publicMediaSource(IMAGE_URL)).toBe(IMAGE_URL);
    expect(publicMediaSource('//m.qpic.cn/a.png')).toBe('https://m.qpic.cn/a.png');
    expect(publicMediaSource('https://evil.example.com/a.png')).toBeNull();
    expect(publicMediaSource('javascript:alert(1)')).toBeNull();
    expect(publicMediaSource('https://user@m.qpic.cn/a.png')).toBeNull();
    expect(publicMediaSource(123)).toBeNull();
  });
});

describe('空友评论与详情投影', () => {
  it('评论带出作者、点赞、回复与续页标记', () => {
    const view = projectPublicComment(COMMENT)!;
    expect(view.id).toBe('2');
    expect(view.author.nick).toBe('示例评论者');
    expect(view.text).toBe('感谢拉挖稀让我知道串联酒精灯的后果');
    expect(view.time).toBe(1788785005);
    expect(view.likeCount).toBe(124);
    expect(view.liked).toBe(false);
    expect(view.replyCount).toBe(12);
    expect(view.replyCursor).toContain('reply_next_offset');
    expect(view.replies).toHaveLength(1);
    expect(view.replies[0]).toMatchObject({
      id: '1',
      text: '回复内容',
      likeCount: 4,
      liked: true,
    });
  });

  it('详情从 feed.feed.cell_comment 取首批评论，游标用顶层 attach_info', () => {
    const page = projectPublicDetail({
      feed: { feed: { ...FEED, cell_comment: { num: 198, comments: [COMMENT] } } },
      attach_info: 'comments-next',
      has_more: true,
    });
    expect(page.comments).toHaveLength(1);
    expect(page.cursor).toBe('comments-next');
    expect(page.hasMore).toBe(true);
  });

  it('评论续页、回复续页各自读自己的字段名', () => {
    const comments = projectPublicCommentsPage({
      cell_comment: { comments: [COMMENT] },
      attach_info: 'comments-end',
      has_more: false,
    });
    expect(comments.comments).toHaveLength(1);
    expect(comments.hasMore).toBe(false);

    const replies = projectPublicRepliesPage(
      { replys: [COMMENT.replys[0]], reply_attach_info: 'reply-next', has_more: true, total: 12 },
      'c2',
    );
    expect(replies.replies).toHaveLength(1);
    expect(replies.cursor).toBe('reply-next');
    expect(replies.total).toBe(12);
  });

  it('合并评论按 id 去重，先到的版本胜出', () => {
    const first = projectPublicComment(COMMENT)!;
    const updated = { ...first, text: '改过的' };
    expect(mergePublicComments([first], [updated])).toHaveLength(1);
    expect(mergePublicComments([first], [updated])[0]!.text).toBe(first.text);
    const extra = projectPublicComment({ ...COMMENT, id: '3' })!;
    expect(mergePublicComments([first], [extra])).toHaveLength(2);
  });
});

describe('空友入口能力', () => {
  it('只认入口开关、推权限与关注开关，其余字段不参与判定', () => {
    expect(
      publicCapabilities({
        public_qzone_entrance_switch: true,
        can_upvote: false,
        can_public_follow: true,
        unknown_flag: true,
      }),
    ).toEqual({ available: true, canUpvote: false, canFollow: true, canComment: true });
    expect(publicCapabilities(null)).toEqual({
      available: false,
      canUpvote: false,
      canFollow: false,
      canComment: false,
    });
  });
});
