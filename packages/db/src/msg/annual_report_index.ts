/**
 * AnnualReportIndexDb — 年度报告第一页要用的两个派生索引。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────────
 * 年度报告第一页（年度总览）要在「开屏即出」的前提下，把一整个统计口径的
 * 方向计数读出来：
 *
 *   SELECT "40040", COUNT(*) FROM xxx_msg_table
 *    WHERE "40050" >= ? AND "40050" < ?      -- 本地年边界，半开区间
 *    GROUP BY 1
 *
 * 但 QQ 给这两张表建的复合索引**全部以会话键打头**（`(40027,40003)`、
 * `(40027,40058)`…）。报告问的是「全库、某个时间窗」，不带会话键，这些索引
 * 一条都用不上 —— 只能全表扫描，还必须回表把 `40040` 掏出来。表一大第一页就
 * 明显卡：实测 200 万行 / 2GB 时单条查询约 0.9s，而这只是第一页的第一个查询。
 *
 * ── 这个索引是什么（以及不是什么）──────────────────────────────────────────
 * `(40050, 40040)` 是一个**纯派生覆盖索引**：过滤列（sendTime）与取值列
 * （sentSource）都在索引里，查询退化成一次索引区间扫描，不再碰表本体。实测
 * 同一查询 0.9s → 0.06s（约 15×），索引体积约为表体的 1–2%。
 *
 * 注意这和搜索功能的 FTS 索引**不是一回事**，别混：那个的本质是「内容副本 +
 * 倒排」，要先把库解密出来、再灌一份拍平文本，还得靠水位线增量同步 —— 所以
 * 它只能落在 WeQ 自己的派生库里，由 WeQ 维护。本模块是**就地**在 QQ 自己的库
 * 里 `CREATE INDEX`，只多一个 B-tree，数据与生命周期全归 SQLite：QQ 自己
 * INSERT / UPDATE / DELETE 时索引自动维护，WeQ 没有任何同步逻辑；索引丢了再
 * 幂等重建一次即可。
 *
 * ── 与 QQ 共存的实测结论 ────────────────────────────────────────────────────
 *   • 对 QQ **透明**：schema 只多出 index 对象，表结构不动；QQ 的查询结果与
 *     `PRAGMA integrity_check` 都不受影响（都实测过）。
 *   • QQ 运行中写入照样正确：实测 INSERT / UPDATE / DELETE 后索引即时一致。
 *   • `PRAGMA schema_version` 会 +1，但那是 SQLite 每次 DDL 的正常行为，不是
 *     QQ 的校验指纹 —— 实测 QQ 自己也在持续改它（同一账号上从 85 涨到 93）。
 *   • 代价只有写放大（实测 30 万行插入 1.12s → 1.25s）和索引占用的空间。
 *
 * ── 什么时候建 ──────────────────────────────────────────────────────────────
 * 一次性成本、永久受益，所以放在「账号打开后的后台」：见
 * `AppContext.warmAnnualReportIndex`。**不要**放在打开报告时 —— native 对同一个
 * 库的查询是串行化的（实测慢查询会把同库的 `SELECT 1` 挡 1.5s），在报告打开
 * 的那一刻建索引，恰好会让第一页自己多等一次建索引的时间，与优化目的相悖。
 *
 * {@link ensure} 用 `IF NOT EXISTS` 且幂等：已存在时是零重建的 no-op（实测
 * ~9ms），所以可以每次开账号无脑调一次。**一律 best-effort**：静态快照 / 只读
 * 目录 / 无写权限时由调用方吞掉失败 —— 报告不该因为装不上索引就打不开，只是慢。
 *
 * ⚠️ 与防撤回一样，写的是 QQ 的实时库。写入是一次短 DDL，锁随写随放，QQ 开着
 *    也能执行（已在 QQ 运行状态下实测通过）。
 */

import type { DatabaseAlgorithms, NtHelperBinding } from '@weq/native';
import { QqDb } from '../qq_db';

/**
 * 两个索引的固定名字。带用途前缀，避免与 QQ 自己的 `xxx_msg_table_idx…`
 * 命名空间混淆，也便于 {@link AnnualReportIndexDb.status} 精确识别。
 *
 * ⚠️ 索引名在 SQLite 里是**整库唯一**的（index 属于库、不属于表），所以两张表
 *    必须用不同的名字 —— 否则第二条 `IF NOT EXISTS` 会被静默跳过。
 */
const ANNUAL_INDEXES: ReadonlyArray<{ name: string; table: string }> = [
  { name: 'weq_annual_sendtime_dir_group', table: 'group_msg_table' },
  { name: 'weq_annual_sendtime_dir_c2c', table: 'c2c_msg_table' },
];

/** 过滤列（sendTime）在前、取值列（sentSource）在后 —— 两者都留在索引里。 */
const INDEX_COLUMNS = '"40050","40040"';

export interface AnnualReportIndexInfo {
  name: string;
  table: string;
}

export class AnnualReportIndexDb {
  private readonly qq: QqDb;

  constructor(
    nt: NtHelperBinding,
    opts: { dbPath: string; key?: string; algo?: DatabaseAlgorithms },
  ) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** 当前库里实际存在的年度报告索引。 */
  async status(): Promise<AnnualReportIndexInfo[]> {
    const placeholders = ANNUAL_INDEXES.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT name, tbl_name FROM sqlite_master
        WHERE type = 'index' AND name IN (${placeholders})
        ORDER BY name`,
      ANNUAL_INDEXES.map((index) => index.name),
    );
    return rows.map((row) => ({ name: String(row[0]), table: String(row[1]) }));
  }

  /**
   * 缺哪个建哪个。已存在的索引是零重建的 no-op（`IF NOT EXISTS` 不会重扫表），
   * 所以可以在每次开账号时无脑调用一次。
   */
  async ensure(): Promise<AnnualReportIndexInfo[]> {
    for (const index of ANNUAL_INDEXES) {
      await this.qq.write(
        `CREATE INDEX IF NOT EXISTS ${index.name} ON ${index.table}(${INDEX_COLUMNS})`,
      );
    }
    return this.status();
  }

  /** 释放本库的缓存连接（与 AntiRecallDb 同款收尾）。 */
  close(): void {
    this.qq.close();
  }
}
