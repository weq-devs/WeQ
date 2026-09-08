import type { PageAvailability, ReportPageDefinition, ReportQzonePost } from '../../types';
import { isAllTimeYear, reportYearUnixRange } from '../../time';
import type { QzoneMemoriesPageData, QzoneMemoryHighlight, QzoneMemoryMetric } from './types';

/**
 * 画廊精选的上限。画廊只是「几帧有代表性的记忆」，不是又一个完整的说说时间线
 * —— 数据契约里已经只带这一批，避免一整个历史的上百张远图 URL 压给渲染层。
 */
const GALLERY_LIMIT = 18;
/**
 * 全量补赞的门槛。qzone 的点赞名单接口是「一帖一请求」，超过这个量级还逐帖补拉
 * 会让整页等太久，也会让空间接口暴露在风控下 —— 超过就退回「评论最多」口径，
 * 页面上这句话依然诚实（它说评论，不说赞）。
 */
const LIKE_FETCH_LIMIT = 100;
/** 点赞补拉的并发数 —— 与好友空间导出的 qz_opcnt2 补拉同一档，克制不轰炸。 */
const LIKE_CONCURRENCY = 4;

/**
 * QQ 空间回忆 —— 年度报告的最后一页正文（end 之前）。
 *
 * 素材来自本账号的 QQ 空间（web cgi，需在线 QQ），而不是本地消息库。整页的
 * 故事线是「你曾经把生活寄存在这里」：
 *
 *   1. 全窗拉取自己的全部说说（与好友空间导出同一条已抓包验证的翻页通路）；
 *   2. 一个巨大的总数是主体 —— 你一共写过 N 条；
 *   3. 冠军回忆挑「获赞最多」或「评论最多」的那一条（赞要能逐帖补到权威名单
 *      才用，补不到就退回 cmtnum 的评论口径，不硬编一个赞数）；
 *   4. 精选一小批说说做画廊，媒体与文字混排，把「空间还替你记得」落到画面上。
 *
 * availability 必须真的翻页拉一次：是否发过说说只能由空间返回的列表回答，
 * 本地没有这份数据可猜。结果按时间窗在 queries 层记忆化，compute 白拿。
 */
export const qzonePage: ReportPageDefinition<QzoneMemoriesPageData> = {
  manifest: {
    id: 'qzone',
    title: 'QQ空间回忆',
    description: '发出去的心情、照片和晚霞——都是那年那天的你。',
    order: 12,
    version: '0.1.0',
    apiVersion: 1,
    category: '空间',
    enabledByDefault: true,
  },
  availability: async ({ year, q }): Promise<PageAvailability> => {
    if (!(await q.qzone.canQuery())) {
      return {
        available: false,
        reason: 'QQ 空间回忆需要当前账号的 QQ 在线（ptlogin 可兜底换取 p_skey）',
      };
    }
    const { startSec, endSec } = reportYearUnixRange(year);
    const posts = await q.qzone.posts(startSec, endSec);
    return {
      available: posts.length > 0,
      reason:
        posts.length > 0
          ? undefined
          : isAllTimeYear(year)
            ? '这段时间你没有在 QQ 空间发表过说说'
            : '这一年你没有在 QQ 空间发表过说说',
    };
  },
  compute: async ({ year, q }): Promise<QzoneMemoriesPageData> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const shared = await q.qzone.posts(startSec, endSec);
    // q.posts 的数组是共享只读的；点赞补拉要原位记数，先逐条浅拷贝再写。
    const posts = shared
      .map((post) => ({ ...post, likeCount: post.likeCount ?? null }))
      .sort((a, b) => b.time - a.time || a.tid.localeCompare(b.tid));

    if (posts.length === 0) {
      return {
        year,
        total: 0,
        gallery: [],
        firstPostTime: 0,
        latestPostTime: 0,
        highlight: null,
      };
    }

    // 数量在门槛内才逐帖补权威赞数；补不齐（任一帖失败 → null）就整组放弃赞口径。
    let likeMetricAvailable = false;
    if (posts.length <= LIKE_FETCH_LIMIT) {
      const counts = await mapWithConcurrency(posts, LIKE_CONCURRENCY, (post) =>
        q.qzone.likeCount(post.tid),
      );
      const allKnown = counts.every((count): count is number => count !== null);
      if (allKnown) {
        posts.forEach((post, index) => {
          post.likeCount = counts[index] ?? null;
        });
        likeMetricAvailable = true;
      }
    }

    const commentTop = pickTop(posts, 'commentCount', 'comment');
    const likeTop = pickTop(posts, 'likeCount', 'like');
    let highlight: QzoneMemoryHighlight | null = null;
    if (likeMetricAvailable && likeTop && (likeTop.post.likeCount ?? 0) > 0) {
      highlight = likeTop;
    } else if (commentTop && commentTop.post.commentCount > 0) {
      highlight = commentTop;
    }

    return {
      year,
      total: posts.length,
      gallery: pickGallery(posts, highlight?.post?.tid),
      firstPostTime: Math.min(...posts.map((post) => post.time)),
      latestPostTime: posts[0]?.time ?? 0,
      highlight,
    };
  },
};

/**
 * 找某一指标的第一名。同一数值取更新发表的那条 —— 记忆里，「更晚被想起」的那
 * 条略胜一筹；排序永远稳定，不给随机性留空间。
 */
function pickTop(
  posts: ReportQzonePost[],
  metric: 'commentCount' | 'likeCount',
  metricLabel: QzoneMemoryMetric,
): QzoneMemoryHighlight | null {
  let top: ReportQzonePost | null = null;
  for (const post of posts) {
    const value = post[metric] ?? 0;
    const topValue = top?.[metric] ?? 0;
    if (!top || value > topValue) top = post;
  }
  if (!top) return null;
  return {
    post: top,
    metric: metricLabel,
    count: top[metric] ?? 0,
  };
}

/**
 * 精选画廊：时间倒序 + 少量刻意保留的「旧帧」。开头的 N 条是最近的自己，末尾
 * 补几条最早的说说/回忆，冠军帖保证在场（它是本页唯一被点名的一段）。>GALLERY_LIMIT
 * 时不硬撑全量 —— 一条无限跑动的胶片只需要有代表性的画面。
 */
function pickGallery(
  sortedDesc: ReportQzonePost[],
  championTid: string | undefined,
): ReportQzonePost[] {
  if (sortedDesc.length <= GALLERY_LIMIT) return sortedDesc;
  const picked: ReportQzonePost[] = [];
  const seen = new Set<string>();
  const add = (post: ReportQzonePost | undefined): void => {
    if (!post || seen.has(post.tid)) return;
    seen.add(post.tid);
    picked.push(post);
  };

  // 冠军必须进场，所以它不占「最近/最早」的名额；最近的自己与最早的旧帧先各
  // 挑一批，冠军插队，最后再从头补到上限。
  const recentCount = 8;
  const oldestCount = 4;
  for (const post of sortedDesc.slice(0, recentCount)) add(post);
  if (championTid) {
    const champion = sortedDesc.find((post) => post.tid === championTid);
    add(champion);
  }
  const oldest = [...sortedDesc].reverse().slice(0, oldestCount);
  for (const post of oldest) add(post);
  for (const post of sortedDesc) {
    add(post);
    if (picked.length >= GALLERY_LIMIT) break;
  }
  return picked.sort((a, b) => b.time - a.time || a.tid.localeCompare(b.tid));
}

/** 固定并发小池跑一个 async 映射，保持数组顺序。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await worker(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return out;
}
