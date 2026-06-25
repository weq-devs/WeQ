/**
 * CSV exporter — streams a conversation to a comma-separated table, one row per
 * message (columns per {@link TABLE_HEADERS}). Media collapse to bracket labels
 * via {@link elementsToText}, same as TXT.
 *
 * The framing / row renderer are exported so both the group path (via
 * {@link runGroupExport}) and the c2c path (task_manager) share one definition.
 * Output uses CRLF line endings and a leading UTF-8 BOM so Excel opens the
 * Chinese text without mojibake.
 */

import type { MsgService } from '../msg';
import { runGroupExport, type Framing } from './run_export';
import { TABLE_HEADERS, messageToCells } from './element_text';
import type { ExportedMessage, ExportResult, GroupExportOptions } from './types';

/** Quote a field iff it contains a comma, quote or newline; double inner quotes. */
function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** UTF-8 BOM + header row; no separator / tail (each row carries its own CRLF). */
export const csvFraming: Framing = {
  head: `﻿${TABLE_HEADERS.map(escapeCsv).join(',')}\r\n`,
  between: '',
  tail: '',
};

/** One message → a single CSV line (trailing CRLF included). */
export function renderCsvRow(m: ExportedMessage): string {
  return `${messageToCells(m).map(escapeCsv).join(',')}\r\n`;
}

/** Export all messages of `groupCode` to `outputPath` as a CSV table. */
export async function exportGroupToCsv(
  msgs: MsgService,
  opts: GroupExportOptions,
): Promise<ExportResult> {
  return runGroupExport(msgs, opts, 'csv', csvFraming, renderCsvRow);
}
