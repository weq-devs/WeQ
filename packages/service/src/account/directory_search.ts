import type { AccountSession } from '@weq/account';
import { classifyChatType, ChatType } from '@weq/codec';
import { searchNameRank } from './search_policy';

export interface ContactSearchHit {
  category: 'contact';
  uid: string;
  uin: string;
  nick: string;
  remark: string;
  avatarUrl: string | null;
  isFriend: boolean;
  hasConversation: boolean;
  temporary: boolean;
  aliases: string[];
  groups: Array<{ groupCode: string; groupName: string; display: string }>;
}

export interface GroupSearchHit {
  category: 'group';
  groupCode: string;
  name: string;
  remark: string;
  inDirectory: boolean;
  hasConversation: boolean;
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

/** 合并的是本地身份，不把资料缓存或删除会话当作好友关系证明。 */
export async function searchContacts(
  session: AccountSession,
  keyword: string,
): Promise<ContactSearchHit[]> {
  const [cached, conversations, members, deleted, buddies] = await Promise.all([
    session.profileInfo.searchContacts(keyword),
    session.recentContacts.searchIdentities(keyword),
    session.groupMembers.searchMembers(keyword, -1, 0, {
      includeHistorical: true,
      includeCards: true,
    }),
    session.deletedSessions.listDeletedSessions(),
    session.buddies.listBuddies(),
  ]);
  const direct = conversations.filter((row) => classifyChatType(row.chatType) === 'direct');
  const historical = deleted.filter(
    (row) => classifyChatType(row.chatType) === 'direct' || row.chatType === 10,
  );
  const [details, people] = await Promise.all([
    groupDetails(
      session,
      members.items.map((row) => row.groupCode),
    ),
    profiles(session, [
      ...direct.map((row) => row.targetUid),
      ...historical.map((row) => row.targetUid),
      ...members.items.map((row) => row.uid),
    ]),
  ]);
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
      temporary: row.chatType !== ChatType.KCHATTYPEC2C,
    })),
    ...historical.map((row) => ({ uid: row.targetUid, uin: '', nick: '', conversation: true })),
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
    const key = uin ? `uin:${uin}` : `uid:${row.uid}`;
    const buddy = buddyByUid.get(row.uid) ?? buddyByUin.get(uin);
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
  const [cached, conversations, deleted, directory] = await Promise.all([
    session.groupDetail.searchIdentities(keyword),
    session.recentContacts.searchIdentities(keyword),
    session.deletedSessions.listDeletedSessions(),
    session.groupDetail.listDirectory(),
  ]);
  const groupConversations = conversations.filter(
    (row) => classifyChatType(row.chatType) === 'group',
  );
  const historical = deleted.filter((row) => classifyChatType(row.chatType) === 'group');
  const details = await groupDetails(
    session,
    [...groupConversations, ...historical].map((row) => row.targetUid),
  );
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
  return [...merged.values()]
    .filter((hit) => searchNameRank(keyword, hit.groupCode, ...hit.aliases) > 0)
    .sort(
      (a, b) =>
        searchNameRank(keyword, b.groupCode, ...b.aliases) -
          searchNameRank(keyword, a.groupCode, ...a.aliases) ||
        a.groupCode.localeCompare(b.groupCode),
    );
}
