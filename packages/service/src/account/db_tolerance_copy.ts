/**
 * 数据库宽容（salvage）的**用户可见文案**集中地。
 *
 * 为什么放在 service 而不是渲染层：
 *  1. 文案必须与**实际能力边界**逐条对齐，而能力边界写在 `@weq/db` 的 salvage /
 *     导出链路里，这里紧挨着它，改能力的人一抬头就能看到要同步改的话；
 *  2. 设置页、损坏弹窗、导出任务的日志、账本说明都要说同一句话 —— 分散在三个
 *     组件里只会各自漂移；
 *  3. 纯数据 + 纯函数、**零依赖**，可以直接单测：口径一旦被写宽（例如把"只有导出"
 *     说成"所有查询"），测试会红。
 *
 * **零依赖是硬要求**：渲染层要真正 import 它（不是 type-import），所以本模块不能牵进
 * native / db / node 内置模块。因此它作为 `@weq/service/db-tolerance-copy` 子路径导出
 * —— 与 `@weq/service/report-time` 同一套做法。也正因如此，级别归一在这里自带一份
 * 实现（`clampSalvageLevelCopy`），一致性由测试与 `@weq/db` 的 `clampSalvageLevel`
 * 逐项对拍保证。
 *
 * **2026-09-20 在真实损坏库上实测过的三条边界**（文案一个字都不许写得更宽）：
 *  - 级别 1「换访问路径」：只对"坏在索引上"的查询有用。坏在**数据页**上时，
 *    换哪条路都要读那一页 —— 实测 `GROUP BY` 型查询在级别 1 仍然 121ms 就返回
 *    `corrupt/11`；
 *  - 级别 2「跳过坏区间」：**只**对"按整数键分块的有序读取"有效（群聊 / 私聊
 *    导出）。它的契约是「末两个 `?` 是 `(lo, hi)`、结果按第一列整数键升序」，
 *    聚合 / JOIN / `GROUP BY` 这类没有键轴的查询**根本切不开**，级别再高也一样报
 *    `database disk image is malformed`；
 *  - 级别 3「放弃整表」：粒度是 `(库, 表)`，一处坏页连续失败 3 次就会让**整张表**
 *    的所有读（含健康会话）一起短路，直到隔离过期或被手动清除。
 *
 * 由此得出的第四条，也是本模块存在的主要理由：
 *  **年度报告、群分析这类聚合页大概率没有任何效果** —— 它们的查询全是整表聚合，
 *  没有可按 key 切块的读取路径。与其让用户开了级别却看不出变化，不如现在就说明白。
 */

/**
 * 宽容级别。与 `@weq/db` 的 `SalvageLevel` 同构，但**不 import** —— 见文件头「零依赖」。
 */
export type SalvageCopyLevel = 0 | 1 | 2 | 3;

/**
 * 级别归一：与 `@weq/db` 的 `clampSalvageLevel` **逐字节一致**。
 *
 * 语义要点（容易写错的地方）：非法值一律回到**严格**（0），而不是"夹到最近的合法值"。
 * 文案宁可少说也不能凭空造出一个用户没选的级别。一致性由单测对拍。
 */
export function clampSalvageLevelCopy(value: unknown): SalvageCopyLevel {
  const n = typeof value === 'number' ? Math.trunc(value) : 0;
  return n === 1 || n === 2 || n === 3 ? n : 0;
}

/** 设置页 / 弹窗共用的"实验性"标签。 */
export const SALVAGE_EXPERIMENTAL_TAG = '实验性';

/**
 * "实验性"到底意味着什么 —— 一句话讲清楚，别只贴个标签。
 *
 * 说"实验性"不是免责声明，而是在解释**为什么**它只覆盖一部分读取：容错的前提是
 * 查询能被切成块、坏块能被跳过，而这件事只有"按会话键轴有序读取"这类查询具备。
 */
export const SALVAGE_EXPERIMENTAL_NOTE =
  '宽容目前只对「按会话键轴分块读取」的链路有效（主要是群聊 / 私聊导出）。' +
  '它依赖把查询切成可跳过的区块，聚合类查询切不开，所以开到最高级别也可能毫无帮助。';

/**
 * 聚合查询（年度报告等）的明确警告。
 *
 * 实测口径：年度报告每一页都是 `GROUP BY` / `COUNT` 整表聚合，级别 0/1/2/3
 * 在同一条语句上的表现**完全一致** —— 都是 `kind=corrupt`、`code=11`、0 行。
 * 所以这里不是"可能有点慢"，而是"大概率仍然直接报错"。
 */
export const SALVAGE_AGGREGATE_CAVEAT =
  '年度报告、群分析等聚合统计大概率仍然直接报错（database disk image malformed）：' +
  '它们没有可按 key 切块的读取路径，宽容级别对它们没有效果，只有修复数据库才能恢复。';

