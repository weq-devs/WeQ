/**
 * 修复报告（人读 markdown）。
 *
 * 与 `db_health.ts` 的检查报告是**两份东西**：那份说"哪个库坏了"，这份说"我对它做了
 * 什么、结果如何、怎么退回去"。所以这里必须写清三件事，一句都不能省：
 *
 *   1. **这是重建不是打补丁** —— 输出库没有 freelist 空洞，页数 / 体积会变；
 *   2. **坏页上的内容无法校验** —— 页 HMAC 失败意味着解密结果可能被 CBC 糊掉，
 *      只有 `strictPages` 模式才保证"内容都经过校验"（代价是明确丢那些行）；
 *   3. **读不出来的 cell 会丢** —— 只给对账口径，不承诺"零丢失"。
 */

import type { DbRepairRecord } from './types';

const STATE_LABEL: Record<DbRepairRecord['state'], string> = {
  applied: '已修复并替换',
  aborted: '已中止（源库未被改动）',
  'apply-failed': '修复失败',
  'rolled-back': '已回滚到修复前',
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB（${bytes} 字节）`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function listOrDash(values: readonly number[]): string {
  return values.length === 0 ? '（无）' : values.join(', ');
}

export interface DbRepairReportOptions {
  /** WeQ 版本；拿不到可省（报告里会写"未知"）。 */
  appVersion?: string;
}

/** 渲染一份修复报告。 */
export function renderDbRepairReportMarkdown(
  record: DbRepairRecord,
  options: DbRepairReportOptions = {},
): string {
  const lines: string[] = [];
  lines.push('# WeQ 数据库修复报告');
  lines.push('');
  lines.push(`- 生成时间：${formatLocalTime(new Date().toISOString())}`);
  lines.push(`- 修复时间：${formatLocalTime(record.at)}`);
  lines.push(`- 账号：${record.uin}`);
  lines.push(`- 数据目录：${record.dataDir ?? '（平台默认解析）'}`);
  lines.push(`- 数据库：${record.dbName}`);
  lines.push(`- 数据库路径：${record.dbPath}`);
  lines.push(`- WeQ 版本：${options.appVersion ?? '未知'}`);
  lines.push(`- 记录 ID：${record.id}`);
  lines.push('');
  lines.push('## 结果');
  lines.push('');
  lines.push(`- 状态：${STATE_LABEL[record.state]}`);
  if (record.error) lines.push(`- 原因：${record.error}`);
  lines.push(`- 耗时：${formatDuration(record.durationMs)}`);
  lines.push(
    `- 页模式：${record.strictPages ? '严格（坏页清零，明确丢这些行）' : '宽容（坏页上的未校验内容也写进新库，恢复率最高）'}`,
  );
  lines.push(`- 修复前 sha256：\`${record.beforeSha}\``);
  lines.push(`- 修复后 sha256：${record.afterSha ? `\`${record.afterSha}\`` : '—'}`);
  lines.push(`- 体积：${formatBytes(record.beforeBytes)} → ${formatBytes(record.afterBytes)}`);
  lines.push('');
  lines.push('## 修复前的状态');
  lines.push('');
  lines.push(`- 页大小：${record.pageSize ?? '—'}`);
  lines.push(`- 页数：${record.sourcePages ?? '—'}`);
  lines.push(`- 自定义头长度：${record.headerOffset ?? '—'} 字节`);
  lines.push(`- **物理坏页（页 HMAC 失败，内容不可信）**：${listOrDash(record.badPages)}`);
  lines.push(`- 全零页：${listOrDash(record.zeroPages)}`);
  lines.push(
    `- 未合并的 WAL：${record.pendingWalBytes > 0 ? `**${formatBytes(record.pendingWalBytes)}**` : '无'}`,
  );
  if (record.pendingWalBytes > 0 && record.walMerged) {
    lines.push('');
    lines.push(
      `  ✔ 修复前已把这份 \`-wal\` **合并回主文件**（\`PRAGMA wal_checkpoint(TRUNCATE)\`，内容不变），所以这批改动**包含在本次修复与备份里**。`,
    );
  }
  if (record.pendingWalBytes > 0 && !record.walMerged) {
    lines.push('');
    lines.push(
      `  ⚠ 源库旁边有一个 **${formatBytes(record.pendingWalBytes)} 的 \`-wal\`**（QQ 上次没有正常退出），而这次**没能把它合并回主文件**。这是预写日志里还没合并的帧，而修复走的是**页级读取，只看得见主文件** —— 所以这批改动不在本次修复范围内，修完可能比修复前少最后一段消息。下次请先正常启动并关闭一次 QQ（它会把 WAL 合并回主文件）再修复；修复产物旁边那份旧的 \`-wal\` 已被清理，否则它会污染新库。`,
    );
  }
  lines.push('');
  lines.push('## 过程');
  lines.push('');
  if (record.phases.length === 0) {
    lines.push('（本次没有留下阶段耗时）');
  } else {
    lines.push('| 阶段 | 耗时 |');
    lines.push('| --- | --- |');
    for (const phase of record.phases) {
      lines.push(`| ${phase.phase} | ${formatDuration(phase.ms)} |`);
    }
  }
  lines.push('');
  lines.push(
    `- 扫过的 cell 数量：${record.scannedCells ?? '—'}（**不是行数**：一行的每个字段算一个 cell）`,
  );
  lines.push('');
  lines.push('## 产物自检');
  lines.push('');
  if (!record.verification) {
    lines.push('（没有自检结果 —— 修复没有走到替换那一步）');
  } else {
    lines.push(`- 完整性检查：${record.verification.healthy ? '通过' : '**未通过**'}`);
    lines.push(
      `- 有问题的表：${record.verification.corruptedTables.length === 0 ? '（无）' : record.verification.corruptedTables.join('、')}`,
    );
    lines.push(`- 产物里仍失败的页：${listOrDash(record.verification.badPages)}`);
    lines.push(`- 表 / 索引数量：${record.verification.tables} / ${record.verification.indexes}`);
    lines.push(`- 产物页数：${record.outputPages ?? '—'}`);
  }
  lines.push('');
  lines.push('## 备份与回滚');
  lines.push('');
  if (record.backupPath && record.purgedAt === undefined) {
    lines.push(`- 备份：\`${record.backupPath}\``);
    lines.push(`- 备份体积：${formatBytes(record.backupBytes)}`);
    lines.push('- 回滚方式：妙妙工具 → 数据库修复 → 记录列表 → 「回滚」');
  } else if (record.backupPath && record.purgedAt !== undefined) {
    lines.push(`- 备份已被保留策略清理（${formatLocalTime(record.purgedAt)}），不可回滚。`);
  } else {
    lines.push('- 本次没有做备份（回滚不可用）。');
  }
  if (record.restoredAt) {
    lines.push(`- 已回滚时间：${formatLocalTime(record.restoredAt)}`);
  }
  lines.push('');
  lines.push('## 必须知道的边界');
  lines.push('');
  lines.push(
    '1. **这是重建，不是打补丁**：产物是一份全新的库，页布局与原来不同（没有 freelist 空洞），所以页数 / 体积会变，这是正常的。',
  );
  lines.push(
    '2. **坏页上的内容无法校验**：页 HMAC 失败说明那一页的解密结果可能已被损坏点附近的字节影响。宽容模式会把这些内容写进新库以换取最大恢复率；严格模式先清零坏页，内容一定经过校验，但那几行明确丢失。',
  );
  lines.push(
    '3. **读不出来的 cell 会丢**：修复只保证"能解析的都留下"，不承诺零丢失。判断丢了多少只能靠对账（行数 / 会话数量 / 具体消息），而不是靠体积。',
  );
  lines.push('');
  return lines.join('\n');
}
