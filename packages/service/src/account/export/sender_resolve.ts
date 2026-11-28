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

function projectGroupSenderIdentity(
  uid: string,
  msgUin: string,
  t: ResolvedGroupMember | undefined,
  ownerUid: string,
): ResolvedSender {
  const uin = t?.uin || msgUin;
  const platformId = uin && uin !== '0' ? uin : uid;
  const role: ResolvedSender['role'] =
    uid && uid === ownerUid ? 'owner' : t?.adminFlag === 1 ? 'admin' : undefined;
  return {
    uin: uin && uin !== '0' ? uin : undefined,
    ...(t ? { sourceName: t.nick || t.card } : {}),
    displayName: t?.card?.trim() || t?.remark?.trim() || t?.nick?.trim() || undefined,
    platformId,
    accountName: t?.nick || t?.card || (uin && uin !== '0' ? uin : uid),
    groupNickname: t?.card || undefined,
    role,
  };
}

export interface GroupPageSenderMessage {
  targetGroupCode: string | bigint;
  senderUid: string;
  senderUin: string | bigint | number;
}

export interface GroupPageSenderMember extends Omit<ResolvedGroupMember, 'uin'> {
  groupCode: string | bigint;
  uin: string | bigint;
  memberFlag?: number;
}

export interface GroupPageSenderDeps {
  getMembersByUids: (
    groupCode: bigint,
    uids: string[],
  ) => Promise<ReadonlyArray<GroupPageSenderMember>>;
  getMembersByUins?: (
    groupCode: bigint,
    uins: bigint[],
  ) => Promise<ReadonlyArray<GroupPageSenderMember>>;
  profilesByUids?: (
    uids: string[],
  ) => Promise<
    ReadonlyArray<{ uid: string; uin?: bigint | string; nick: string; remark?: string }>
  >;
  nicksByUids?: (uids: string[]) => Promise<Record<string, string>>;
  /** Optional account-scope check for external hosts. */
  authorize?: () => boolean | Promise<boolean>;
}

export interface ProjectedGroupPageSender extends ResolvedSender {
  senderUid: string;
  displayName: string;
  /** groupNickname can be historical when the member has left. */
  memberFlag?: number;
}

export interface GroupPageSenderDiagnostic {
  stage: 'group_members' | 'group_members_by_uin' | 'profiles' | 'profile_nicks' | 'authorization';
  /** Original error for local diagnostic handling. */
  cause: unknown;
}

export interface GroupPageSenderResult {
  status: 'ok' | 'partial' | 'unauthorized';
  senders: ProjectedGroupPageSender[];
  diagnostics?: GroupPageSenderDiagnostic[];
}

function positiveUin(value: string | bigint | number): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const text = String(value);
  return /^[0-9]+$/.test(text) && BigInt(text) > 0n ? text : '';
}

function groupCodeOf(value: string | bigint): bigint {
  const code = positiveUin(value);
  if (!code) throw new RangeError('invalid_group_code');
  return BigInt(code);
}

function checkGroup(value: string | bigint, group: bigint): void {
  if (positiveUin(value) && BigInt(value) === group) return;
  throw new RangeError(`group_scope_mismatch: expected ${group}, got ${value}`);
}

/**
 * Resolve an already selected group message batch, in input order.
 * Query distinct UIDs only, without scanning message history.
 * The caller controls the batch size and selects the account and group.
 */
