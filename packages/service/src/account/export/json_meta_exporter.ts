/**
 * Enriched JSON / JSONL exporter: resolves member nicknames (group card / QQ
 * nick / role / avatar) and writes them alongside the messages, so the plain
 * JSON formats carry the same identity info as ChatLab / HTML instead of bare
 * uin/uid.
 *
 * JSON output shape:
 *   { meta: {...}, members: [...], messages: [...] }
 * JSONL output shape (one JSON per line):
 *   {"_type":"header","meta":{...}}
 *   {"_type":"member", ...}            (one per member)
 *   { ...message, senderName, ... }    (one per message)
 */

import { statSync } from 'node:fs';
import { createExportWriter } from './stream_utils';
import type { MsgService } from '../msg';
import { toExportedMessage, type RoamMessageSource } from './message_source';
import { expandForwards } from './forward_expand';
import { annotateLocalPaths } from './element_text';
import { bigintReplacer } from './serialize';
import {
  avatarUrlForUin,
  fallbackSender,
  iterateConv,
  resolveC2cSenders,
  resolveGroupSenders,
  type ResolvedSender,
  type SenderResolveDeps,
} from './sender_resolve';
import type { MsgDecoration } from '@weq/codec';
import type {
  ConvKind,
  ExportedMessage,
  ExportResult,
  ExportTimeRange,
  ProgressCallback,
} from './types';

export interface JsonMetaExportOptions {
  kind: ConvKind;
  conv: string;
  /** Conversation display name (fallback for meta.name when unresolvable). */
  name?: string;
  outputPath: string;
  format: 'json' | 'jsonl';
  range?: ExportTimeRange;
  progressEvery?: number;
  onProgress?: ProgressCallback;
  collectSenders?: Set<string>;
  withMediaPaths?: boolean;
  /** 漫游补全消息（导出「消息补全」拉回缓存后，消息流按 sendTime 合并）。 */
  roam?: RoamMessageSource;
  /** 导出装扮时：按 msgId 查 decoration（dress 阶段预扫描结果）。 */
  dressLookup?: (msgId: string) => MsgDecoration | undefined;
}

/** One member row in the members block. */
export interface JsonExportedMember {
  uid: string;
  platformId: string;
  accountName: string;
  groupNickname?: string;
  role?: 'owner' | 'admin';
  avatar?: string;
}

/** A message record enriched with the sender's display name. */
export interface JsonExportedMessage extends ExportedMessage {
  senderName: string;
  groupNickname?: string;
  role?: 'owner' | 'admin';
}

function toMember(uid: string, s: ResolvedSender): JsonExportedMember {
  return {
    uid,
    platformId: s.platformId,
    accountName: s.accountName,
    ...(s.groupNickname ? { groupNickname: s.groupNickname } : {}),
    ...(s.role ? { role: s.role } : {}),
    // Only a real uin yields a usable public avatar url.
    ...(/^\d+$/.test(s.platformId) ? { avatar: avatarUrlForUin(s.platformId) } : {}),
  };
}

function toJsonMessage(m: ExportedMessage, sender: ResolvedSender): JsonExportedMessage {
  return {
    ...m,
    senderName: sender.accountName,
    ...(sender.groupNickname ? { groupNickname: sender.groupNickname } : {}),
    ...(sender.role ? { role: sender.role } : {}),
  };
}

/**
 * Stream a conversation to enriched JSON / JSONL. Resolves members first
 * (group: card/nick/role; c2c: self + peer), then writes meta + members,
 * then streams the messages with per-sender names.
 */
export async function exportJsonConversation(
  msgs: MsgService,
  opts: JsonMetaExportOptions,
  deps: SenderResolveDeps = {},
): Promise<ExportResult> {
  const start = Date.now();
  const progressEvery = opts.progressEvery ?? 5000;
  const isJsonl = opts.format === 'jsonl';

  // ---- resolve members (a pre-pass for groups) ----
  let senders: Map<string, ResolvedSender>;
  let ownerId: string | undefined;
  let groupName = opts.name ?? '';
  if (opts.kind === 'group') {
    const meta = deps.groupMeta ? await deps.groupMeta(opts.conv).catch(() => null) : null;
    if (meta?.name) groupName = opts.name || meta.name;
    const ownerUid = meta?.ownerUid ?? '';
    opts.onProgress?.({ current: 0, message: '解析成员…' });
    senders = await resolveGroupSenders(msgs, opts.conv, opts.range, deps, ownerUid, opts.roam);
    if (ownerUid) ownerId = senders.get(ownerUid)?.platformId;
  } else {
    const r = await resolveC2cSenders(opts.conv, deps);
    senders = r.senders;
    ownerId = r.ownerId;
  }
  const members = [...senders.entries()].map(([uid, s]) => toMember(uid, s));
  const meta = {
    name: groupName || opts.conv,
    platform: 'qq',
    type: opts.kind === 'group' ? 'group' : 'private',
    ...(opts.kind === 'group' ? { groupId: opts.conv } : {}),
    ...(ownerId ? { ownerId } : {}),
    exportedAt: Math.floor(Date.now() / 1000),
  };

  // ---- write ----
  const writer = createExportWriter(opts.outputPath);

  let count = 0;
  try {
    if (isJsonl) {
      await writer.write(`${JSON.stringify({ _type: 'header', meta }, bigintReplacer)}\n`);
      for (const member of members) {
        await writer.write(`${JSON.stringify({ _type: 'member', ...member }, bigintReplacer)}\n`);
      }
      for await (const raw of iterateConv(msgs, opts.kind, opts.conv, opts.range, opts.roam)) {
        const exported = toExportedMessage(raw);
        const dec = opts.dressLookup?.(exported.msgId);
        if (dec) exported.decoration = dec;
        opts.collectSenders?.add(exported.senderUin);
        await expandForwards(msgs, opts.kind, exported);
        if (opts.withMediaPaths) annotateLocalPaths(exported.elements);
        const sender = senders.get(exported.senderUid) ?? fallbackSender(exported);
        await writer.write(`${JSON.stringify(toJsonMessage(exported, sender), bigintReplacer)}\n`);
        count += 1;
        if (count % progressEvery === 0) {
          opts.onProgress?.({ current: count, message: `已导出 ${count} 条` });
        }
      }
    } else {
      const head =
        '{\n' +
        `"meta": ${JSON.stringify(meta)},\n` +
        `"members": ${JSON.stringify(members)},\n` +
        '"messages": [\n';
      await writer.write(head);
      for await (const raw of iterateConv(msgs, opts.kind, opts.conv, opts.range, opts.roam)) {
        const exported = toExportedMessage(raw);
        const dec = opts.dressLookup?.(exported.msgId);
        if (dec) exported.decoration = dec;
        opts.collectSenders?.add(exported.senderUin);
        await expandForwards(msgs, opts.kind, exported);
        if (opts.withMediaPaths) annotateLocalPaths(exported.elements);
        const sender = senders.get(exported.senderUid) ?? fallbackSender(exported);
        await writer.write(
          (count === 0 ? '' : ',\n') +
            JSON.stringify(toJsonMessage(exported, sender), bigintReplacer),
        );
        count += 1;
        if (count % progressEvery === 0) {
          opts.onProgress?.({ current: count, message: `已导出 ${count} 条` });
        }
      }
      await writer.write('\n]\n}\n');
    }
  } finally {
    await writer.end();
  }

  return {
    filePath: opts.outputPath,
    format: opts.format,
    messageCount: count,
    fileSize: statSync(opts.outputPath).size,
    durationMs: Date.now() - start,
  };
}
