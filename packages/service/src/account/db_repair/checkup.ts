/**
 * 库「体检」的结论口径。
 *
 * 背景：修复不是"扫一下看看"，它是**重建 + 替换** —— 源库文件从此不再在用。所以面板
 * 不能只摆一个「开始修复」，得先回答"坏不坏、坏在哪、能不能判"（妙妙工具 → 数据库修复
 * 的第 ③ 步）。两格检查：结构（`PRAGMA integrity_check`）与页级（逐页页签名）。
 *
 * 为什么不写在 router 里：这段是**纯函数 + 文案**，而它的错法与别的渲染逻辑不同 ——
 * 「页签名不可校验」一旦被写成「完好」，就是一句无声的谎（用户会以为没事）；「结构检查
 * 没跑成」被写成「损坏」又会白白吓人。两种边界都要能离线钉住，所以放在这一层（与
 * `report.ts` 同一个位置），由 `packages/service/test/db_repair_checkup.test.ts` 守住。
 *
 * 检查本身（native 的 `checkDatabaseHealth` / `scanBadPages`）由主进程注入 —— 这里只认
 * "两格各自跑成没跑成"和页级报告的形状，不碰文件、不碰 native。
 */

import type { BadPageScanReport } from '../bad_pages';

/** 体检的结论（严重程度从下到上）。 */
export type DbRepairCheckupVerdict =
  /** 结构完好，且页签名全部通过。 */
  | 'healthy'
  /** 结构完好，但**判不了页层面**（没开页 HMAC / 明文 / 页扫描没跑成）。 */
  | 'healthy-unverified'
  /** （结构可能完好但）确实扫出了坏页。 */
  | 'pages-bad'
  /** 结构损坏（`integrity_check` 报表损坏 / 整体损坏）。 */
  | 'corrupted'
  /** 两格检查都没跑起来（没密钥、native 缺产物……）。 */
  | 'error';

/** 结构体检那一格。 */
export type DbRepairCheckupIntegrity =
  | { ran: true; healthy: boolean; corruptedTables: string[] }
  | { ran: false; error: string };

/**
 * 页级体检那一格。
 *
 * `report.usedHmac === false` 表示**跑成了但没法判** —— 不是"库是好的"
 * （见 `../bad_pages.ts` 文件头）。
 */
export type DbRepairCheckupPages =
  | { ran: true; report: BadPageScanReport }
  | { ran: false; error: string };

/** 一次体检的完整结果（主进程直接把它交给渲染层展示）。 */
export interface DbRepairCheckup {
  dbName: string;
  dbPath: string;
  bytes: number;
  integrity: DbRepairCheckupIntegrity;
  pages: DbRepairCheckupPages;
  verdict: DbRepairCheckupVerdict;
  /** 一句话结论（给用户看的句子，界面照抄，口径只在这里写）。 */
  summary: string;
}

/**
 * 两格检查 → 一句结论。
 *
 * 优先级即严重程度：**结构损坏 > 坏页 > 完好**。两个边界特意写清楚（它们都曾经很容易
 * 被写成"没问题"）：
 *
 *   1. 页签名不可校验（`usedHmac === false`）**不能**说成"完好" —— 那只是"这个库没有可
 *      校验的签名"，要说"结构完好、页未校验"；
 *   2. 结构检查没跑成而页级跑成了且没坏页，也只能是"未判定"而不是"完好"。
 */
export function concludeCheckup(
  integrity: DbRepairCheckupIntegrity,
  pages: DbRepairCheckupPages,
): { verdict: DbRepairCheckupVerdict; summary: string } {
  if (!integrity.ran && !pages.ran) {
    return { verdict: 'error', summary: `检查没跑起来：${integrity.error}` };
  }

  if (integrity.ran && !integrity.healthy) {
    const tables = integrity.corruptedTables;
    return {
      verdict: 'corrupted',
      summary:
        tables.length > 0
          ? `结构损坏：${tables.join('、')}。修复会重建这个库，把还能读出来的内容搬过去。`
          : '结构损坏（整体损坏，未能定位到具体表）。修复会重建这个库，把还能读出来的内容搬过去。',
    };
  }

  if (pages.ran && pages.report.badPages.length > 0) {
    const { badPages, pageCount, affected } = pages.report;
    return {
      verdict: 'pages-bad',
      summary: `扫出 ${badPages.length} 个坏页（共 ${pageCount} 页）${
        affected.length > 0 ? `，波及 ${affected.length} 个表 / 索引` : ''
      }。修复会把它们排除在重建产物之外。`,
    };
  }

  if (integrity.ran && integrity.healthy) {
    if (!pages.ran) {
      return {
        verdict: 'healthy-unverified',
        summary: `结构完好；页层面没查成（${pages.error}），所以只能算未判定。`,
      };
    }
    if (!pages.report.usedHmac) {
      return {
        verdict: 'healthy-unverified',
        summary: '结构完好；但这个库没有开启页 HMAC，无法逐页校验 —— 这不代表页层面一定没问题。',
      };
    }
    return {
      verdict: 'healthy',
      summary: `结构完好，${pages.report.pageCount} 个页的页签名也全部通过。`,
    };
  }

  // 走到这里只剩一种情况：结构检查没跑成，而页级跑成了且没发现坏页 —— 只能算未判定。
  return {
    verdict: 'healthy-unverified',
    summary: `结构检查没跑成（${integrity.ran ? '未知原因' : integrity.error}）；页层面没发现坏页。`,
  };
}
