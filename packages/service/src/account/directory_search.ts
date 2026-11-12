import type { AccountSession } from '@weq/account';
import { classifyChatType, toChatTypeNumber, ChatType } from '@weq/codec';
import { searchNameRank } from './search_policy';

export type SearchConversationView = 'regular' | 'hidden' | 'deleted' | 'groupAssistant';

export interface ContactSearchHit {
  category: 'contact';
  target?: { kind: 'guild'; nodeId: string } | { kind: 'persona'; ownerId: string };
  uid: string;
  uin: string;
  nick: string;
  remark: string;
  avatarUrl: string | null;
  isFriend: boolean;
  hasConversation: boolean;
  temporary: boolean;
  /** 非普通私聊使用原会话类型定位公众号、服务号或数据线。 */
  chatType?: number;
  conversationView?: SearchConversationView;
  aliases: string[];
  groups: Array<{ groupCode: string; groupName: string; display: string }>;
}

export interface GroupSearchHit {
  category: 'group';
  target?: { kind: 'group'; ownerId: string };
  groupCode: string;
  name: string;
  remark: string;
  inDirectory: boolean;
  hasConversation: boolean;
  conversationView?: SearchConversationView;
  aliases: string[];
}

function validUin(value: string): string {
  return /^\d+$/.test(value) && BigInt(value) > 0n ? BigInt(value).toString() : '';
}

async function profiles(session: AccountSession, uids: string[]) {
  const out = [];
  const unique = [...new Set(uids.filter(Boolean))];
  for (let offset = 0; offset < unique.length; offset += 300)
    out.push(...(await session.profileInfo.profilesByUids(unique.slice(offset, offset + 300))));
  return out;
}

async function groupDetails(session: AccountSession, codes: string[]) {
  const out = [];
  const unique = [...new Set(codes.filter((code) => validUin(code)))];
  for (let offset = 0; offset < unique.length; offset += 300)
    out.push(
      ...(await session.groupDetail.detailsByGroupCodes(
        unique.slice(offset, offset + 300).map(BigInt),
      )),
    );
  return out;
}

async function recentConversationEvidence(session: AccountSession, uids: string[]) {
  if (!session.recentContacts.getByTargetUids) return null;
  const rows = new Map<string, { notifyLevel: number; chatType?: string | number }>();
  const unique = [...new Set(uids.filter(Boolean))];
  for (let offset = 0; offset < unique.length; offset += 300)
    for (const row of await session.recentContacts.getByTargetUids(
      unique.slice(offset, offset + 300),
    ))
      rows.set(row.targetUid, row);
  return rows;
}

/** 删除记录可能在重开会话后保留；隐藏需与当前会话存在性相互印证。 */
function conversationViewForIdentity(
  id: string,
  current: ReadonlySet<string>,
  recent: ReadonlyMap<string, { notifyLevel: number; chatType?: string | number }> | null,
  hidden: ReadonlySet<string>,
  deleted: ReadonlySet<string>,
  groups?: ReadonlyMap<string, { notifyLevel: number }>,
): SearchConversationView | undefined {
  const record = recent?.get(id);
  const inRecent = current.has(id) || Boolean(recent?.has(id));
  if (inRecent && hidden.has(id)) return 'hidden';
  if (!inRecent && deleted.has(id)) return recent ? 'deleted' : undefined;
  if (!inRecent && hidden.has(id) && recent === null) return undefined;
  if (
    groups &&
    (groups.get(id)?.notifyLevel === 2 ||
      (record?.notifyLevel === 2 && classifyChatType(record.chatType ?? '') === 'group'))
  )
    return 'groupAssistant';
  if (inRecent || groups?.has(id)) return 'regular';
  return undefined;
}

