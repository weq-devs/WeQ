/** 我的作息（rhythm）数据契约 —— 统计「自己发出的消息落在一天的哪一段」。 */

/** 把 24 小时切成五段“作息时段”；键名稳定，别因文案改动而重排。 */
export type RhythmWindowKind = 'night' | 'us' | 'early' | 'afternoon' | 'dusk';

export type RhythmWindow = {
  kind: RhythmWindowKind;
  /** 中文大字：夜猫子 / 早八人 / 美国作息… */
  label: string;
  /** 英文小标，用于窄画幅里的衬线氛围字。 */
  english: string;
  /** 24 小时制区间，例如 `22:00 – 02:00`。 */
  span: string;
  /** 落在该时段的发出条数。 */
  count: number;
  /** 该时段在全部发言里的占比，0~1。 */
  share: number;
  /** 每小时平均条数 —— 时段长度不一，比较“发言率高”得看它，不是看总数。 */
  rate: number;
};

/** 落在整页巨字上的人设。kind === 'all' 表示没有哪一段特别突出。 */
export type RhythmLabel = {
  kind: RhythmWindowKind | 'all';
  word: string;
  english: string;
  /** 该人设对应的时段文案，`00:00 – 24:00` 即“随时可能上线”。 */
  span: string;
};

export type RhythmPageData = {
  /** 报告口径年份。`ALL_TIME_YEAR`（0）= 历史以来。 */
  year: number;
  /** 统计口径内自己发出的消息总数（私聊 + 群聊）。 */
  sentTotal: number;
  /** 一天 24 个本地小时里，至少发过一条消息的小时数。 */
  activeHours: number;
  /** 按本地小时 0..23 的自己发出条数。 */
  hourly: number[];
  /**
   * 7×24 矩阵：行序与 `Date#getDay()` 一致（0 = 周日），列 = 本地小时。
   * 给“一周绿墙”用。
   */
  weekdayHourly: number[][];
  /** 单小时峰值对应的小时（0..23）。 */
  peakHour: number;
  /** 峰值小时的条数。 */
  peakCount: number;
  /** 五个作息时段的完整统计（已按一天覆盖排好序，渲染层直接使用）。 */
  windows: RhythmWindow[];
  /** 页面上那枚巨大的人设词。 */
  label: RhythmLabel;
};