export async function resolveGroupSenderPage(
  groupCode: string | bigint,
  messages: ReadonlyArray<GroupPageSenderMessage>,
  deps: GroupPageSenderDeps,
  ownerUid = '',
): Promise<GroupPageSenderResult> {
  const group = groupCodeOf(groupCode);
  for (const message of messages) checkGroup(message.targetGroupCode, group);

  const diagnostics: GroupPageSenderDiagnostic[] = [];
  let revoked = false;
  const authorized = async (): Promise<boolean> => {
    if (revoked) return false;
    if (!deps.authorize) return true;
    try {
      revoked = (await deps.authorize()) !== true;
    } catch (cause) {
      diagnostics.push({ stage: 'authorization', cause });
      revoked = true;
    }
    return !revoked;
  };
  const denied = (): GroupPageSenderResult => ({
    status: 'unauthorized',
    senders: [],
    ...(diagnostics.length ? { diagnostics } : {}),
  });
  if (!(await authorized())) return denied();

  // 按既有归档查询的 500 个绑定参数分批，处理全部输入，不限制页长。
  async function readBatches<K, V>(
    keys: K[],
    stage: GroupPageSenderDiagnostic['stage'],
    read: (keys: K[]) => Promise<ReadonlyArray<V>>,
  ): Promise<V[]> {
    const rows: V[] = [];
    for (let offset = 0; offset < keys.length; offset += 500) {
      if (!(await authorized())) break;
      try {
        rows.push(...(await read(keys.slice(offset, offset + 500))));
      } catch (cause) {
        // Preserve the database scheduler's explicit cancellation contract.
        if (cause instanceof Error && cause.name === 'AbortError') throw cause;
        diagnostics.push({ stage, cause });
      }
    }
    return rows;
  }

  const uinByUid = new Map<string, string>();
  for (const { senderUid, senderUin } of messages) {
    if (senderUid && !uinByUid.get(senderUid)) uinByUid.set(senderUid, positiveUin(senderUin));
  }
  const uids = [...uinByUid.keys()];
  const members = new Map<string, GroupPageSenderMember>();
  const membersByUin = new Map<bigint, GroupPageSenderMember>();
  const addMember = (member: GroupPageSenderMember) => {
    const previous = members.get(member.uid);
    // 同一身份存在多条本地记录时，当前在群记录优先。
    if (previous && previous.memberFlag !== 1 && member.memberFlag === 1) return;
    members.set(member.uid, member);
    const uin = positiveUin(member.uin);
    if (uin) membersByUin.set(BigInt(uin), member);
  };
  for (const member of await readBatches(uids, 'group_members', (batch) =>
    deps.getMembersByUids(group, batch),
  )) {
    checkGroup(member.groupCode, group);
    if (!uinByUid.has(member.uid))
      throw new TypeError(`invalid_member_batch: unexpected UID ${member.uid}`);
    addMember(member);
  }
  if (!(await authorized())) return denied();

  const getMembersByUins = deps.getMembersByUins;
  if (getMembersByUins) {
    const missingUins = [
      ...new Set(
        messages
          .filter((row) => !row.senderUid)
          .map((row) => positiveUin(row.senderUin))
          .filter((uin) => uin && !membersByUin.has(BigInt(uin))),
      ),
    ];
    const requested = new Set(missingUins.map(BigInt));
    for (const member of await readBatches([...requested], 'group_members_by_uin', (batch) =>
      getMembersByUins(group, batch),
    )) {
      checkGroup(member.groupCode, group);
      const uin = positiveUin(member.uin);
      if (!uin || !requested.has(BigInt(uin)))
        throw new TypeError(`invalid_member_batch: unexpected UIN ${member.uin}`);
      addMember(member);
    }
  }
  if (!(await authorized())) return denied();

  const allUids = [...new Set([...uids, ...members.keys()])].filter(Boolean);
  const needProfile = allUids.filter((uid) => {
    const member = members.get(uid);
    return (
      !member ||
      member.memberFlag === 1 ||
      !(member.card.trim() || member.remark?.trim()) ||
      !member.nick.trim() ||
      !(uinByUid.get(uid) || positiveUin(member.uin))
    );
  });
  type PageProfile = { uid: string; uin?: string | bigint; nick: string; remark?: string };
  const profiles = new Map<string, PageProfile>();
  if (deps.profilesByUids) {
    const lookup = deps.profilesByUids;
    const requested = new Set(needProfile);
    for (const profile of await readBatches(needProfile, 'profiles', lookup)) {
      if (requested.has(profile.uid)) profiles.set(profile.uid, profile);
    }
  }
  if (!(await authorized())) return denied();
  if (deps.nicksByUids) {
    const lookup = deps.nicksByUids;
    const missing = needProfile.filter((uid) => !profiles.has(uid));
    const requested = new Set(missing);
    for (const profile of await readBatches(missing, 'profile_nicks', async (batch) =>
      Object.entries(await lookup(batch)).map(([uid, nick]) => ({ uid, nick })),
    )) {
      if (requested.has(profile.uid)) profiles.set(profile.uid, profile);
    }
  }
  if (!(await authorized())) return denied();

  let unresolved = false;
  const senders = messages.map((message): ProjectedGroupPageSender => {
    const messageUin = positiveUin(message.senderUin);
    const member = message.senderUid
      ? members.get(message.senderUid)
      : messageUin
        ? membersByUin.get(BigInt(messageUin))
        : undefined;
    const uid = message.senderUid || member?.uid || '';
    const profile = profiles.get(uid);
    const active = member && member.memberFlag !== 1;
    // 消息原始 UIN 优先；资料库用于补全缺失字段。
    const uin =
      messageUin ||
      uinByUid.get(uid) ||
      (member ? positiveUin(member.uin) : '') ||
      positiveUin(profile?.uin ?? '');
    const current: ResolvedGroupMember | undefined =
      member || profile
        ? {
            uid,
            uin,
            card: active ? member.card : '',
            nick: profile?.nick || member?.nick || '',
            remark: profile?.remark || (active ? member.remark : undefined),
            adminFlag: active ? member.adminFlag : 0,
          }
        : undefined;
    const resolved = projectGroupSenderIdentity(uid, uin, current, ownerUid);
    if (!resolved.displayName) unresolved = true;
    return {
      ...resolved,
      ...(member?.memberFlag !== undefined ? { memberFlag: member.memberFlag } : {}),
      ...(member?.memberFlag === 1 && member.card ? { groupNickname: member.card } : {}),
      senderUid: message.senderUid,
      displayName: resolved.displayName || resolved.platformId || '未知成员',
    };
  });
  return {
    status: diagnostics.length || unresolved ? 'partial' : 'ok',
    senders,
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}

/** The conversation's message iterator for the current kind (pageSize 2000). */
export function iterateConv(
  msgs: MsgService,
  kind: ConvKind,
  conv: string,
  range?: ExportTimeRange,
  roam?: RoamMessageSource,
  pageSize = 2000,
): AsyncGenerator<RenderGroupMsg | RenderC2cMsg> {
  if (kind === 'group') {
    return exportForwardContents(
      iterateGroupMessages(msgs, conv, { pageSize, range, roam }),
      msgs,
      kind,
    );
  }
  if (kind === 'official') {
    return exportForwardContents(
      iterateOfficialMessages(msgs, conv, { pageSize, range, roam }),
      msgs,
      kind,
    );
  }
  if (kind === 'service') {
    return exportForwardContents(
      iterateServiceMessages(msgs, conv, { pageSize, range, roam }),
      msgs,
      kind,
    );
  }
  return exportForwardContents(
    iterateC2cMessages(msgs, conv, { pageSize, range, roam }),
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
    out.set(uid, projectGroupSenderIdentity(uid, msgUin, table.get(uid), ownerUid));
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
  if (selection && (selection.kind === 'official' || selection.kind === 'service')) {
    const actual = await resolveForwardSenders(
      selection.msgs,
      selection.kind,
      conv,
      selection.range,
      selection.roam,
    );
    for (const [uid, sender] of actual) {
      const profile =
        deps.resolveProfile && uid ? await deps.resolveProfile(uid).catch(() => null) : null;
      const previous = senders.get(uid);
      const uin = sender.uin || profile?.uin || previous?.uin;
      const sourceName = profile?.nick || previous?.sourceName || sender.sourceName;
      senders.set(uid, {
        ...sender,
        uin,
        platformId: uin && uin !== '0' ? uin : sender.platformId,
        sourceName,
        displayName:
          profile?.remark?.trim() ||
          profile?.nick?.trim() ||
          previous?.displayName ||
          sender.displayName,
        accountName: sourceName || sender.accountName,
        ...(profile?.avatar ? { avatar: profile.avatar } : {}),
      });
    }
    return { senders, ownerId };
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
