/**
 * TXT exporter — streams a group's messages as a human-readable plain-text log,
 * one `[time] <uin>: <content>` line per message (media collapsed to bracket
 * labels via {@link messageToText}). Smallest, most portable output; no media,
 * no name resolution yet.
 */

import type { MsgService } from '../msg';
import { runGroupExport } from './run_export';
import { messageToText } from './element_text';
import type { ExportResult, GroupExportOptions } from './types';

/** Export all messages of `groupCode` to `outputPath` as a plain-text log. */
export async function exportGroupToTxt(
  msgs: MsgService,
  opts: GroupExportOptions,
): Promise<ExportResult> {
  return runGroupExport(
    msgs,
    opts,
    'txt',
    { head: '', between: '', tail: '' },
    (m) => `${messageToText(m)}\n`,
  );
}
