import ExcelJS from 'exceljs';
import { stat } from 'node:fs/promises';
import { createExportWriter } from './stream_utils';
import { escapeCsv } from './table_writer';
import type { ArchiveEntry } from './archive';
import type { ExportResult } from './types';

const headings = ['对象类型', '对象身份', '内容', '附加属性', '资源'];
const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
/** 元数据与资源视图共用正式记录，不为 TXT/表格另留隐藏 JSON 正文。 */
export async function writeArchiveView(
  path: string,
  format: 'txt' | 'csv' | 'xlsx' | 'html',
  produce: (emit: (entry: ArchiveEntry) => Promise<void>) => Promise<ExportResult>,
): Promise<ExportResult> {
  const workbook =
    format === 'xlsx'
      ? new ExcelJS.stream.xlsx.WorkbookWriter({
          filename: path,
          useStyles: false,
          useSharedStrings: false,
        })
      : null;
  const sheet = workbook?.addWorksheet('导出数据');
  const writer = workbook ? null : createExportWriter(path);
  const write = async (text: string) => {
    if (writer) await writer.write(text);
  };
  sheet?.addRow(headings).commit();
  if (format === 'csv') await write(`\uFEFF${headings.map(escapeCsv).join(',')}\r\n`);
  if (format === 'html')
    await write(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>导出数据</title><style>body{font:14px/1.5 system-ui;margin:16px;color:#202124;background:#fff}table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{border:1px solid #ccc;padding:8px;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap}@media(prefers-color-scheme:dark){body{color:#eee;background:#161616}td,th{border-color:#555}}</style><table><thead><tr>${headings.map((heading) => `<th>${escapeHtml(heading)}</th>`).join('')}</tr></thead><tbody>`,
    );
  let result: ExportResult;
  try {
    result = await produce(async (entry) => {
      const cells = [
        entry.record.kind,
        entry.record.id,
        JSON.stringify(entry.record.data),
        JSON.stringify(entry.record.native ?? {}),
        JSON.stringify(entry.resources ?? []),
      ];
      if (sheet) sheet.addRow(cells).commit();
      else if (format === 'csv') await write(`${cells.map(escapeCsv).join(',')}\r\n`);
      else if (format === 'html')
        await write(`<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`);
      else
        await write(`${cells.map((cell, index) => `${headings[index]}: ${cell}`).join('\n')}\n\n`);
    });
    if (format === 'html') await write('</tbody></table></html>');
    if (sheet && workbook) {
      sheet.commit();
      await workbook.commit();
    }
  } finally {
    if (writer) await writer.end();
  }
  return { ...result, filePath: path, format, fileSize: (await stat(path)).size };
}
