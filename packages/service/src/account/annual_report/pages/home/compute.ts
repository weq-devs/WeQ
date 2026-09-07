import type { PageAvailability, ReportPageDefinition } from '../../types';
import { isAllTimeYear, reportYearUnixRange } from '../../time';
import { segmentWords } from '../../../text_segment';
import type { HomeGroupTop, HomePageData, HomeTopicWord } from './types';

/** 词云与话题行共用的素材上限：太多颗词会让背景抢走群名的视线。 */
const TOPIC_KEEP = 24;

/**
 * 我的主场 —— 用「自己发出的条数」给这一年待过的群排名，只取第一名。
 *
 * 数据分两段拿，代价正好落在需要的地方：
 *
 *  1. **排行**：群资料（group_detail）+ 一次按「群 × 方向」的元数据轻扫描，
 *     选出自己说得最多的群 —— 这一层不碰消息正文，和总览页同量级；
 *  2. **冠军群**：只对它再做一次全正文扫描，数「大家这一年都在聊什么」
 *     （词频最高的那批词，分词阶段已把「正在 / 应该 / 但是」这类虚词滤掉），
 *     再补查我在这个群里的等级与头衔。
 *
 * 页面不问第二、第三名：它是「主场在哪」的宣告，不是群聊排行榜。显示门槛
 * 只认群聊发言（发过 ≥1 条群消息），私聊再多也不让这页出现在 deck 里。
 */
export const homePage: ReportPageDefinition<HomePageData> = {
  manifest: {
    id: 'home',
    title: '我的主场',
    description: '这一年，你把哪群聊成了家。',
    order: 8,
    version: '0.1.0',
    apiVersion: 1,
    category: '群聊',
    enabledByDefault: true,
  },
  availability: async ({ year, q }): Promise<PageAvailability> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const counts = await q.overview.countByDirection(startSec, endSec);
    const hasGroupSent = counts.groupSent > 0;
    return {
      available: hasGroupSent,
      reason: hasGroupSent
        ? undefined
        : isAllTimeYear(year)
          ? '这段时间你没有发出过群聊消息'
          : '这一年你没有发出过群聊消息',
    };
  },
  compute: async ({ year, q }): Promise<HomePageData> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const ranked = await q.group.countRows(startSec, endSec);
    const groupSentTotal = ranked.reduce((sum, row) => sum + row.sentCount, 0);

    if (ranked.length === 0) {
      return {
        year,
        activeGroupCount: 0,
        groupSentTotal,
        top: null,
      };
    }

    const lead = ranked[0]!;
    const [rows, standing] = await Promise.all([
      q.group.speechRows(lead.groupCode, startSec, endSec),
      q.group.standing(lead.groupCode),
    ]);

    const wordCounts = new Map<string, number>();
    for (const row of rows) {
      for (const element of row.elements) {
        if (element.kind === 'text' && element.textContent) {
          for (const word of segmentWords(element.textContent)) {
            wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
          }
        }
      }
    }
    const topics = [...wordCounts.entries()]
      .map(([word, count]) => ({ word, count }))
      .sort(rankTopics)
      .slice(0, TOPIC_KEEP);

    const top: HomeGroupTop = {
      groupCode: lead.groupCode,
      groupName: lead.groupName,
      groupTotal: lead.totalCount,
      sentCount: lead.sentCount,
      memberCount: lead.memberCount,
      memberLevel: standing?.memberLevel ?? 0,
      levelName: standing?.levelName ?? '',
      customTitle: standing?.customTitle ?? '',
      role: standing?.role ?? 'member',
      topics,
    };

    return {
      year,
      activeGroupCount: ranked.length,
      groupSentTotal,
      top,
    };
  },
};

/** 次数降序、同次数字典序 —— 稳定，不给随机性留空间。 */
function rankTopics(a: HomeTopicWord, b: HomeTopicWord): number {
  return b.count - a.count || a.word.localeCompare(b.word, 'zh');
}
