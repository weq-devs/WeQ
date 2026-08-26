/**
 * JSONL exporter — streams one {@link ExportedMessage} as compact JSON per line
 * (newline-delimited). Naturally streaming, low-memory, and trivially
 * line-by-line consumable by downstream tools; no array framing to track.
 */

import type { MsgService } from '../msg';
import { runGroupExport } from './run_export';
import { exportJsonConversation } from './json_meta_exporter';
import type { SenderResolveDeps } from './sender_resolve';
import { bigintReplacer } from './serialize';
import type { ExportResult, GroupExportOptions } from './types';

/**
 * Export all messages of `groupCode` to `outputPath` as JSONL (one per line).
 * With sender-resolve deps the file starts with a header + member lines and
 * each message line carries the sender name; without deps it stays the legacy
 * bare message-per-line format.
 */
export async function exportGroupToJsonl(
  msgs: MsgService,
  opts: GroupExportOptions,
  deps?: SenderResolveDeps,
): Promise<ExportResult> {
  if (deps) {
    return exportJsonConversation(
      msgs,
      {
        kind: 'group',
        conv: opts.groupCode,
        name: opts.name,
        outputPath: opts.outputPath,
        format: 'jsonl',
        range: opts.range,
        progressEvery: opts.progressEvery,
        onProgress: opts.onProgress,
        collectSenders: opts.collectSenders,
        withMediaPaths: opts.withMediaPaths,
        roam: opts.roam,
      },
      deps,
    );
  }
  return runGroupExport(
    msgs,
    opts,
    'jsonl',
    { head: '', between: '', tail: '' },
    (m) => `${JSON.stringify(m, bigintReplacer)}\n`,
  );
}
