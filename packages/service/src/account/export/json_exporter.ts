/**
 * JSON exporter — streams a group's messages to a single JSON array file, one
 * {@link ExportedMessage} per element. Thinnest possible format; exercises the
 * fetch + normalize pipeline. Media completion is not wired here yet (output
 * references media by token/path only).
 */

import type { MsgService } from '../msg';
import { runGroupExport } from './run_export';
import { exportJsonConversation } from './json_meta_exporter';
import type { SenderResolveDeps } from './sender_resolve';
import { bigintReplacer } from './serialize';
import type { ExportResult, GroupExportOptions } from './types';

/** @deprecated use {@link GroupExportOptions}. Kept for the existing barrel export. */
export type JsonExportOptions = GroupExportOptions;

/**
 * Export all messages of `groupCode` to `outputPath` as JSON.
 *
 * With sender-resolve deps (the app always supplies them) the output is the
 * enriched shape `{ meta, members, messages }` carrying member nicknames;
 * without deps it degrades to the legacy bare array of messages.
 */
export async function exportGroupToJson(
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
        format: 'json',
        range: opts.range,
        progressEvery: opts.progressEvery,
        onProgress: opts.onProgress,
        collectSenders: opts.collectSenders,
        withMediaPaths: opts.withMediaPaths,
      },
      deps,
    );
  }
  return runGroupExport(msgs, opts, 'json', { head: '[\n', between: ',\n', tail: '\n]\n' }, (m) =>
    JSON.stringify(m, bigintReplacer),
  );
}
