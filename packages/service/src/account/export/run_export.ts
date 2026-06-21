/**
 * The shared streaming engine every group exporter runs on.
 *
 * It owns the parts that are identical across formats — paging the messages,
 * normalizing each, honouring write-backpressure, emitting progress, and the
 * timing/size bookkeeping — and leaves only the per-format bits to the caller:
 *   - `framing`: optional head / tail and the separator written between records
 *     (JSON array uses `[`, `,\n`, `]`; line formats use none).
 *   - `renderRecord`: an {@link ExportedMessage} → string for one record.
 */

import { createWriteStream, statSync } from 'node:fs';
import { once } from 'node:events';
import type { MsgService } from '../msg';
import { iterateGroupMessages, toExportedMessage } from './message_source';
import type { ExportedMessage, ExportFormat, ExportResult, GroupExportOptions } from './types';

export interface Framing {
  /** Written once before the first record. */
  head: string;
  /** Written between consecutive records (not before the first, not after last). */
  between: string;
  /** Written once after the last record. */
  tail: string;
}

export async function runGroupExport(
  msgs: MsgService,
  opts: GroupExportOptions,
  format: ExportFormat,
  framing: Framing,
  renderRecord: (m: ExportedMessage) => string,
): Promise<ExportResult> {
  const start = Date.now();
  const progressEvery = opts.progressEvery ?? 5000;

  const stream = createWriteStream(opts.outputPath, { encoding: 'utf-8' });
  // Backpressure: only queue more once the buffer drains, so a fast producer
  // can't balloon memory while the disk catches up.
  const write = async (chunk: string): Promise<void> => {
    if (!stream.write(chunk)) await once(stream, 'drain');
  };

  let count = 0;
  try {
    if (framing.head) await write(framing.head);
    for await (const m of iterateGroupMessages(msgs, opts.groupCode, { pageSize: opts.pageSize })) {
      const record = renderRecord(toExportedMessage(m));
      await write(count === 0 ? record : framing.between + record);
      count += 1;
      if (opts.onProgress && count % progressEvery === 0) {
        opts.onProgress({ current: count, message: `已导出 ${count} 条` });
      }
    }
    if (framing.tail) await write(framing.tail);
  } finally {
    stream.end();
    await once(stream, 'finish');
  }

  return {
    filePath: opts.outputPath,
    format,
    messageCount: count,
    fileSize: statSync(opts.outputPath).size,
    durationMs: Date.now() - start,
  };
}
