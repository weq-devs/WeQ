/**
 * ChatLab exporter — emit a conversation in the ChatLab interchange format
 * (https://github.com/openchatlab/chatlab), spec v0.0.2.
 *
 * ChatLab normalizes every message to a single `{ type, content }` pair, so a
 * QQ message (a list of mixed elements) is collapsed here:
 *   - `type`     — the message's *dominant* element kind (voice > video > file >
 *                  forward > share > … > image > emoji > system > text).
 *   - `content`  — a plain-text rendering: text runs verbatim, media as bracket
 *                  labels (`[图片]`, `[视频]`, `[文件: name]`). Voice carries its
 *                  file name (`[语音: name]`) so an external transcripts.json
 *                  (the 语音转写 stage) stays join-able by file name.
 *
 * Members come *before* messages (the ChatLab JSON parser only scans the first
 * ~200 KB for the members block, and the JSONL parser wants them up front), so
 * we resolve display names / roles / avatars first:
 *   - group → every sender's group card / nick / admin flag (one batched member
 *     query), owner from the group detail; avatar by uin (network URL).
 *   - c2c   → the two participants (self + peer) via their profiles.
 *
 * Both JSON (single object, streamed) and JSONL (one record per line) are
 * produced from the same record stream; the only difference is framing.
 */

import { createWriteStream, statSync } from 'node:fs';
import { once } from 'node:events';
import type { MsgService, RenderGroupMsg, RenderC2cMsg } from '../msg';
import type { RenderElement } from '../msg_view';
import { iterateGroupMessages, iterateC2cMessages, toExportedMessage } from './message_source';
import { ChatlabMessageType, type ChatlabHeader, type ChatlabMember, type ChatlabMessage } from './chatlab_types';
import type { ConvKind, ExportedMessage, ExportResult, ExportTimeRange, ProgressCallback } from './types';

/** ChatLab spec version this exporter targets. */
const CHATLAB_VERSION = '0.0.2';
const GENERATOR = 'WeQ';
const PLATFORM = 'qq';

/** A resolved group member (the fields ChatLab needs), as the deps return them. */
export interface ChatlabGroupMember {
  uid: string;
  uin: string;
  /** Group card (群名片) — ChatLab `groupNickname`. */
  card: string;
  /** Global QQ nick — ChatLab `accountName`. */
  nick: string;
  /** 0 = member, 1 = admin (owner is identified separately by uid). */
  adminFlag: number;
}

/**
 * Account-side resolvers the ChatLab exporter needs (names / roles / profiles).
 * Injected by the app so the `@weq/service` export package stays decoupled from
 * the live account services. All optional — missing resolvers degrade to
 * uin-only member info rather than failing the export.
 */
export interface ChatlabDeps {
  /** Group: batch-resolve members by uid (one query). */
  resolveGroupMembers?: (groupCode: string, uids: string[]) => Promise<ChatlabGroupMember[]>;
  /** Group: name + owner uid for the meta block. */
  groupMeta?: (groupCode: string) => Promise<{ name: string; ownerUid: string } | null>;
  /** c2c: resolve one uid → its uin + nick. */
  resolveProfile?: (uid: string) => Promise<{ uin: string; nick: string } | null>;
  /** The exporting (self) account: uid + uin + nick. */
  self?: () => Promise<{ uid: string; uin: string; nick: string } | null>;
}

export interface ChatlabExportOptions {
  kind: ConvKind;
  /** Group code (群号) or peer uid. */
  conv: string;
  /** Display name for the meta block (the conversation name the user picked). */
  name: string;
  format: 'json' | 'jsonl';
  outputPath: string;
  range?: ExportTimeRange;
  onProgress?: ProgressCallback;
  progressEvery?: number;
  /** When provided, each message's sender uin is collected (for avatar export). */
  collectSenders?: Set<string>;
}

