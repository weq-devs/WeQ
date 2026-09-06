import type { DressTally } from '@weq/db';
import type { PageAvailability, ReportPageDefinition, ReportQueries } from '../../types';
import { reportYearUnixRange } from '../../time';
import type { DressKindData, DressOutfit, DressPageData, DressItemUsage } from './types';

/**
 * 年度装扮 —— 「这一年，你最喜欢用的装扮」。
 *
 * 数据来自消息表的 40801 列（气泡 / 聊天字体 / 头像挂件三个 itemId），只统计
 * **我发出的**消息：装扮是自己的选择，别人的气泡不该算进我的年度偏好。私聊 + 群聊
 * 各一次扫描（SQL 侧已滤掉空 40801），顺带按套采样正文纯文本。
 *
 * 聚合单位是**一套**（气泡+字体+挂件的组合）而不是三类分开：40801 记的本来就是一套，
 * 报告要还原的是「那年我发的消息长什么样」。三类单榜只留下来算「一共穿过几款」。
 *
 * 展示条件：至少用过一次装扮。一次都没用过的人翻到这页只会看到空页，不如不出现。
 *
 * ⚠️ 字体在 40801 里有两个 tag（41525 首选、41531 是字节序交换过的备用值），归一
 * 由 codec 的 `decodeMsgDressColumn` 负责，这里拿到的 fontId 已经是同一个口径。
 */
export const dressPage: ReportPageDefinition<DressPageData> = {
  manifest: {
    id: 'dress',
    title: '你最喜欢的装扮',
    description: '这一年，你把哪身行头穿得最久。',
    order: 2,
    version: '0.2.0',
    apiVersion: 1,
    category: '装扮',
    enabledByDefault: true,
  },
  availability: async ({ year, q }): Promise<PageAvailability> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const tally = await q.dress.tally(startSec, endSec);
    return {
      available: tally.decorated > 0,
      reason: tally.decorated > 0 ? undefined : '这段时间你一次装扮都没用过',
    };
  },
  compute: async ({ year, q }) => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const [tally, counts] = await Promise.all([
      q.dress.tally(startSec, endSec),
      q.overview.countByDirection(startSec, endSec),
    ]);
    const outfits = rankOutfits(q, tally);
    return {
      year,
      totalSent: counts.c2cSent + counts.groupSent,
      decorated: tally.decorated,
      outfits,
      // 截断前的真实身数 —— 「换过几身」读这个，不读 outfits.length。
      outfitCount: countOutfits(tally),
      bubble: rank(q, 'bubble', tally.bubble),
      font: rank(q, 'font', tally.font),
      widget: rank(q, 'widget', tally.widget),
    };
  },
};

/** 一页最多下发多少套。穿得再杂的人也远到不了这个数，纯粹是 JSON 体积的护栏。 */
const MAX_OUTFITS = 40;

/** 单类榜最多下发多少款。同上，只为兜住异常庞大的榜单。 */
const MAX_ITEMS_PER_KIND = 60;

/** 真实穿过的套数（口径与 {@link rankOutfits} 的过滤一致，但不截断）。 */
function countOutfits(tally: DressTally): number {
  let n = 0;
  for (const outfit of Object.values(tally.outfits)) {
    if (outfit.count > 0 && (outfit.bubbleId > 0 || outfit.fontId > 0 || outfit.widgetId > 0)) {
      n += 1;
    }
  }
  return n;
}

/**
 * `tally.outfits` → 降序套装列表，附上三件的款名。
 *
 * 并列时按 key 字典序兜底，同一份数据两次计算的顺序才稳定（否则「最爱这身」会随
 * Object 迭代序变化跳来跳去）。款名一次性批量解析：三类各查一次，不是每套查三次。
 */
function rankOutfits(q: ReportQueries, tally: DressTally): DressOutfit[] {
  const entries = Object.entries(tally.outfits)
    .filter(([, outfit]) => outfit.count > 0)
    // 三项全 0 的「空套」是畸形 40801 的产物，画出来是个没穿装扮的裸气泡。
    .filter(([, o]) => o.bubbleId > 0 || o.fontId > 0 || o.widgetId > 0)
    .sort(([ka, a], [kb, b]) => b.count - a.count || ka.localeCompare(kb))
    .slice(0, MAX_OUTFITS);

  const names = {
    bubble: q.dress.names('bubble', unique(entries.map(([, o]) => o.bubbleId))),
    font: q.dress.names('font', unique(entries.map(([, o]) => o.fontId))),
    widget: q.dress.names('widget', unique(entries.map(([, o]) => o.widgetId))),
  };

  return entries.map(([key, outfit]) => ({
    key,
    bubbleId: outfit.bubbleId,
    fontId: outfit.fontId,
    widgetId: outfit.widgetId,
    bubbleName: names.bubble[outfit.bubbleId] ?? '',
    fontName: names.font[outfit.fontId] ?? '',
    widgetName: names.widget[outfit.widgetId] ?? '',
    count: outfit.count,
    samples: outfit.samples,
    firstTime: outfit.firstTime,
    lastTime: outfit.lastTime,
  }));
}

function unique(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => id > 0))];
}

/**
 * `{itemId: count}` → 降序榜单 + 款名。并列时按 itemId 升序兜底，同一份数据两次
 * 计算的顺序才是稳定的。
 *
 * `total` / `distinct` 在**截断之前**算好：报告里写的是「这一年你用过 12 款气泡」，
 * 那个数不该因为 JSON 护栏砍掉了尾巴就变小。
 */
function rank(
  q: ReportQueries,
  kind: 'bubble' | 'font' | 'widget',
  counts: Record<number, number>,
): DressKindData {
  const all = Object.entries(counts)
    .map(([id, count]) => ({ itemId: Number(id), count }))
    .filter((entry) => entry.itemId > 0 && entry.count > 0)
    .sort((a, b) => b.count - a.count || a.itemId - b.itemId);
  const total = all.reduce((sum, entry) => sum + entry.count, 0);
  const entries = all.slice(0, MAX_ITEMS_PER_KIND);

  const names = q.dress.names(
    kind,
    entries.map((entry) => entry.itemId),
  );
  const items: DressItemUsage[] = entries.map((entry) => ({
    itemId: entry.itemId,
    count: entry.count,
    name: names[entry.itemId] ?? '',
  }));
  return { items, total, distinct: all.length };
}
