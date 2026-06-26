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
import { iterateGroupMessages, iterateC2cMessages } from './message_source';
import type { ConvKind, ExportedMessage, ExportTimeRange } from './types';

/** A resolved group member (the fields the structured exporters need). */
export interface ResolvedGroupMember {
  uid: string;
  uin: string;
  /** Group card (群名片). */
  card: string;
  /** Global QQ nick. */
  nick: string;
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
  /** c2c: resolve one uid → its uin + nick. */
  resolveProfile?: (uid: string) => Promise<{ uin: string; nick: string } | null>;
  /** The exporting (self) account: uid + uin + nick. */
  self?: () => Promise<{ uid: string; uin: string; nick: string } | null>;
}

/** A sender's resolved identity, cached per uid for the message pass. */
export interface ResolvedSender {
  /** platformId — the value used for `sender` / `members[].platformId` (uin, or uid fallback). */
  platformId: string;
  /** accountName (global nick, or a best-effort fallback). */
  accountName: string;
  /** groupNickname (group card), when present. */
  groupNickname?: string;
  role?: 'owner' | 'admin';
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
export async function resolveGroupSenders(
  msgs: MsgService,
  conv: string,
  range: ExportTimeRange | undefined,
  deps: SenderResolveDeps,
  ownerUid: string,
): Promise<Map<string, ResolvedSender>> {
  // Pass 1: distinct sender uid → uin (from the message rows).
  const uinByUid = new Map<string, string>();
  for await (const m of iterateConv(msgs, 'group', conv, range)) {
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
export async function resolveC2cSenders(
  conv: string,
  deps: SenderResolveDeps,
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

/** Best-effort sender for a uid not in the resolved member set (rare). */
export function fallbackSender(m: ExportedMessage): ResolvedSender {
  const uin = m.senderUin;
  const platformId = uin && uin !== '0' ? uin : m.senderUid;
  return { platformId, accountName: platformId };
}
