import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { formatDateTime } from '@weq/time';
import { writeFileAtomic } from '../../common/atomic_write';
import type { DatabaseMaintenanceReport } from './maintenance_types';
import type { DbRepairRecord } from './types';
import {
  databaseRepairSupportLabel,
  databaseMaintenanceKindLabel,
  databaseMaintenanceStatusLabel,
  databaseRepairStatusLabel,
} from './maintenance_types';

export type DatabaseMaintenanceReportHeader = Pick<
  DatabaseMaintenanceReport,
  'uin' | 'configId' | 'operation'
>;

const reportWorkerSource = `
const { parentPort } = require('node:worker_threads');
const { readFile, readdir } = require('node:fs/promises');
const { join } = require('node:path');
async function report(path, id) {
  const raw = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (value.operation?.id !== id || !Array.isArray(value.databases))
    throw new Error('数据库维护报告内容无效。');
  return value;
}
parentPort.on('message', async ({ requestId, command }) => {
  try {
    if (command.kind === 'serialize') {
      const bytes = new TextEncoder().encode(JSON.stringify(command.report));
      parentPort.postMessage({ requestId, value: bytes }, [bytes.buffer]);
      return;
    }
    if (command.kind === 'read') {
      parentPort.postMessage({ requestId, value: await report(command.path, command.id) });
      return;
    }
    const names = await readdir(command.directory).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const headers = [];
    for (const name of names) {
      if (!/^[\\w-]+\\.json$/.test(name)) continue;
      try {
        const value = await report(join(command.directory, name), name.slice(0, -5));
        if (value) headers.push({
          uin: value.uin, configId: value.configId, operation: value.operation,
        });
      } catch {
        // 单份损坏报告不影响其余历史。
      }
    }
    parentPort.postMessage({ requestId, value: headers });
  } catch (error) {
    parentPort.postMessage({ requestId, error: error.message });
  }
});
`;

type ReportCommand =
  | { kind: 'serialize'; report: DatabaseMaintenanceReport }
  | { kind: 'read'; path: string; id: string }
  | { kind: 'headers'; directory: string };
let reportWorker: Worker | undefined;
let nextRequest = 0;
const requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

function runReportCommand<T>(command: ReportCommand): Promise<T> {
  if (requests.size >= 32) return Promise.reject(new Error('维护报告读取队列繁忙，请稍后重试。'));
  if (!reportWorker) {
    const created = new Worker(reportWorkerSource, { eval: true });
    const failed = (error: Error) => {
      if (reportWorker !== created) return;
      reportWorker = undefined;
      for (const request of requests.values()) request.reject(error);
      requests.clear();
    };
    created.on('error', failed);
    created.on('exit', () => failed(new Error('维护报告进程已退出。')));
    created.on('message', ({ requestId, value, error }) => {
      const request = requests.get(requestId);
      if (!request) return;
      requests.delete(requestId);
      if (!requests.size) created.unref();
      if (error) request.reject(new Error(error));
      else request.resolve(value);
    });
    reportWorker = created;
  }
  const worker = reportWorker;
  const requestId = ++nextRequest;
  return new Promise<T>((resolve, reject) => {
    requests.set(requestId, { resolve: (value) => resolve(value as T), reject });
    worker.ref();
    try {
      worker.postMessage({ requestId, command });
    } catch (error) {
      requests.delete(requestId);
      if (!requests.size) worker.unref();
      reject(error);
    }
  });
}

export class DatabaseMaintenanceReports {
  constructor(private readonly directory: string) {}

  async save(report: DatabaseMaintenanceReport): Promise<void> {
    const bytes = await runReportCommand<Uint8Array>({ kind: 'serialize', report });
    await writeFileAtomic(this.path(report.operation.id), bytes);
  }

  get(id: string): Promise<DatabaseMaintenanceReport | null> {
    return runReportCommand({ kind: 'read', path: this.path(id), id });
  }

  async list(): Promise<DatabaseMaintenanceReportHeader[]> {
    const headers = await runReportCommand<DatabaseMaintenanceReportHeader[]>({
      kind: 'headers',
      directory: this.directory,
    });
    return headers.sort((a, b) => b.operation.startedAt - a.operation.startedAt);
  }

  async remove(id: string): Promise<boolean> {
    try {
      await unlink(this.path(id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
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

function repairResultLines(record: DbRepairRecord): string[] {
  const bytes = (value: number | null) => (value === null ? '未知' : `${value} 字节`);
  const pages = (values: number[]) => (values.length ? values.join('、') : '无');
  const lines = [
    `修复前后体积：${bytes(record.beforeBytes)} → ${bytes(record.afterBytes)}`,
    `修复前页签名异常：${pages(record.badPages)}`,
    `修复前全零页：${pages(record.zeroPages)}`,
    `修复耗时：${(record.durationMs / 1000).toFixed(3)} 秒`,
  ];
  for (const phase of record.phases)
    lines.push(`阶段耗时（${phase.phase}）：${(phase.ms / 1000).toFixed(3)} 秒`);
  const check = record.verification;
  if (!check) return [...lines, '产物自检：没有自检结果'];
  const unverified = check.complete === false || !!check.unverifiedTables?.length;
  lines.push(
    `产物自检：${!check.healthy || check.badPages.length ? '未通过' : unverified ? '已检查部分通过，仍有未核验项' : '通过'}`,
    `产物异常表：${check.corruptedTables.join('、') || '无'}`,
    `产物页签名异常：${pages(check.badPages)}`,
    `产物表／索引数量：${check.tables} / ${check.indexes}`,
  );
  if (unverified)
    lines.push(`产物未核验结构：${check.unverifiedTables?.join('、') || '部分结构检查'}`);
  return lines;
}

export function renderDatabaseMaintenanceReport(
  report: DatabaseMaintenanceReport,
  format: 'html' | 'md' | 'json',
): string {
  if (format === 'json') return JSON.stringify(report, null, 2);
  const op = report.operation;
  const title = `${databaseMaintenanceKindLabel[op.kind]}报告`;
  const date = formatDateTime(op.startedAt);
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
    if (row.repair?.record)
      lines.push(`修复记录：${row.repair.record.id}`, ...repairResultLines(row.repair.record));
    if (row.progress)
      for (const step of row.progress.steps)
        lines.push(
          `- ${step.message}：${step.status ?? 'running'}${step.completed === undefined ? '' : `，${step.completed}${step.total === undefined ? '' : ` / ${step.total}`} ${step.unit ?? ''}`}${step.objectName ? `，${step.objectName}` : ''}${step.detail ? `；${step.detail}` : ''}`,
        );
  }
  if (format === 'md') return `${lines.join('\n')}\n`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:14px/1.7 system-ui,sans-serif;max-width:980px;margin:32px auto;padding:0 24px;color:#242424;background:#fff}h1{font-size:24px}h2{font-size:18px;border-bottom:1px solid #ccc;padding-bottom:8px}p,li{overflow-wrap:anywhere}@media(prefers-color-scheme:dark){body{color:#eee;background:#191919}h2{border-color:#555}}</style>${lines.map((line) => (line.startsWith('# ') ? `<h1>${escapeHtml(line.slice(2))}</h1>` : line.startsWith('## ') ? `<h2>${escapeHtml(line.slice(3))}</h2>` : line.startsWith('- ') ? `<p>• ${escapeHtml(line.slice(2))}</p>` : line ? `<p>${escapeHtml(line)}</p>` : '')).join('')}</html>`;
}
