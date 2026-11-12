/**
 * Shared sender-identity resolution for the structured exporters (ChatLab, HTML).
 *
 * Both formats want more than a bare uin per message — a display name (group
 * card → nick → uin fallback), a role (owner / admin), and a public avatar url.
 * Resolving that needs a pre-pass over the conversation plus account-side
 * lookups (member list, profiles), which the `@weq/service` export package
 * can't do itself, so the resolvers are injected by the app via
 * {@link SenderResolveDeps}.
 *
 * The result is an insertion-ordered `uid → ResolvedSender` map the exporter
 * writes as its members block and then reads per message.
 */

import type { MsgService, RenderGroupMsg, RenderC2cMsg } from '../msg';
import {
  iterateGroupMessages,
  iterateC2cMessages,
  iterateOfficialMessages,
  iterateServiceMessages,
  type RoamMessageSource,
} from './message_source';
import type { ConvKind, ExportedMessage, ExportTimeRange } from './types';
import { exportForwardContents } from './forward_expand';

/** A resolved group member (the fields the structured exporters need). */
export interface ResolvedGroupMember {
  uid: string;
  uin: string;
  /** Group card (群名片). */
  card: string;
  /** Global QQ nick. */
  nick: string;
  remark?: string;
  /** 0 = member, 1 = admin (owner is identified separately by uid). */
  adminFlag: number;
}

/**
 * Account-side resolvers the structured exporters need (names / roles /
 * profiles). Injected by the app so the export package stays decoupled from the
 * live account services. All optional — missing resolvers degrade to uin-only
 * member info rather than failing the export.
 */
export interface SenderResolveDeps {
  /** Group: batch-resolve members by uid (one query). */
  resolveGroupMembers?: (groupCode: string, uids: string[]) => Promise<ResolvedGroupMember[]>;
  /** Group: name + owner uid for the meta block. */
  groupMeta?: (groupCode: string) => Promise<{ name: string; ownerUid: string } | null>;
  /** c2c: resolve one uid → its uin + nick (+ 可选公开头像覆盖，频道私聊用)。 */
  resolveProfile?: (
    uid: string,
  ) => Promise<{ uin: string; nick: string; remark?: string; avatar?: string } | null>;
  /** The exporting (self) account: uid + uin + nick (+ 可选公开头像覆盖，频道私聊用)。 */
  self?: () => Promise<{ uid: string; uin: string; nick: string; avatar?: string } | null>;
}

/** A sender's resolved identity, cached per uid for the message pass. */
export interface ResolvedSender {
  /** 真实 QQ 号；与可能回退到频道身份的 platformId 区分。 */
  uin?: string;
  /** 实际读到的名称；与仅用于显示的账号 ID 回退分开。 */
  sourceName?: string;
  displayName?: string;
  /** platformId — the value used for `sender` / `members[].platformId` (uin, or uid fallback). */
  platformId: string;
  /** accountName (global nick, or a best-effort fallback). */
  accountName: string;
  /** groupNickname (group card), when present. */
  groupNickname?: string;
  role?: 'owner' | 'admin';
  /** 公开头像 URL 覆盖（默认按 platformId 拼 uin CDN；频道私聊无 uin 时用 avatar_meta）。 */
  avatar?: string;
}