/** Public avatar CDN url for a uin (project convention — never a signed url). */
function avatarUrlForUin(uin: string): string {
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`;
}

/** A sender's resolved identity, cached per uid for the message pass. */
interface ResolvedSender {
  /** platformId — the value used for `sender` and `members[].platformId`. */
  platformId: string;
  /** accountName (global nick, or a best-effort fallback). */
  accountName: string;
  /** groupNickname (group card), when present. */
  groupNickname?: string;
  role?: 'owner' | 'admin';
}

/** Drop a trailing extension: `AB.MP4` → `AB` (kept for label readability). */
function fileNameOf(el: { data: { fileName?: string } }): string {
  return el.data.fileName ?? '';
}

/**
 * Render a message's elements to ChatLab `content` text. Text/at runs verbatim;
 * media collapse to bracket labels. Reply quotes contribute nothing (the link
 * lives in `replyToMessageId`). Returns '' for an empty render.
 */
function renderContent(elements: RenderElement[]): string {
  let out = '';
  for (const el of elements) {
    switch (el.type) {
      case 'text':
      case 'at':
        out += el.data.textContent ?? '';
        break;
      case 'face':
        out += el.data.faceText ? `[${el.data.faceText}]` : '[表情]';
        break;
      case 'pic':
        out += el.data.subType === 1 ? '[表情]' : '[图片]';
        break;
      case 'video':
        out += '[视频]';
        break;
      case 'ptt':
        // Carry the file name so an external transcripts.json stays join-able.
        out += el.data.fileName ? `[语音: ${el.data.fileName}]` : '[语音]';
        break;
      case 'file':
      case 'onlineFile':
        out += el.data.fileName ? `[文件: ${el.data.fileName}]` : '[文件]';
        break;
      case 'mface':
      case 'emojiBounce':
        out += '[表情]';
        break;
      case 'ark':
        out += '[卡片消息]';
        break;
      case 'qqDynamic':
        out += '[动态]';
        break;
      case 'multiMsg':
        out += '[合并转发]';
        break;
      case 'call':
        out += '[通话]';
        break;
      case 'wallet':
        out += '[红包/转账]';
        break;
      case 'markdown':
        out += el.data.markdownTextSummary || el.data.markdownContent || '[Markdown]';
        break;
      case 'grayTipRevoke':
        out += `[${el.data.recallDisplayText || '撤回了一条消息'}]`;
        break;
      case 'grayTipPoke':
        out += '[戳一戳]';
        break;
      case 'grayTipGroup':
      case 'grayTipInvite':
        out += '[群提示]';
        break;
      case 'onlineFolder':
        out += '[文件夹]';
        break;
      // reply / unknown contribute nothing to the text.
      default:
        break;
    }
  }
  return out;
}

/** Priority of a single element as a candidate for the message's dominant type. */
const TYPE_PRIORITY: Array<{ test: (el: RenderElement) => boolean; type: ChatlabMessageType }> = [
  { test: (el) => el.type === 'ptt', type: ChatlabMessageType.VOICE },
  { test: (el) => el.type === 'video', type: ChatlabMessageType.VIDEO },
  { test: (el) => el.type === 'file' || el.type === 'onlineFile', type: ChatlabMessageType.FILE },
  { test: (el) => el.type === 'multiMsg', type: ChatlabMessageType.FORWARD },
  { test: (el) => el.type === 'ark' || el.type === 'qqDynamic', type: ChatlabMessageType.SHARE },
  { test: (el) => el.type === 'call', type: ChatlabMessageType.CALL },
  { test: (el) => el.type === 'wallet', type: ChatlabMessageType.RED_PACKET },
  { test: (el) => el.type === 'pic' && el.data.subType !== 1, type: ChatlabMessageType.IMAGE },
  {
    test: (el) => (el.type === 'pic' && el.data.subType === 1) || el.type === 'mface' || el.type === 'emojiBounce',
    type: ChatlabMessageType.EMOJI,
  },
  { test: (el) => el.type === 'grayTipRevoke', type: ChatlabMessageType.RECALL },
  { test: (el) => el.type === 'grayTipPoke', type: ChatlabMessageType.POKE },
  { test: (el) => el.type === 'grayTipGroup' || el.type === 'grayTipInvite', type: ChatlabMessageType.SYSTEM },
  { test: (el) => el.type === 'markdown', type: ChatlabMessageType.OTHER },
];

/** Find the reply element's quoted-message id (for `replyToMessageId`), if any. */
function replyTargetId(elements: RenderElement[]): string | undefined {
  for (const el of elements) {
    if (el.type === 'reply' && el.data.origMsgId) return el.data.origMsgId.toString();
  }
  return undefined;
}

/**
 * Pick the dominant ChatLab message type. Media / system kinds win over text;
 * a pure reply (text + quote, no media) is REPLY; everything else is TEXT.
 */
function pickType(elements: RenderElement[], hasReply: boolean): ChatlabMessageType {
  for (const rule of TYPE_PRIORITY) {
    if (elements.some(rule.test)) return rule.type;
  }
  if (hasReply) return ChatlabMessageType.REPLY;
  return ChatlabMessageType.TEXT;
}

/** Build the per-message ChatLab record from a normalized export message. */
function toChatlabMessage(m: ExportedMessage, sender: ResolvedSender): ChatlabMessage {
  const replyTo = replyTargetId(m.elements);
  const type = pickType(m.elements, Boolean(replyTo));
  const content = renderContent(m.elements);
  const rec: ChatlabMessage = {
    _type: 'message',
    sender: sender.platformId,
    platformMessageId: m.msgId,
    accountName: sender.accountName,
    timestamp: m.sendTime,
    type,
    content: content || null,
  };
  if (sender.groupNickname) rec.groupNickname = sender.groupNickname;
  if (replyTo) rec.replyToMessageId = replyTo;
  return rec;
}

/** A member line, derived from a resolved sender. */
function toChatlabMember(s: ResolvedSender): ChatlabMember {
  const m: ChatlabMember = {
    _type: 'member',
    platformId: s.platformId,
    accountName: s.accountName,
  };
  if (s.groupNickname) m.groupNickname = s.groupNickname;
  // Only a real uin yields a usable public avatar url.
  if (/^\d+$/.test(s.platformId)) m.avatar = avatarUrlForUin(s.platformId);
  if (s.role) m.roles = [{ id: s.role }];
  return m;
}

/** The conversation's iterator for the current kind. */
function iterate(
  msgs: MsgService,
  kind: ConvKind,
  conv: string,
  range?: ExportTimeRange,
): AsyncGenerator<RenderGroupMsg | RenderC2cMsg> {
  return kind === 'group'
    ? iterateGroupMessages(msgs, conv, { pageSize: 2000, range })
    : iterateC2cMessages(msgs, conv, { pageSize: 2000, range });
}

/**
 * Resolve the members of a group export: one pass collects every sender's uid
 * (+ uin from the message), then a single batched member query enriches them
 * with card / nick / admin flag. Senders who have since left the group keep
 * their uin-only identity. Returns an insertion-ordered uid → sender map.
 */
async function resolveGroupSenders(
  msgs: MsgService,
  conv: string,
  range: ExportTimeRange | undefined,
  deps: ChatlabDeps,
  ownerUid: string,
): Promise<Map<string, ResolvedSender>> {
  // Pass 1: distinct sender uid → uin (from the message rows).
  const uinByUid = new Map<string, string>();
  for await (const m of iterate(msgs, 'group', conv, range)) {
    const uid = m.senderUid;
    if (!uid) continue;
    if (!uinByUid.has(uid)) uinByUid.set(uid, m.senderUin.toString());
  }
  const uids = [...uinByUid.keys()];
  // Always resolve the owner too, so meta.ownerId works even if they never spoke.
  if (ownerUid && !uinByUid.has(ownerUid)) uids.push(ownerUid);

  const table = new Map<string, ChatlabGroupMember>();
  if (deps.resolveGroupMembers && uids.length > 0) {
    try {
      for (const mem of await deps.resolveGroupMembers(conv, uids)) table.set(mem.uid, mem);
    } catch {
      /* degrade to uin-only names */
    }
  }

  const out = new Map<string, ResolvedSender>();
  for (const [uid, msgUin] of uinByUid) {
    const t = table.get(uid);
    const uin = t?.uin || msgUin;
    const platformId = uin && uin !== '0' ? uin : uid;
    const role: ResolvedSender['role'] = uid === ownerUid ? 'owner' : t?.adminFlag === 1 ? 'admin' : undefined;
    out.set(uid, {
      platformId,
      accountName: t?.nick || t?.card || (uin && uin !== '0' ? uin : uid),
      groupNickname: t?.card || undefined,
      role,
    });
  }
  return out;
}

/** Resolve the two participants of a c2c export (self + peer). */
async function resolveC2cSenders(
  conv: string,
  deps: ChatlabDeps,
): Promise<{ senders: Map<string, ResolvedSender>; ownerId?: string }> {
  const senders = new Map<string, ResolvedSender>();
  let ownerId: string | undefined;

  const self = deps.self ? await deps.self().catch(() => null) : null;
  if (self) {
    const platformId = self.uin && self.uin !== '0' ? self.uin : self.uid;
    senders.set(self.uid, { platformId, accountName: self.nick || platformId });
    ownerId = platformId;
  }
  // Peer uid is the conversation key itself.
  const peer = deps.resolveProfile ? await deps.resolveProfile(conv).catch(() => null) : null;
  const peerUin = peer?.uin && peer.uin !== '0' ? peer.uin : conv;
  if (!senders.has(conv)) {
    senders.set(conv, { platformId: peerUin, accountName: peer?.nick || peerUin });
  }
  return { senders, ownerId };
}

/**
 * Export a conversation to a ChatLab JSON or JSONL file. Members are resolved
 * and written first; messages stream afterwards (with write-backpressure).
 */
export async function exportToChatlab(
  msgs: MsgService,
  opts: ChatlabExportOptions,
  deps: ChatlabDeps = {},
): Promise<ExportResult> {
  const start = Date.now();
  const isJsonl = opts.format === 'jsonl';
  const progressEvery = opts.progressEvery ?? 1000;

  // ---- resolve meta + members (a pre-pass for groups) ----
  let metaOwnerId: string | undefined;
  let senders: Map<string, ResolvedSender>;
  let groupName = opts.name;

  if (opts.kind === 'group') {
    const meta = deps.groupMeta ? await deps.groupMeta(opts.conv).catch(() => null) : null;
    if (meta?.name) groupName = opts.name || meta.name;
    const ownerUid = meta?.ownerUid ?? '';
    opts.onProgress?.({ current: 0, message: '解析成员…' });
    senders = await resolveGroupSenders(msgs, opts.conv, opts.range, deps, ownerUid);
    if (ownerUid) metaOwnerId = senders.get(ownerUid)?.platformId;
  } else {
    const r = await resolveC2cSenders(opts.conv, deps);
    senders = r.senders;
    metaOwnerId = r.ownerId;
  }

  const header: ChatlabHeader = {
    _type: 'header',
    chatlab: { version: CHATLAB_VERSION, exportedAt: Math.floor(Date.now() / 1000), generator: GENERATOR },
    meta: {
      name: groupName,
      platform: PLATFORM,
      type: opts.kind === 'group' ? 'group' : 'private',
      ...(opts.kind === 'group' ? { groupId: opts.conv } : {}),
      ...(metaOwnerId ? { ownerId: metaOwnerId } : {}),
    },
  };

  // ---- write ----
  const stream = createWriteStream(opts.outputPath, { encoding: 'utf-8' });
  const write = async (chunk: string): Promise<void> => {
    if (!stream.write(chunk)) await once(stream, 'drain');
  };

  let count = 0;
  try {
    if (isJsonl) {
      // JSONL: header line, member lines, then one message per line.
      await write(`${JSON.stringify(header)}\n`);
      for (const s of senders.values()) {
        await write(`${JSON.stringify(toChatlabMember(s))}\n`);
      }
      for await (const raw of iterate(msgs, opts.kind, opts.conv, opts.range)) {
        const exported = toExportedMessage(raw);
        opts.collectSenders?.add(exported.senderUin);
        const sender = senders.get(exported.senderUid) ?? fallbackSender(exported);
        await write(`${JSON.stringify(toChatlabMessage(exported, sender))}\n`);
        count += 1;
        if (count % progressEvery === 0) opts.onProgress?.({ current: count, message: `已导出 ${count} 条` });
      }
    } else {
      // JSON: a single object — chatlab + meta + members[] + messages[].
      const memberObjs = [...senders.values()].map((s) => {
        const { _type, ...rest } = toChatlabMember(s);
        void _type;
        return rest;
      });
      const head =
        '{\n' +
        `"chatlab": ${JSON.stringify(header.chatlab)},\n` +
        `"meta": ${JSON.stringify(header.meta)},\n` +
        `"members": ${JSON.stringify(memberObjs)},\n` +
        '"messages": [\n';
      await write(head);
      for await (const raw of iterate(msgs, opts.kind, opts.conv, opts.range)) {
        const exported = toExportedMessage(raw);
        opts.collectSenders?.add(exported.senderUin);
        const sender = senders.get(exported.senderUid) ?? fallbackSender(exported);
        const { _type, ...rest } = toChatlabMessage(exported, sender);
        void _type;
        await write((count === 0 ? '' : ',\n') + JSON.stringify(rest));
        count += 1;
        if (count % progressEvery === 0) opts.onProgress?.({ current: count, message: `已导出 ${count} 条` });
      }
      await write('\n]\n}\n');
    }
  } finally {
    stream.end();
    await once(stream, 'finish');
  }

  return {
    filePath: opts.outputPath,
    format: opts.format,
    messageCount: count,
    fileSize: statSync(opts.outputPath).size,
    durationMs: Date.now() - start,
  };
}

/** Best-effort sender for a uid not in the resolved member set (rare). */
function fallbackSender(m: ExportedMessage): ResolvedSender {
  const uin = m.senderUin;
  const platformId = uin && uin !== '0' ? uin : m.senderUid;
  return { platformId, accountName: platformId };
}
