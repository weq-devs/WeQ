/**
 * 年度报告「QQ 空间回忆」页的在线读能力 —— 把 main 进程手里的 WebQueryService
 * （qzone web cgi）和账号在线状态包成 @weq/service 的 {@link ReportQzoneCapability}。
 *
 * 分页复用好友空间导出的 {@link fetchQzoneEmotionRange}：同一套已抓包验证的
 * `emotion_cgi_msglist_v6` 通路、600ms 翻页间隔与按 tid 去重。离线（没有在线 QQ
 * 实例 / 没有 pid）时 canQuery 返回 false，页面在 availability 阶段就被摘掉。
 */

import {
  fetchQzoneEmotionRange,
  type ReportQzoneCapability,
  type ReportQzonePost,
  type WebQueryService,
} from '@weq/service';

/** 本模块只依赖 webQuery 的两个读方法，接口收窄方便测试与静态账号路径注入。 */
type QzoneReportWebQuery = Pick<WebQueryService, 'getQzoneMsgList' | 'getQzoneLikes'>;

export function createReportQzoneCapability(
  webQuery: QzoneReportWebQuery,
  ownUin: string | number,
  isOnline: () => boolean,
): ReportQzoneCapability {
  const uin = String(ownUin);
  return {
    canQuery: () => isOnline(),
    async fetchPosts(startSec, endSec) {
      const emotions = await fetchQzoneEmotionRange(
        {
          fetchMsgList: (targetUin, pos, num) => webQuery.getQzoneMsgList(targetUin, pos, num),
        },
        uin,
        { start: startSec || null, end: endSec || null },
        () => {},
      );
      // 分页会为早停的边界页多带出几条旧说说（导出版也在拉全后单独 filter），
      // 这里按报告窗口的半开区间 [startSec, endSec) 收口，别把去年的帖子算进来。
      return emotions
        .filter(
          (emotion) =>
            (startSec <= 0 || emotion.time >= startSec) && (endSec <= 0 || emotion.time < endSec),
        )
        .map(toReportPost);
    },
    async fetchLikeCount(tid) {
      try {
        const likes = await webQuery.getQzoneLikes(uin, tid);
        return likes.length;
      } catch {
        // qz_opcnt2 单条失败 → 点赞数据缺这一格；页面整体退回评论口径，不因它失败。
        return null;
      }
    },
  };
}

function toReportPost(emotion: {
  tid: string;
  time: number;
  content: string;
  images: string[];
  videos: Array<{ coverUrl: string }>;
  commentNum: number;
  isPrivate: boolean;
}): ReportQzonePost {
  return {
    tid: emotion.tid,
    time: emotion.time,
    content: emotion.content,
    images: emotion.images,
    videoCover: emotion.videos[0]?.coverUrl ?? '',
    hasVideo: emotion.videos.length > 0,
    commentCount: emotion.commentNum,
    likeCount: null,
    isPrivate: emotion.isPrivate,
  };
}