/**
 * 跳过区间的口径纪律：给的是**键区间**，不是条数。
 *
 * 同一个 key 可能对应多行（共享 seq 的灰条、贴表情），所以任何"最多丢 N 行 /
 * N 条"的说法都是错的 —— 全仓口径一致：只说"哪一段读不出来"。
 */
export const SALVAGE_SKIPPED_SPAN_CAVEAT =
  '报告里给的是读不出来的键区间（键跨度），不是条数：同一段区间内到底有多少行读不出来无从得知。';

/** 一个宽容级别的文案。 */
export interface SalvageLevelCopy {
  level: SalvageCopyLevel;
  /** 级别行标题。 */
  title: string;
  /** 这个级别做什么（不含生效范围）。 */
  summary: string;
  /** **生效范围** —— 必须与实际接线逐条对齐，宁可写窄不可写宽。 */
  scope: string;
  /** 会不会丢数据（会丢的级别才需要二次确认）。 */
  losesData: boolean;
  /** 会丢数据的级别：确认前必须看到的那句话。 */
  confirm?: string;
}

/**
 * 级别 0..3 的文案。级别 0 是严格模式，也要出现在列表里 ——
 * 否则用户看不到"关掉会回到什么状态"。
 */
export const SALVAGE_LEVEL_COPY: readonly SalvageLevelCopy[] = [
  {
    level: 0,
    title: '级别 0 · 严格（默认）',
    summary: '任何损坏都原样报错，不静默降级。',
    scope: '所有读取路径。这也是关闭宽容后的状态：账本会保留，读取链路与从未开过宽容完全一样。',
    losesData: false,
  },
  {
    level: 1,
    title: '级别 1 · 换访问路径重试',
    summary: '查询命中损坏时，改用整表扫描再试一次（不丢数据，不改变结果语义）。',
    scope:
      '走宽容入口的读查询。只在「坏在索引上、数据页完好」时有救；坏在数据页上时换路无效，仍然报错。',
    losesData: false,
  },
  {
    level: 2,
    title: '级别 2 · 跳过读不出来的区间',
    summary: '按整数键分块读取，读不出来的块先换路、再二分，最后记成「跳过区间」。',
    scope:
      '只有群聊 / 私聊导出这种「按会话键轴有序读取」的链路会用到；聊天页、搜索、官方号 / 服务号导出、以及所有聚合查询（年度报告、群分析）仍然严格失败。',
    losesData: true,
    confirm:
      '导出结果会缺失这一段的消息，并会在导出日志与账本里标明跳过的键区间（区间内有多少行无从得知）。',
  },
  {
    level: 3,
    title: '级别 3 · 放弃读不动的整张表',
    summary: '在级别 2 基础上启用隔离：连续读不动的表被整体放弃，保证其它表还能用。',
    scope:
      '判据是 (数据库, 表名)：一处坏页连续失败 3 次后，这张表的**所有**读（包括本来就健康的会话）都会直接短路；隔离有存活时间，到期或被手动清除后会再试。',
    losesData: true,
    confirm:
      '被隔离的表在隔离期内一条数据都读不出来 —— 包括这张表里本来完好的部分，而且其它会碰这张表的功能也会一起失败。',
  },
];

/** 按级别取文案；越界值按 {@link clampSalvageLevelCopy} 归一，永不返回 undefined。 */
export function salvageLevelCopy(level: number): SalvageLevelCopy {
  const clamped = clampSalvageLevelCopy(level);
  return SALVAGE_LEVEL_COPY[clamped] ?? SALVAGE_LEVEL_COPY[0]!;
}

/** 列表里展示的级别（0 在前，便于"关掉"这件事也占一行）。 */
export function salvageLevelsAscending(): readonly SalvageLevelCopy[] {
  return SALVAGE_LEVEL_COPY;
}

/**
 * 切换级别后的 toast 文案。
 *
 * `detail` 里必须带上"这个级别实际覆盖什么"，因为用户最容易误解的地方正是这里：
 * 开了级别 2 之后，年度报告并不会变好。
 */
export function salvageLevelToast(level: number): { title: string; detail: string } {
  const copy = salvageLevelCopy(level);
  switch (copy.level) {
    case 0:
      return {
        title: '已恢复严格模式',
        detail: `${copy.summary}读取链路与从未开过宽容完全一样（账本仍保留）。`,
      };
    case 1:
      return {
        title: '已开启级别 1 · 换访问路径',
        detail: `${copy.scope}${SALVAGE_AGGREGATE_CAVEAT}`,
      };
    case 2:
      return {
        title: '已开启级别 2 · 跳过读不出来的区间',
        detail: `导出时读不出来的区间会被跳过（可能缺失部分消息）。${copy.scope}${SALVAGE_AGGREGATE_CAVEAT}`,
      };
    default:
      return {
        title: '已开启级别 3 · 放弃读不动的整张表',
        detail: `${copy.scope}${SALVAGE_AGGREGATE_CAVEAT}`,
      };
  }
}
