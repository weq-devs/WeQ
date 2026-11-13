import { statSync } from 'node:fs';
import type { MsgService } from '../msg';
import { messageToText, annotateExportPaths, collectFaceIds } from './element_text';
import { expandForwards } from './forward_expand';
import { MessageAudit } from './message_audit';
import { toExportedMessage } from './message_source';
import {
  iterateConv,
  resolveGroupSenders,
  resolveC2cSenders,
  type SenderResolveDeps,
} from './sender_resolve';
import { createExportWriter } from './stream_utils';
import type { ConvKind, ExportResult, GroupExportOptions } from './types';
import type { PlainSenderLookup } from '../../common/message_plain_text';

export interface TxtExportOptions extends Omit<GroupExportOptions, 'groupCode'> {
  kind: ConvKind;
  conv: string;
}

/** 群聊、私聊、服务号与官方号统一输出，可直接与多选复制文本对照。 */
export async function exportConversationToTxt(
  msgs: MsgService,
  opts: TxtExportOptions,
  deps: SenderResolveDeps = {},
): Promise<ExportResult> {
  const start = Date.now();
  const senders =
    opts.kind === 'group'
      ? await resolveGroupSenders(msgs, opts.conv, opts.range, deps, '', opts.roam)
      : (
          await resolveC2cSenders(opts.conv, deps, {
            msgs,
            kind: opts.kind,
            range: opts.range,
            roam: opts.roam,
          })
        ).senders;
  const byUin = new Map([...senders.values()].map((sender) => [sender.platformId, sender]));
  const resolveSender: PlainSenderLookup = (uid, uin) => {
    const sender = senders.get(uid) ?? byUin.get(uin);
    if (!sender) return undefined;
    return {
      name: sender.displayName || sender.groupNickname || sender.sourceName,
      uin: sender.uin,
    };
  };
  const writer = createExportWriter(opts.outputPath);
  const audit = new MessageAudit();
  let count = 0;
  try {
    for await (const message of iterateConv(msgs, opts.kind, opts.conv, opts.range, opts.roam)) {
      const exported = toExportedMessage(message);
      opts.collectSenders?.add(exported.senderUin);
      if (opts.collectFaces) collectFaceIds(exported.elements, opts.collectFaces);
      await expandForwards(msgs, opts.kind, exported);
      audit.observe(exported.elements);
      if (opts.withMediaPaths) annotateExportPaths(exported.elements);
      const body = messageToText(
        exported,
        resolveSender(exported.senderUid, exported.senderUin),
        resolveSender,
      );
      await writer.write(`${count ? '\n\n' : ''}${body}`);
      count++;
      if (count % (opts.progressEvery ?? 5000) === 0)
        opts.onProgress?.({ current: count, message: `已导出 ${count} 条` });
    }
  } finally {
    await writer.end();
  }
  return {
    coverage: audit.coverage,
    filePath: opts.outputPath,
    format: 'txt',
    messageCount: count,
    fileSize: statSync(opts.outputPath).size,
    durationMs: Date.now() - start,
  };
}

export function exportGroupToTxt(
  msgs: MsgService,
  opts: GroupExportOptions,
  deps?: SenderResolveDeps,
): Promise<ExportResult> {
  return exportConversationToTxt(msgs, { ...opts, kind: 'group', conv: opts.groupCode }, deps);
}