/** 合并的是本地身份，不把资料缓存或删除会话当作好友关系证明。 */
export async function searchContacts(
  session: AccountSession,
  keyword: string,
): Promise<ContactSearchHit[]> {
  const [cached, conversations, members, deleted, buddies, hidden, services] = await Promise.all([
    session.profileInfo.searchContacts(keyword),
    session.recentContacts.searchIdentities(keyword),
    session.groupMembers.searchMembers(keyword, -1, 0, {
      includeHistorical: true,
      includeCards: true,
    }),
    session.deletedSessions.listDeletedSessions(),
    session.buddies.listBuddies(),
    session.hiddenSessions?.listHiddenSessions() ?? [],
    session.serviceAssistantContacts?.listContacts() ?? [],
  ]);
  const isContactConversation = (chatType: number) =>
    ['direct', 'dataline', 'official', 'service'].includes(classifyChatType(chatType) ?? '');
  const direct = conversations.filter((row) => isContactConversation(row.chatType));
  const historical = deleted.filter(
    (row) => isContactConversation(row.chatType) || row.chatType === 10,
  );
  const hiddenContacts = hidden.filter((row) =>
    isContactConversation(toChatTypeNumber(row.chatType) ?? 0),
  );
  const [details, people, recent] = await Promise.all([
    groupDetails(
      session,
      members.items.map((row) => row.groupCode),
    ),
    profiles(session, [
      ...direct.map((row) => row.targetUid),
      ...historical.map((row) => row.targetUid),
      ...hiddenContacts.map((row) => row.targetUid),
      ...members.items.map((row) => row.uid),
    ]),
    recentConversationEvidence(
      session,
      [...historical, ...hiddenContacts].map((row) => row.targetUid),
    ),
  ]);
  const currentIds = new Set(direct.map((row) => row.targetUid));
  const hiddenIds = new Set(
    hiddenContacts
      .filter((row) => toChatTypeNumber(row.chatType) === ChatType.KCHATTYPEC2C)
      .map((row) => row.targetUid),
  );
  const deletedIds = new Set(
    historical
      .filter((row) => row.chatType === ChatType.KCHATTYPEC2C || row.chatType === 10)
      .map((row) => row.targetUid),
  );
  const profileByUid = new Map(people.map((row) => [row.uid, row]));
  const buddyByUid = new Map(buddies.map((row) => [row.uid, row]));
  const buddyByUin = new Map(buddies.map((row) => [row.uin.toString(), row]));
  const groupNames = new Map(
    details.map((row) => [row.groupCode.toString(), row.groupName || row.remark]),
  );
  type Candidate = {
    uid: string;
    uin: string;
    nick: string;
    remark?: string;
    avatarUrl?: string | null;
    conversation?: boolean;
    temporary?: boolean;
    chatType?: number;
    aliases?: string[];
    group?: ContactSearchHit['groups'][number];
  };
  const candidates: Candidate[] = [
    ...cached,
    ...direct.map((row) => ({
      uid: row.targetUid,
      uin: row.targetUin,
      nick: row.name,
      remark: row.remark,
      aliases: [row.groupNick],
      conversation: true,
      temporary:
        classifyChatType(row.chatType) === 'direct' && row.chatType !== ChatType.KCHATTYPEC2C,
      chatType: row.chatType,
    })),
    ...historical.map((row) => ({
      uid: row.targetUid,
      uin: '',
      nick: '',
      conversation: true,
      chatType: row.chatType,
    })),
    ...hiddenContacts.map((row) => ({
      uid: row.targetUid,
      uin: row.targetUin,
      nick: '',
      conversation: true,
      chatType: toChatTypeNumber(row.chatType) ?? undefined,
    })),
    ...services.map((row) => ({
      uid: String(row.appId),
      uin: '',
      nick: row.displayName,
      avatarUrl: row.avatarUrl,
      conversation: true,
      chatType: ChatType.KCHATTYPESERVICEASSISTANT,
    })),
    ...members.items.map((row) => ({
      uid: row.uid,
      uin: row.uin,
      nick: row.nick,
      group: {
        groupCode: row.groupCode,
        groupName: groupNames.get(row.groupCode) || row.groupCode,
        display: row.card || row.nick || row.uin,
      },
    })),
  ];
  // UID-only 行也通过同批资料和 UID 映射补足号码，避免与号码已知的同一人重复。
  const uinByUid = new Map<string, string>();
  for (const row of candidates) {
    const uin =
      validUin(row.uin) ||
      validUin(profileByUid.get(row.uid)?.uin.toString() ?? '') ||
      validUin(buddyByUid.get(row.uid)?.uin.toString() ?? '') ||
      validUin(session.uidMap.uinByUid(row.uid)?.toString() ?? '');
    if (uin) uinByUid.set(row.uid, uin);
  }
  const merged = new Map<string, ContactSearchHit>();
  for (const row of candidates) {
    const profile = profileByUid.get(row.uid);
    const uin = uinByUid.get(row.uid) || validUin(row.uin);
    if (!row.uid && !uin) continue;
    const special =
      row.chatType !== undefined &&
      ['dataline', 'official', 'service'].includes(classifyChatType(row.chatType) ?? '');
    const key = special ? `chat:${row.chatType}:${row.uid}` : uin ? `uin:${uin}` : `uid:${row.uid}`;
    const buddy = special ? undefined : (buddyByUid.get(row.uid) ?? buddyByUin.get(uin));
    const friend = Boolean(buddy);
    let hit = merged.get(key);
    if (!hit) {
      hit = {
        category: 'contact',
        uid: buddy?.uid || row.uid,
        uin,
        nick: profile?.nick || row.nick,
        remark: profile?.remark || row.remark || '',
        avatarUrl: profile?.avatarUrl || row.avatarUrl || null,
        isFriend: friend,
        hasConversation: false,
        temporary: false,
        aliases: [],
        groups: [],
      };
      merged.set(key, hit);
    }
    if (friend && !hit.isFriend) {
      hit.uid = buddy?.uid || row.uid;
      hit.nick = profile?.nick || row.nick || hit.nick;
      hit.remark = profile?.remark || row.remark || hit.remark;
      hit.avatarUrl = profile?.avatarUrl || row.avatarUrl || hit.avatarUrl;
    }
    hit.uid ||= row.uid;
    hit.nick ||= profile?.nick || row.nick;
    hit.isFriend ||= friend;
    hit.hasConversation ||= Boolean(row.conversation);
    if (row.chatType !== undefined) hit.chatType = row.chatType;
    hit.temporary ||= Boolean(row.temporary);
    hit.aliases = [
      ...new Set(
        [
          ...hit.aliases,
          row.nick,
          row.uid,
          row.remark || '',
          profile?.nick || '',
          profile?.remark || '',
          row.group?.display || '',
          ...(row.aliases ?? []),
        ].filter(Boolean),
      ),
    ];
    if (row.group && !hit.groups.some((group) => group.groupCode === row.group!.groupCode))
      hit.groups.push(row.group);
  }
  for (const hit of merged.values()) {
    const kind = classifyChatType(hit.chatType ?? ChatType.KCHATTYPEC2C);
    if (kind === 'official' || kind === 'service') continue;
    const view = conversationViewForIdentity(hit.uid, currentIds, recent, hiddenIds, deletedIds);
    if (view) hit.conversationView = view;
  }
  return [...merged.values()]
    .filter((hit) => searchNameRank(keyword, hit.uid, hit.uin, ...hit.aliases) > 0)
    .sort(
      (a, b) =>
        searchNameRank(keyword, b.uid, b.uin, ...b.aliases) -
          searchNameRank(keyword, a.uid, a.uin, ...a.aliases) ||
        a.uid.localeCompare(b.uid) ||
        a.uin.localeCompare(b.uin),
    );
}

