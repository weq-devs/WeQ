import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicSync } from '../../common/atomic_write';
import type { DatabaseMaintenanceReport } from './maintenance_types';
import {
  databaseRepairSupportLabel,
  databaseMaintenanceKindLabel,
  databaseMaintenanceStatusLabel,
  databaseRepairStatusLabel,
} from './maintenance_types';

export class DatabaseMaintenanceReports {
  constructor(private readonly directory: string) {}

  save(report: DatabaseMaintenanceReport): void {
    mkdirSync(this.directory, { recursive: true });
    writeFileAtomicSync(this.path(report.operation.id), JSON.stringify(report));
  }

  get(id: string): DatabaseMaintenanceReport | null {
    const path = this.path(id);
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, 'utf8')) as DatabaseMaintenanceReport;
    if (value.operation?.id !== id || !Array.isArray(value.databases))
      throw new Error('数据库维护报告内容无效。');
    return value;
  }

  list(): DatabaseMaintenanceReport[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter((name) => /^[\w-]+\.json$/.test(name))
      .flatMap((name) => {
        try {
          const report = this.get(name.slice(0, -5));
          return report ? [report] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.operation.startedAt - a.operation.startedAt);
  }

  remove(id: string): boolean {
    const path = this.path(id);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  private path(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('数据库维护报告标识无效。');
    return join(this.directory, `${id}.json`);
  }
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!,
  );
}
export function renderDatabaseMaintenanceReport(
  report: DatabaseMaintenanceReport,
  format: 'html' | 'md' | 'json',
): string {
  if (format === 'json') return JSON.stringify(report, null, 2);
  const op = report.operation;
  const title = `${databaseMaintenanceKindLabel[op.kind]}报告`;
  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(op.startedAt);
  const lines = [
    `# ${title}`,
    '',
    `账号：${report.uin}`,
    `数据源：${report.configId ?? '默认数据源'}`,
    `开始时间：${date}（北京时间）`,
    `执行状态：${databaseMaintenanceStatusLabel[op.status]}`,
    `完成数据库：${op.completedDatabases} / ${op.totalDatabases}`,
    `执行耗时：${(op.elapsedMs / 1000).toFixed(1)} 秒`,
    ...(op.error ? [`执行错误：${op.error}`] : []),
  ];
  for (const row of report.databases) {
    lines.push(
      '',
      `## ${row.dbName}`,
      '',
      `快速体检：${row.scanStatus === 'completed' ? '已完成' : (row.scanError ?? '未完成')}`,
      `修复能力：${databaseRepairSupportLabel[row.support]}`,
    );
    if (row.scan?.plaintext) lines.push('明文数据库：未执行加密页签名检查，当前重建工具不支持。');
    else if (row.scan)
      lines.push(
        `完整页：${row.scan.pageCount}；坏页：${row.scan.badPages.length}；全零页：${row.scan.zeroPages.length}；尾部残余：${row.scan.trailingBytes} 字节`,
      );
    if (row.integrity)
      lines.push(
        `结构诊断：${row.integrity.ran ? (row.integrity.healthy ? (row.integrity.complete === false ? '已检查部分正常，仍有未核验项' : '正常') : `发现异常：${row.integrity.corruptedTables.join('、') || '整体结构'}`) : `未完成：${row.integrity.error}`}`,
      );
    if (row.integrity?.ran && row.integrity.unverifiedTables?.length)
      lines.push(`未核验结构：${row.integrity.unverifiedTables.join('、')}`);
    for (const issue of row.issues)
      lines.push(`- ${issue.message}（${databaseRepairSupportLabel[issue.support]}）`);
    if (row.repair)
      lines.push(
        `修复结果：${databaseRepairStatusLabel[row.repair.status]}${row.repair.error ? `：${row.repair.error}` : ''}`,
      );
    if (row.repair?.record) lines.push(`修复记录：${row.repair.record.id}`);
    if (row.progress)
      for (const step of row.progress.steps)
        lines.push(
          `- ${step.message}：${step.status ?? 'running'}${step.completed === undefined ? '' : `，${step.completed}${step.total === undefined ? '' : ` / ${step.total}`} ${step.unit ?? ''}`}${step.objectName ? `，${step.objectName}` : ''}${step.detail ? `；${step.detail}` : ''}`,
        );
  }
  if (format === 'md') return `${lines.join('\n')}\n`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:14px/1.7 system-ui,sans-serif;max-width:980px;margin:32px auto;padding:0 24px;color:#242424;background:#fff}h1{font-size:24px}h2{font-size:18px;border-bottom:1px solid #ccc;padding-bottom:8px}p,li{overflow-wrap:anywhere}@media(prefers-color-scheme:dark){body{color:#eee;background:#191919}h2{border-color:#555}}</style>${lines.map((line) => (line.startsWith('# ') ? `<h1>${escapeHtml(line.slice(2))}</h1>` : line.startsWith('## ') ? `<h2>${escapeHtml(line.slice(3))}</h2>` : line.startsWith('- ') ? `<p>• ${escapeHtml(line.slice(2))}</p>` : line ? `<p>${escapeHtml(line)}</p>` : '')).join('')}</html>`;
}
