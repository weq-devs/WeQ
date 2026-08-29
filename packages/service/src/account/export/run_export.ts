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

import { statSync } from 'node:fs';
import { createExportWriter } from './stream_utils';
import type { MsgService } from '../msg';
import { iterateGroupMessages, toExportedMessage } from './message_source';
import { annotateLocalPaths, collectFaceIds } from './element_text';
import { expandForwards } from './forward_expand';
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

  const writer = createExportWriter(opts.outputPath);

  let count = 0;
  try {
    if (framing.head) await writer.write(framing.head);
    for await (const m of iterateGroupMessages(msgs, opts.groupCode, {
      pageSize: opts.pageSize,
      range: opts.range,
      roam: opts.roam,
    })) {
      const exported = toExportedMessage(m);
      opts.collectSenders?.add(exported.senderUin);
      if (opts.collectFaces) collectFaceIds(exported.elements, opts.collectFaces);
      await expandForwards(msgs, 'group', exported);
      if (opts.withMediaPaths) annotateLocalPaths(exported.elements);
      const record = renderRecord(exported);
      await writer.write(count === 0 ? record : framing.between + record);
      count += 1;
      if (opts.onProgress && count % progressEvery === 0) {
        opts.onProgress({ current: count, message: `已导出 ${count} 条` });
      }
    }
    if (framing.tail) await writer.write(framing.tail);
  } finally {
    await writer.end();
  }

  return {
    filePath: opts.outputPath,
    format,
    messageCount: count,
    fileSize: statSync(opts.outputPath).size,
    durationMs: Date.now() - start,
  };
}
