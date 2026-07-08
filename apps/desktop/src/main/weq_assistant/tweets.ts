/**
 * WeQ 助手「推文」的本地存储 —— 唯一数据源（source of truth）。
 *
 * 推文只有一类：一条推文 = 一张 ARK 卡片的内容 + 一个**固定在本地的时间**。
 * 规则：
 *   - 不保存到本地就不写库；本地这份 JSON 才是权威列表。
 *   - `createdAt`（Unix 秒）在推文**首次落本地时定死一次**，此后永不重算。它既是卡
 *     片消息的时间（写进 c2c 的 40050），也是「这条推文是否已进库」的去重键。
 *   - 内置的两篇（每日推文 / 群数据周报）作为种子，仅在本地库为空时写入一次。
 *
 * 这里只碰文件系统，不碰任何数据库；注入数据库是 WeqAssistantService 的职责，两层
 * 边界清晰：`addTweet`（写本地）→ `WeqAssistantService.injectTweet`（注入库）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 一条推文的完整本地记录（落盘 / 内存同构）。 */
export interface WeqTweet {
  /** 稳定唯一 id（`t-<createdAt>`），供未来引用/删除。 */
  id: string;
  /** 封面 PNG 的服务器路由，如 `/cover/daily`。 */
  coverPath: string;
  /** 点击跳转页的服务器路由，如 `/p/daily`。 */
  pagePath: string;
  /** 卡片标题行。 */
  title: string;
  /** 卡片正文。 */
  contentText: string;
  /** `prompt`（QQ 通知 / 兜底文案），如 `[WeQ助手] 每日推文`。 */
  prompt: string;
  /** 会话列表里作为最新消息时显示的预览行。 */
  previewText: string;
  /** **固定** Unix 秒：卡片消息的时间 + 进库去重键。首次落本地时定死，永不重算。 */
  createdAt: number;
}

/** 一条推文除去「身份/时间」的内容部分（新增推文的入参 / 种子定义）。 */
export type WeqTweetInput = Omit<WeqTweet, 'id' | 'createdAt'>;

/** 内置种子：仅在本地库为空时写入一次，之后就是普通推文。 */
const DEFAULT_TWEET_SEEDS: WeqTweetInput[] = [
  {
    coverPath: '/cover/daily',
    pagePath: '/p/daily',
    title: 'WeQ 助手 · 欢迎使用',
    contentText: '欢迎使用 WeQ！点击了解这个项目能做什么～',
    prompt: '[WeQ助手] 欢迎使用 WeQ',
    previewText: '[WeQ助手] 欢迎使用 WeQ',
  },
  {
    coverPath: '/cover/stats',
    pagePath: '/p/stats',
    title: 'WeQ 助手 · 群数据周报',
    contentText: '你最活跃群聊的数据周报已生成，点击查看排行 / 活跃时段 / 词云～',
    prompt: '[WeQ助手] 群数据周报',
    previewText: '[WeQ助手] 群数据周报已生成',
  },
];

/** 本地推文列表的落盘路径（全局共享，与账号无关——推文内容不含账号数据）。 */
export function tweetsStorePath(cacheDir: string): string {
  return join(cacheDir, 'tweets.json');
}

/** 读盘推文列表；文件缺失 / 损坏 / 结构不符都回空列表（当作没有）。 */
export function loadTweets(path: string): WeqTweet[] {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTweet);
  } catch {
    return [];
  }
}

/** 落盘推文列表（懒建父目录）。 */
export function saveTweets(path: string, list: WeqTweet[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(list), 'utf-8');
}

/**
 * 新增一条推文到本地库（「写到本地」这一步）。分配固定 `createdAt`（当前时刻，与既有
 * 推文时间去重保证严格唯一）+ 稳定 id，追加落盘后返回该推文。注入数据库由调用方另
 * 行 `WeqAssistantService.injectTweet(port, tweet)` 完成。
 */
export function addTweet(path: string, input: WeqTweetInput): WeqTweet {
  const list = loadTweets(path);
  const used = new Set(list.map((t) => t.createdAt));
  let createdAt = Math.floor(Date.now() / 1000);
  while (used.has(createdAt)) createdAt += 1; // 时间即去重键，必须唯一
  const tweet: WeqTweet = { id: `t-${createdAt}`, createdAt, ...input };
  saveTweets(path, [...list, tweet]);
  return tweet;
}

/**
 * 确保本地库里至少有内置种子推文：库非空则原样返回；库为空则用**当前时刻**给两篇
 * 种子各定一个固定且互不相同的时间（此后永久固定在本地），落盘后返回。
 */
export function ensureDefaultTweets(path: string): WeqTweet[] {
  const existing = loadTweets(path);
  if (existing.length > 0) return existing;
  const base = Math.floor(Date.now() / 1000) - DEFAULT_TWEET_SEEDS.length;
  const seeded: WeqTweet[] = DEFAULT_TWEET_SEEDS.map((seed, i) => ({
    id: `t-${base + i}`,
    createdAt: base + i,
    ...seed,
  }));
  saveTweets(path, seeded);
  return seeded;
}

function isTweet(v: unknown): v is WeqTweet {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    typeof t.coverPath === 'string' &&
    typeof t.pagePath === 'string' &&
    typeof t.title === 'string' &&
    typeof t.contentText === 'string' &&
    typeof t.prompt === 'string' &&
    typeof t.previewText === 'string' &&
    typeof t.createdAt === 'number'
  );
}
