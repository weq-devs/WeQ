/**
 * JSON exporter — streams a group's messages to a single JSON array file, one
 * {@link ExportedMessage} per element. Thinnest possible format; exercises the
 * fetch + normalize pipeline. Media completion is not wired here yet (output
 * references media by token/path only).
 */

import type { MsgService } from '../msg';
import { runGroupExport } from './run_export';
import { bigintReplacer } from './serialize';
import type { ExportResult, GroupExportOptions } from './types';

/** @deprecated use {@link GroupExportOptions}. Kept for the existing barrel export. */
export type JsonExportOptions = GroupExportOptions;

/** Export all messages of `groupCode` to `outputPath` as a JSON array. */
export async function exportGroupToJson(
  msgs: MsgService,
  opts: GroupExportOptions,
): Promise<ExportResult> {
  return runGroupExport(
    msgs,
    opts,
    'json',
    { head: '[\n', between: ',\n', tail: '\n]\n' },
    (m) => JSON.stringify(m, bigintReplacer),
  );
}
