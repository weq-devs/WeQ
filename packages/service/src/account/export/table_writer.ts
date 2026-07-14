/**
 * 通用「一行一记录」表格写盘器 —— 供联系人 / 收藏等**非消息流**导出复用。
 *
 * 一套列定义（`Col<T>` = json 键 + 中文表头 + 取值函数）驱动四种落盘格式：
 *   json  —— 英文键对象数组，便于程序消费
 *   csv   —— UTF-8 BOM + CRLF，Excel 直开不乱码
 *   xlsx  —— ExcelJS 流式单表
 *   txt   —— 每条一段「表头: 值」+ 分隔线
 *
 * 数据量级都不大（联系人 / 收藏），json/csv/txt 一次性拼好写盘；xlsx 走流式。
 */

import ExcelJS from 'exceljs';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';

/** 单元格取值只可能是字符串或数字。 */
export type Cell = string | number;

/** 一列的定义：json 键 + 中文表头 + 取值函数。 */
export interface Col<T> {
  key: string;
  header: string;
  get: (row: T) => Cell;
}

/** 表格格式（vcard 等特殊格式由调用方单独处理）。 */
export type TableFormat = 'json' | 'csv' | 'xlsx' | 'txt';

/** CSV 字段转义：含逗号/引号/换行时加引号，内部引号翻倍。 */
export function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 一次性把内容写到文件（联系人 / 收藏量级不大）。 */
export async function writeFileStream(outputPath: string, body: string): Promise<void> {
  const stream = createWriteStream(outputPath, { encoding: 'utf-8' });
  if (!stream.write(body)) await once(stream, 'drain');
  stream.end();
  await once(stream, 'finish');
}

/** json：对象数组（英文键，便于程序消费）。 */
export async function writeJson<T>(cols: Array<Col<T>>, rows: T[], outputPath: string): Promise<void> {
  const objects = rows.map((r) => Object.fromEntries(cols.map((c) => [c.key, c.get(r)])));
  await writeFileStream(outputPath, JSON.stringify(objects, null, 2));
}

/** csv：UTF-8 BOM + 表头 + 数据行（CRLF，Excel 直开不乱码）。 */
export async function writeCsv<T>(cols: Array<Col<T>>, rows: T[], outputPath: string): Promise<void> {
  const lines = [`﻿${cols.map((c) => escapeCsv(c.header)).join(',')}`];
  for (const r of rows) {
    lines.push(cols.map((c) => escapeCsv(String(c.get(r)))).join(','));
  }
  await writeFileStream(outputPath, lines.join('\r\n') + '\r\n');
}

/** txt：每条记录一段「表头: 值」+ 分隔线。 */
export async function writeTxt<T>(cols: Array<Col<T>>, rows: T[], outputPath: string): Promise<void> {
  const blocks = rows.map((r) => {
    const body = cols.map((c) => `${c.header}: ${String(c.get(r))}`).join('\n');
    return `${body}\n${'—'.repeat(24)}`;
  });
  await writeFileStream(outputPath, blocks.join('\n') + '\n');
}

/** xlsx：ExcelJS 流式写一张表（表头 + 每条一行）。 */
export async function writeXlsx<T>(
  cols: Array<Col<T>>,
  rows: T[],
  outputPath: string,
  sheetName: string,
): Promise<void> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: outputPath,
    useStyles: false,
    useSharedStrings: false,
  });
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(cols.map((c) => c.header)).commit();
  for (const r of rows) {
    sheet.addRow(cols.map((c) => c.get(r))).commit();
  }
  sheet.commit();
  await workbook.commit();
}

/** 按格式分派落盘。 */
export async function writeTable<T>(
  format: TableFormat,
  cols: Array<Col<T>>,
  rows: T[],
  outputPath: string,
  sheetName: string,
): Promise<void> {
  switch (format) {
    case 'json':
      return writeJson(cols, rows, outputPath);
    case 'csv':
      return writeCsv(cols, rows, outputPath);
    case 'xlsx':
      return writeXlsx(cols, rows, outputPath, sheetName);
    default:
      return writeTxt(cols, rows, outputPath);
  }
}
