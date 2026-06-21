/**
 * JSONL exporter — streams one {@link ExportedMessage} as compact JSON per line
 * (newline-delimited). Naturally streaming, low-memory, and trivially
 * line-by-line consumable by downstream tools; no array framing to track.
 */

import type { MsgService } from '../msg';
import { runGroupExport } from './run_export';
import { bigintReplacer } from './serialize';
import type { ExportResult, GroupExportOptions } from './types';

/** Export all messages of `groupCode` to `outputPath` as JSONL (one per line). */
export async function exportGroupToJsonl(
  msgs: MsgService,
  opts: GroupExportOptions,
): Promise<ExportResult> {
  return runGroupExport(
    msgs,
    opts,
    'jsonl',
    { head: '', between: '', tail: '' },
    (m) => `${JSON.stringify(m, bigintReplacer)}\n`,
  );
}
