/**
 * 坏页扫描（"坏页地图"）：逐页复算 SQLCipher 的页 HMAC，并把坏页映射到受影响的表 / 索引。
 *
 * 为什么单独一层：**设置页的宽容区块**和**妙妙工具的数据库修复页**都要用同一个口径
 * （修复前先看清坏在哪，修完再对照）。原来这段逻辑长在 `account` router 里、只认"当前
 * 打开的账号"，而修复页要能对任意账号用，所以抽到这里：
 *
 *   - 能力检查在这里做（"真要用就先点名"）—— 两个入口因此都不会退化成
 *     `undefined is not a function`；
 *   - 调用方只管把 dbPath / dbName / key / algo 凑齐（账号配置或已开账号都行）。
 *
 * ⚠ `usedHmac === false` 时 `badPages` 必然为空 —— 那不是"库是好的"，而是"这个库没开
 * 页 HMAC（或它压根是明文库，见 `plaintext`），地图没有意义"。界面必须如实展示。
 */

import { assertSalvageCapable } from '@weq/db';
import type { BadPageScanResult, DatabaseAlgorithms, NtHelperBinding } from '@weq/native';

/** 一个被坏页波及的表 / 索引。 */
export interface AffectedObject {
  name: string;
  pagetype: string;
  badPageCount: number;
  /** 样例页号（最多 {@link AFFECTED_SAMPLE_PAGES} 个），避免一次传输上千个。 */
  samplePages: number[];
}

/** 一次坏页扫描的完整报告。 */
export interface BadPageScanReport extends BadPageScanResult {
  dbName: string;
  dbPath: string;
  /** `dbstat` 查不到时为空数组 —— 只意味着"没映射出来"，不代表没有坏页。 */
  affected: AffectedObject[];
}

/** 每个受影响对象最多回传的样例页号数量。 */
export const AFFECTED_SAMPLE_PAGES = 20;

export interface ScanBadPagesInput {
  dbPath: string;
  /** 库文件名（只用于报告展示；`dbPath` 由调用方解析，渲染层永远不传路径）。 */
  dbName: string;
  key: string;
  algo: DatabaseAlgorithms;
}

/**
 * 扫一个库的坏页并映射到对象。
 *
 * `dbstat` 本身查不出来（库坏得比较重，或版本没开该虚表）时 `affected` 为空数组，不报错：
 * 页号清单本身已经比 `PRAGMA integrity_check` 那句"某表损坏"有信息量。
 */
export async function scanDatabaseBadPages(
  nt: NtHelperBinding,
  input: ScanBadPagesInput,
): Promise<BadPageScanReport> {
  assertSalvageCapable(nt, '坏页扫描', ['scanBadPages']);
  const scan = await nt.scanBadPages(input.dbPath, input.key, input.algo);
  const affected = await mapBadPagesToObjects(
    nt,
    input.dbPath,
    input.key,
    input.algo,
    scan.badPages,
  );
  return { ...scan, dbName: input.dbName, dbPath: input.dbPath, affected };
}

/**
 * 把坏页映射到具体的表 / 索引。
 *
 * 依据 `dbstat` 虚表（bundled 的 SQLite 已开启 `SQLITE_ENABLE_DBSTAT_VTAB`）：它给出
 * 每个对象占用的页号，与坏页清单求交集就能回答"哪些表受影响"。这就是坏页地图比
 * `PRAGMA integrity_check` 强的地方 —— 后者只能给一句"某表损坏"。
 */
export async function mapBadPagesToObjects(
  nt: NtHelperBinding,
  dbPath: string,
  key: string,
  algo: DatabaseAlgorithms,
  badPages: number[],
): Promise<AffectedObject[]> {
  if (badPages.length === 0) return [];
  const bad = new Set(badPages);
  try {
    const rows = await nt.executeSqlWithKey(
      dbPath,
      'SELECT name, pagetype, pageno FROM dbstat',
      key,
      algo,
    );
    const byObject = new Map<string, AffectedObject>();
    for (const row of rows) {
      const pageno = Number(row[2]);
      if (!bad.has(pageno)) continue;
      const name = String(row[0] ?? '');
      const pagetype = String(row[1] ?? '');
      const entry = byObject.get(name) ?? { name, pagetype, badPageCount: 0, samplePages: [] };
      entry.badPageCount += 1;
      if (entry.samplePages.length < AFFECTED_SAMPLE_PAGES) entry.samplePages.push(pageno);
      byObject.set(name, entry);
    }
    return [...byObject.values()].sort((a, b) => b.badPageCount - a.badPageCount);
  } catch {
    return [];
  }
}