/** Public avatar CDN url for a uin (project convention — never a signed url). */
export function avatarUrlForUin(uin: string): string {
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`;
}

/** The conversation's message iterator for the current kind (pageSize 2000). */
export function iterateConv(
  msgs: MsgService,
  kind: ConvKind,
  conv: string,
  range?: ExportTimeRange,
  roam?: RoamMessageSource,
): AsyncGenerator<RenderGroupMsg | RenderC2cMsg> {
  if (kind === 'group') {
    return exportForwardContents(
      iterateGroupMessages(msgs, conv, { pageSize: 2000, range, roam }),
      msgs,
      kind,
    );
  }
  if (kind === 'official') {
    return exportForwardContents(
      iterateOfficialMessages(msgs, conv, { pageSize: 2000, range, roam }),
      msgs,
      kind,
    );
  }
  if (kind === 'service') {
    return exportForwardContents(
      iterateServiceMessages(msgs, conv, { pageSize: 2000, range, roam }),
      msgs,
      kind,
    );
  }
  return exportForwardContents(
    iterateC2cMessages(msgs, conv, { pageSize: 2000, range, roam }),
    msgs,
    kind,
  );
}

/**
 * Resolve the members of a group export: one pass collects every sender's uid
 * (+ uin from the message), then a single batched member query enriches them
 * with card / nick / admin flag. Senders who have since left the group keep
 * their uin-only identity. Returns an insertion-ordered uid → sender map.
 */
export async function resolveGroupSenders(
  msgs: MsgService,
  conv: string,
  range: ExportTimeRange | undefined,
  deps: SenderResolveDeps,
  ownerUid: string,
  roam?: RoamMessageSource,
): Promise<Map<string, ResolvedSender>> {
  if (msgs.exportFilter?.forwardTarget)
    return resolveForwardSenders(msgs, 'group', conv, range, roam);
  // Pass 1: distinct sender uid → uin (from the message rows).
  const uinByUid = new Map<string, string>();
  for await (const m of iterateConv(msgs, 'group', conv, range, roam)) {
    const uid = m.senderUid;
    if (!uid) continue;
    if (!uinByUid.has(uid)) uinByUid.set(uid, m.senderUin.toString());
  }
  const uids = [...uinByUid.keys()];
  // Always resolve the owner too, so meta.ownerId works even if they never spoke.
  if (ownerUid && !uinByUid.has(ownerUid)) uids.push(ownerUid);

  const table = new Map<string, ResolvedGroupMember>();
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
    const role: ResolvedSender['role'] =
      uid === ownerUid ? 'owner' : t?.adminFlag === 1 ? 'admin' : undefined;
    out.set(uid, {
      uin: uin && uin !== '0' ? uin : undefined,
      ...(t ? { sourceName: t.nick || t.card } : {}),
      displayName: t?.card?.trim() || t?.remark?.trim() || t?.nick?.trim() || undefined,
      platformId,
      accountName: t?.nick || t?.card || (uin && uin !== '0' ? uin : uid),
      groupNickname: t?.card || undefined,
      role,
    });
  }
  return out;
}

/** Resolve the two participants of a c2c export (self + peer). */
export async function resolveC2cSenders(
  conv: string,
  deps: SenderResolveDeps,
  selection?: {
    msgs: MsgService;
    kind: ConvKind;
    range?: ExportTimeRange;
    roam?: RoamMessageSource;
  },
): Promise<{ senders: Map<string, ResolvedSender>; ownerId?: string }> {
  if (selection?.msgs.exportFilter?.forwardTarget)
    return {
      senders: await resolveForwardSenders(
        selection.msgs,
        selection.kind,
        conv,
        selection.range,
        selection.roam,
      ),
    };
  const senders = new Map<string, ResolvedSender>();
  let ownerId: string | undefined;

  const self = deps.self ? await deps.self().catch(() => null) : null;
  if (self) {
    const platformId = self.uin && self.uin !== '0' ? self.uin : self.uid;
    senders.set(self.uid, {
      uin: self.uin && self.uin !== '0' ? self.uin : undefined,
      sourceName: self.nick,
      platformId,
      accountName: self.nick || platformId,
      ...(self.avatar ? { avatar: self.avatar } : {}),
    });
    ownerId = platformId;
  }
  // Peer uid is the conversation key itself.
  const peer = deps.resolveProfile ? await deps.resolveProfile(conv).catch(() => null) : null;
  const peerUin = peer?.uin && peer.uin !== '0' ? peer.uin : conv;
  if (!senders.has(conv)) {
    senders.set(conv, {
      uin: peer?.uin && peer.uin !== '0' ? peer.uin : undefined,
      ...(peer ? { sourceName: peer.nick } : {}),
      displayName: peer?.remark?.trim() || peer?.nick?.trim() || undefined,
      platformId: peerUin,
      accountName: peer?.nick || peerUin,
      ...(peer?.avatar ? { avatar: peer.avatar } : {}),
    });
  }
  return { senders, ownerId };
}

/** Best-effort sender for a uid not in the resolved member set (rare). */
export function fallbackSender(m: ExportedMessage): ResolvedSender {
  const uin = m.senderUin;
  const platformId = uin && uin !== '0' ? uin : m.senderUid;
  return {
    platformId,
    accountName: m.senderName || platformId,
    ...(m.senderName ? { sourceName: m.senderName } : {}),
  };
}

async function resolveForwardSenders(
  msgs: MsgService,
  kind: ConvKind,
  conv: string,
  range?: ExportTimeRange,
  roam?: RoamMessageSource,
): Promise<Map<string, ResolvedSender>> {
  const senders = new Map<string, ResolvedSender>();
  for await (const row of iterateConv(msgs, kind, conv, range, roam)) {
    if (senders.has(row.senderUid)) continue;
    const uin = String(row.senderUin);
    senders.set(row.senderUid, {
      platformId: uin !== '0' ? uin : row.senderUid,
      uin: uin !== '0' ? uin : undefined,
      sourceName: row.senderName,
      displayName: row.senderName,
      accountName: row.senderName || uin,
    });
  }
  return senders;
}
