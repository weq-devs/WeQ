/** 年度报告「QQ 空间回忆」（qzone）数据契约 —— 一页关于你在空间留下的旧日心情。 */

import type { ReportQzonePost } from '../../types';

/** 冠军回忆的统计口径：按赞（qz_opcnt2 权威数）或按评论（说说自带 cmtnum）。 */
export type QzoneMemoryMetric = 'like' | 'comment';

/** 全窗最能代表你的一段回忆。没有可讲的赞/评论时为 null，页面退回纯画廊。 */
export type QzoneMemoryHighlight = {
  /** 冠军那条说说本身。 */
  post: ReportQzonePost;
  /** 用什么口径把它选出来。 */
  metric: QzoneMemoryMetric;
  /** 对应口径的数值：`metric === 'like'` 是赞数，否则是评论数。 */
  count: number;
};

export type QzoneMemoriesPageData = {
  /** 报告口径年份（`ALL_TIME_YEAR` 0 = 历史以来）。 */
  year: number;
  /**
   * 时间窗内拉到的、自己发表的说说总数（分页去重后）。它是本页真正的主体：
   * 渲染层把它当成一个巨数，而不是又一个统计卡片。
   */
  total: number;
  /**
   * 画廊素材，按发表时间倒序（最新在前）。服务端只收一部分精选，避免把一整个
   * 历史的大量远图 URL 全部塞给渲染层 —— 渲染层要的是「几帧有代表性的记忆」。
   */
  gallery: ReportQzonePost[];
  /** 全窗最早一条说说的发表时间（unix 秒）；没有时为空数组对应的 0。 */
  firstPostTime: number;
  /** 全窗最新一条说说的发表时间（unix 秒）。 */
  latestPostTime: number;
  /** 页面的冠军回忆；没有可讲的赞/评论时为 null。 */
  highlight: QzoneMemoryHighlight | null;
};
