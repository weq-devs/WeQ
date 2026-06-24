/**
 * XLSX exporter — streams a conversation into a real `.xlsx` workbook, one row
 * per message (columns per {@link TABLE_HEADERS}). Media collapse to bracket
 * labels via {@link elementsToText}, same as TXT / CSV.
 *
 * Unlike the text formats this can't ride {@link runGroupExport} (a workbook is
 * a binary ZIP, not a character stream), so it owns its own message loop over
 * {@link iterateGroupMessages} / {@link iterateC2cMessages}. It uses ExcelJS's
 * *streaming* WorkbookWriter (`row.commit()` flushes to disk as we go) so a
 * busy group with hundreds of thousands of messages never materializes in heap.
 *
 * Excel caps a sheet at 1,048,576 rows; we roll over to a fresh sheet well
 * under that so large groups don't silently truncate.
 */

import ExcelJS from 'exceljs';
import { statSync } from 'node:fs';
import type { MsgService } from '../msg';
import { iterateC2cMessages, iterateGroupMessages, toExportedMessage } from './message_source';
import { TABLE_HEADERS, messageToCells } from './element_text';
import type { ConvKind, ExportResult, ExportTimeRange, ProgressCallback } from './types';

/** Rows per worksheet before rolling to a new one (margin under Excel's cap). */
const SHEET_ROW_LIMIT = 1_000_000;

export interface XlsxExportOptions {
  /** Conversation kind (selects the message iterator). */
  kind: ConvKind;
  /** Group code (群号) or peer uid. */
  conv: string;
  /** Absolute path of the `.xlsx` file to write. */
  outputPath: string;
  /** Messages per DB round-trip. */
  pageSize?: number;
  /** Progress callback. */
  onProgress?: ProgressCallback;
  /** Emit a progress tick every N messages (default 5000). */
  progressEvery?: number;
  /** When provided, each message's sender uin is collected (avatar export). */
  collectSenders?: Set<string>;
  /** Inclusive send-time window; messages outside it are skipped. */
  range?: ExportTimeRange;
}

/** Append a header row to a freshly-created worksheet. */
function writeHeader(ws: ExcelJS.Worksheet): void {
  ws.addRow([...TABLE_HEADERS]).commit();
}

/** Export all messages of one conversation to `outputPath` as an XLSX workbook. */
export async function exportToXlsx(
  msgs: MsgService,
  opts: XlsxExportOptions,
): Promise<ExportResult> {
  const start = Date.now();
  const progressEvery = opts.progressEvery ?? 5000;

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: opts.outputPath,
    useStyles: false,
    useSharedStrings: false,
  });

  let sheet = workbook.addWorksheet('消息');
  writeHeader(sheet);
  let rowsInSheet = 0;
  let sheetIndex = 1;

  const iterator =
    opts.kind === 'group'
      ? iterateGroupMessages(msgs, opts.conv, { pageSize: opts.pageSize, range: opts.range })
      : iterateC2cMessages(msgs, opts.conv, { pageSize: opts.pageSize, range: opts.range });

  let count = 0;
  for await (const m of iterator) {
    if (rowsInSheet >= SHEET_ROW_LIMIT) {
      sheet.commit();
      sheetIndex += 1;
      sheet = workbook.addWorksheet(`消息${sheetIndex}`);
      writeHeader(sheet);
      rowsInSheet = 0;
    }
    const exported = toExportedMessage(m);
    opts.collectSenders?.add(exported.senderUin);
    sheet.addRow(messageToCells(exported)).commit();
    rowsInSheet += 1;
    count += 1;
    if (opts.onProgress && count % progressEvery === 0) {
      opts.onProgress({ current: count, message: `已导出 ${count} 条` });
    }
  }

  sheet.commit();
  await workbook.commit();

  return {
    filePath: opts.outputPath,
    format: 'xlsx',
    messageCount: count,
    fileSize: statSync(opts.outputPath).size,
    durationMs: Date.now() - start,
  };
}
