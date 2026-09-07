import type { PageAvailability, ReportPageDefinition } from '../../types';
import { isAllTimeYear, reportYearUnixRange } from '../../time';
import type { RhythmLabel, RhythmPageData, RhythmWindow, RhythmWindowKind } from './types';

/**
 * 五段“作息”定义 —— 覆盖全天，键名与 {@link RhythmWindowKind} 对应。
 * 每一段按“每小时平均条数”参与比较：长度不同，比总数会永远偏向 6 小时的
 * 午段，而作息是强度，不是体量。
 */
const WINDOW_DEFS: ReadonlyArray<{
  kind: RhythmWindowKind;
  label: string;
  english: string;
  span: string;
  hours: number[];
}> = [
  {
    kind: 'night',
    label: '夜猫子',
    english: 'NIGHT OWL',
    span: '22:00 – 02:00',
    hours: [22, 23, 0, 1],
  },
  {
    kind: 'us',
    label: '美国作息',
    english: 'US CLOCK',
    span: '02:00 – 08:00',
    hours: [2, 3, 4, 5, 6, 7],
  },
  {
    kind: 'early',
    label: '早八人',
    english: 'EARLY BIRD',
    span: '08:00 – 12:00',
    hours: [8, 9, 10, 11],
  },
  {
    kind: 'afternoon',
    label: '午后续航',
    english: 'AFTERNOON DRIVE',
    span: '12:00 – 18:00',
    hours: [12, 13, 14, 15, 16, 17],
  },
  {
    kind: 'dusk',
    label: '黄昏上线',
    english: 'GOLDEN HOUR',
    span: '18:00 – 22:00',
    hours: [18, 19, 20, 21],
  },
];

/** 黄昏与深夜相邻、午段连着午后——只有“暗时段”和“亮时段”之间才算两段作息。 */
const DARK_KINDS: ReadonlySet<RhythmWindowKind> = new Set(['night', 'us']);

/**
 * 我的作息 —— 一次扫两张表、不解码消息体，只看自己发出的消息落在本地
 * 时间的哪个钟点。真正的主角不是峰值数字，而是由这段分布反推出来的那个词：
 * “夜猫子 / 早八人 / 美国作息…” 它才是人设，曲线和 7×24 墙只是证据。
 */
export const rhythmPage: ReportPageDefinition<RhythmPageData> = {
  manifest: {
    id: 'rhythm',
    title: '我的作息',
    description: '24 个小时里，你的话更常在哪一段醒来。',
    order: 6,
    version: '0.1.0',
    apiVersion: 1,
    category: '自己',
    enabledByDefault: true,
  },
  availability: async ({ year, q }): Promise<PageAvailability> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const counts = await q.overview.countByDirection(startSec, endSec);
    const hasSent = counts.c2cSent + counts.groupSent > 0;
    return {
      available: hasSent,
      reason: hasSent
        ? undefined
        : isAllTimeYear(year)
          ? '这段时间你没有发出过消息'
          : '这一年你没有发出过消息',
    };
  },
  compute: async ({ year, q }) => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const weekdayHourly = await q.rhythm.sentWeekdayHourlyTallies(startSec, endSec);

    const hourly = Array.from({ length: 24 }, (_, hour) =>
      weekdayHourly.reduce((sum, row) => sum + Number(row[hour] ?? 0), 0),
    );
    const sentTotal = hourly.reduce((sum, count) => sum + count, 0);
    const activeHours = hourly.filter((count) => count > 0).length;

    // 峰值：条数相同时取更早的一小时（“醒得早”听感上更接近晨型）。
    let peakHour = 0;
    let peakCount = 0;
    for (let hour = 0; hour < 24; hour++) {
      if (hourly[hour]! > peakCount) {
        peakHour = hour;
        peakCount = hourly[hour]!;
      }
    }

    const windows: RhythmWindow[] = WINDOW_DEFS.map((def) => {
      const count = def.hours.reduce((sum, hour) => sum + (hourly[hour] ?? 0), 0);
      const rate = count / def.hours.length;
      return {
        kind: def.kind,
        label: def.label,
        english: def.english,
        span: def.span,
        count,
        share: sentTotal > 0 ? count / sentTotal : 0,
        rate,
      };
    });

    return {
      year,
      sentTotal,
      activeHours,
      hourly,
      weekdayHourly,
      peakHour,
      peakCount,
      windows,
      label: pickLabel(windows, hourly),
    };
  },
};

/** 从五段强度里挑出巨字人设；都差不多时就退到“随缘上线”，不硬给人贴标签。 */
function pickLabel(windows: RhythmWindow[], hourly: number[]): RhythmLabel {
  const ranked = windows.slice().sort((a, b) => b.rate - a.rate || b.count - a.count);
  const main = ranked[0]!;
  const next = ranked[1]!;
  const hasSomeTalk = windows.some((window) => window.count > 0);

  // 休息时段（22–08）说话很少、白天分散，仍算有“白天”作息；只有哪段都比
  // 别的段高出至少 15% 才算特征鲜明。
  const clear =
    hasSomeTalk &&
    main.rate > 0 &&
    next.rate > 0 &&
    main.rate >= next.rate * 1.15 &&
    main.share >= 0.12;

  if (!clear) {
    const darkShare = windows
      .filter((window) => DARK_KINDS.has(window.kind))
      .reduce((sum, window) => sum + window.share, 0);
    const dayShare = windows
      .filter((window) => !DARK_KINDS.has(window.kind))
      .reduce((sum, window) => sum + window.share, 0);
    if (darkShare >= 0.45 && dayShare <= 0.55) {
      // 不贴具体人设：夜长梦多，深色时段已经是主体。
      return { kind: 'all', word: '夜行动物', english: 'NOCTURNAL', span: '22:00 – 08:00' };
    }
    if (dayShare >= 0.62) {
      return { kind: 'all', word: '白昼话痨', english: 'DAYLIGHT', span: '08:00 – 22:00' };
    }
    if (hourly.every((count) => count === 0)) {
      return { kind: 'all', word: '零记录', english: 'SILENT', span: '——' };
    }
    return { kind: 'all', word: '随缘上线', english: 'WHENEVER', span: '00:00 – 24:00' };
  }

  return { kind: main.kind, word: main.label, english: main.english, span: main.span };
}