export async function searchGroups(
  session: AccountSession,
  keyword: string,
): Promise<GroupSearchHit[]> {
  const [cached, conversations, deleted, directory, hidden] = await Promise.all([
    session.groupDetail.searchIdentities(keyword),
    session.recentContacts.searchIdentities(keyword),
    session.deletedSessions.listDeletedSessions(),
    session.groupDetail.listDirectory(),
    session.hiddenSessions?.listHiddenSessions() ?? [],
  ]);
  const groupConversations = conversations.filter(
    (row) => classifyChatType(row.chatType) === 'group',
  );
  const historical = [
    ...deleted.filter((row) => classifyChatType(row.chatType) === 'group'),
    ...hidden.filter((row) => classifyChatType(row.chatType) === 'group'),
  ];
  const targetIds = [...groupConversations, ...historical].map((row) => row.targetUid);
  const [details, recent] = await Promise.all([
    groupDetails(session, targetIds),
    recentConversationEvidence(session, targetIds),
  ]);
  const currentIds = new Set(groupConversations.map((row) => row.targetUid));
  const hiddenIds = new Set(
    hidden.filter((row) => classifyChatType(row.chatType) === 'group').map((row) => row.targetUid),
  );
  const deletedIds = new Set(
    deleted.filter((row) => classifyChatType(row.chatType) === 'group').map((row) => row.targetUid),
  );
  const groupDirectory = new Map(directory.map((row) => [row.groupCode, row]));
  const detailByCode = new Map(details.map((row) => [row.groupCode.toString(), row]));
  const current = new Set(directory.map((row) => row.groupCode));
  const candidates = [
    ...cached.map((row) => ({ ...row, hasConversation: false })),
    ...groupConversations.map((row) => ({
      groupCode: row.targetUid,
      name: row.name,
      remark: row.remark,
      inDirectory: current.has(row.targetUid),
      hasConversation: true,
    })),
    ...historical.map((row) => ({
      groupCode: row.targetUid,
      name: '',
      remark: '',
      inDirectory: current.has(row.targetUid),
      hasConversation: true,
    })),
  ];
  const merged = new Map<string, GroupSearchHit>();
  for (const row of candidates) {
    const code = validUin(row.groupCode);
    if (!code) continue;
    const detail = detailByCode.get(code);
    let hit = merged.get(code);
    if (!hit) {
      hit = {
        category: 'group',
        groupCode: code,
        name: detail?.groupName || row.name || code,
        remark: detail?.remark || row.remark,
        inDirectory: current.has(code),
        hasConversation: false,
        aliases: [],
      };
      merged.set(code, hit);
    }
    hit.hasConversation ||= row.hasConversation;
    hit.aliases = [
      ...new Set(
        [
          ...hit.aliases,
          row.name,
          row.remark,
          detail?.groupName || '',
          detail?.remark || '',
        ].filter(Boolean),
      ),
    ];
  }
  for (const hit of merged.values()) {
    const view = conversationViewForIdentity(
      hit.groupCode,
      currentIds,
      recent,
      hiddenIds,
      deletedIds,
      groupDirectory,
    );
    if (view) hit.conversationView = view;
  }
  return [...merged.values()]
    .filter((hit) => searchNameRank(keyword, hit.groupCode, ...hit.aliases) > 0)
    .sort(
      (a, b) =>
        searchNameRank(keyword, b.groupCode, ...b.aliases) -
          searchNameRank(keyword, a.groupCode, ...a.aliases) ||
        a.groupCode.localeCompare(b.groupCode),
    );
}
