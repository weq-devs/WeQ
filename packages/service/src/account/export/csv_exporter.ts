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
import {
  exportTableSenderName,
  resolveGroupSenders,
  type SenderResolveDeps,
} from './sender_resolve';
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
export function renderCsvRow(m: ExportedMessage, senderName?: string): string {
  const name = senderName && /^[\s]*[=+@-]/.test(senderName) ? `'${senderName}` : senderName;
  return `${messageToCells(m, name).map(escapeCsv).join(',')}\r\n`;
}

/** Export all messages of `groupCode` to `outputPath` as a CSV table. */
export async function exportGroupToCsv(
  msgs: MsgService,
  opts: GroupExportOptions,
  deps: SenderResolveDeps = {},
): Promise<ExportResult> {
  const framing = opts.useRecordedSenderName
    ? { ...csvFraming, head: csvFraming.head.replace(/\r\n$/, ',发送者名称\r\n') }
    : csvFraming;
  const senders = opts.useRecordedSenderName
    ? await resolveGroupSenders(msgs, opts.groupCode, opts.range, deps, '', opts.roam)
    : undefined;
  return runGroupExport(msgs, opts, 'csv', framing, (message) =>
    renderCsvRow(message, senders ? exportTableSenderName(message, senders) : undefined),
  );
}
