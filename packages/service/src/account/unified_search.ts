/**
 * UnifiedSearchService — the all-in-one sidebar search.
 *
 * One keyword, five result categories:
 *   - conversations  (recent_contact_v3_table.40094 name match)
 *   - friends        (buddy_list ⋈ profile_info_v6, uin / nick match)
 *   - group members  (group_member3, uin / nick match, across all groups)
 *   - chat records   (buddy/group FTS 41701 count per 40027 → top conversations)
 *   - files          (buddy/group FTS 41702 filename match)
 *
 * The first three are fast (indexed / small tables) and drive the quick
 * dropdown; the last two scan the big FTS content tables and come in later
 * (the UI shows skeletons meanwhile). Everything bigint is stringified here so
 * the IPC layer needs no extra serde.
 */

import { join } from 'node:path';
import { classifyChatType } from '@weq/codec';
import { algoFor, type AccountSession } from '@weq/account';
import { MsgSearchIndexDb, type BuddyMsgFtsHit } from '@weq/db';
import type { NtHelperBinding } from '@weq/native';

export interface UnifiedSearchServiceOptions {
  /**
   * Directory for the local trigram search index (one subdir per source db).
   * Omit to disable the index and fall back to plain LIKE scans.
   */
  dataDir?: string;
  /** Native binding used for bulk decrypt + plain-SQLite index writes. */
  nt?: NtHelperBinding;
}

export type SearchCategory = 'conversation' | 'friend' | 'groupMember' | 'chatRecord' | 'file';
export type FtsSource = 'buddy' | 'group';

export interface ConversationSearchHit {
  category: 'conversation';
  /** Conversation key: peer uid (c2c) or group code (group). */
  targetUid: string;
  /** Peer QQ number when c2c (for avatar fallback); '0' otherwise. */
  targetUin: string;
  chatType: number;
  name: string;
  typeLabel: string;
}

export interface FriendSearchHit {
  category: 'friend';
  uid: string;
  uin: string;
  nick: string;
  remark: string;
  avatarUrl: string | null;
}

export interface GroupMemberSearchHit {
  category: 'groupMember';
  groupCode: string;
  memberUid: string;
  memberUin: string;
  /** Display value: the matched nick, or the uin when the nick didn't match. */
  memberDisplay: string;
  groupName: string;
}

export interface ChatRecordSearchHit {
  category: 'chatRecord';
  source: FtsSource;
  /** 40027 — buddy: peer sortNo; group: group code. */
  partition: string;
  /** Conversation key: peer uid (buddy) or group code (group). */
  targetUid: string;
  targetUin: string;
  name: string;
  count: number;
}

export interface FileSearchHit {
  category: 'file';
  source: FtsSource;
  partition: string;
  targetUid: string;
  targetUin: string;
  fileName: string;
  /** In-conversation seq — jump anchor when present. */
  msgSeq: string;
  sendTime: string;
  convName: string;
}

/** One chat-record modal message row (rendered straight from the FTS text). */
export interface ConversationRecordHit {
  msgId: string;
  msgSeq: string;
  senderUid: string;
  sendTime: string;
  content: string;
}

export interface QuickSearchResult {
  conversations: ConversationSearchHit[];
  friends: FriendSearchHit[];
  groupMembers: GroupMemberSearchHit[];
}

export interface SlowSearchResult {
  chatRecords: ChatRecordSearchHit[];
  files: FileSearchHit[];
  /** Local trigram index status — 'disabled' | 'building' | 'ready'. */
  indexStatus: 'disabled' | 'building' | 'ready';
}

export interface MoreSearchResult {
  category: SearchCategory;
  items: Array<
    | ConversationSearchHit
    | FriendSearchHit
    | GroupMemberSearchHit
    | ChatRecordSearchHit
    | FileSearchHit
  >;
  total: number;
  hasMore: boolean;
}

export class UnifiedSearchService {
  /** Small keyword cache for the expensive FTS scans (chat records / files). */
  private readonly slowCache = new Map<string, { at: number; value: SlowSearchResult }>();
  private readonly chatRecordCache = new Map<
    string,
    { at: number; value: ChatRecordSearchHit[] }
  >();
  private readonly fileCache = new Map<string, { at: number; value: FileSearchHit[] }>();
  private readonly buddyIndex?: MsgSearchIndexDb;
  private readonly groupIndex?: MsgSearchIndexDb;
  private indexSyncPromise: Promise<void> | null = null;
  private lastIndexSyncAt = 0;
  private indexFailed = false;

  constructor(
    private readonly session: AccountSession,
    options: UnifiedSearchServiceOptions = {},
  ) {
    if (!options.dataDir || !options.nt) return;
    const dataDir = options.dataDir;
    this.buddyIndex = this.createIndex(
      options.nt,
      dataDir,
      session.buddyMsgFts.dbPath,
      'buddy_msg_fts',
    );
    this.groupIndex = this.createIndex(
      options.nt,
      dataDir,
      session.groupMsgFts.dbPath,
      'group_msg_fts',
    );
  }

  private createIndex(
    nt: NtHelperBinding,
    dataDir: string,
    sourcePath: string,
    tableName: string,
  ): MsgSearchIndexDb | undefined {
    return new MsgSearchIndexDb({
      nt,
      sourcePath,
      indexDbPath: join(dataDir, tableName, 'index.db'),
      key: this.session.context.dbKey,
      algo: algoFor(this.session.context, sourcePath),
      tableName,
    });
  }

  /**
   * Local index status — 'disabled' when the service was built without index
   * options, 'building' while the (one-time) full build runs, 'ready' after.
   */
  get indexStatus(): 'disabled' | 'building' | 'ready' {
    if (!this.buddyIndex || !this.groupIndex) return 'disabled';
    if (this.indexFailed) return 'disabled';
    if (this.indexSyncPromise) return 'building';
    return this.buddyIndex.ready && this.groupIndex.ready ? 'ready' : 'building';
  }

  /**
   * Coalesced, throttled (≥30s apart) index sync. Never rejects — failures
   * leave the index disabled and every query falls back to the LIKE scans.
   */
  ensureIndexes(): Promise<void> {
    if (!this.buddyIndex || !this.groupIndex) return Promise.resolve();
    if (this.indexSyncPromise) return this.indexSyncPromise;
    const now = Date.now();
    if (now - this.lastIndexSyncAt < 30_000) return Promise.resolve();
    this.lastIndexSyncAt = now;
    this.indexSyncPromise = Promise.all([this.buddyIndex.sync(), this.groupIndex.sync()])
      .then(() => undefined)
      .catch((e) => {
        this.indexFailed = true;
        console.error('[unified-search] index sync failed, falling back to LIKE:', e);
      })
      .finally(() => {
        this.indexSyncPromise = null;
      });
    return this.indexSyncPromise;
  }

  // ---------------------------------------------------------------- public

  /** Fast categories, in display order: conversations, friends, group members. */
  async quickSearch(keyword: string, limit = 3): Promise<QuickSearchResult> {
    const needle = keyword.trim();
    if (!needle) return { conversations: [], friends: [], groupMembers: [] };
    const [convPage, friendPage, memberPage] = await Promise.all([
      this.session.recentContacts.searchByName(needle, limit, 0),
      this.session.profileInfo.searchFriends(needle, limit, 0),
      this.session.groupMembers.searchMembers(needle, limit, 0),
    ]);

    const memberHits = await this.decorateMembers(memberPage.items, needle);
    return {
      conversations: convPage.items.map((c) => ({
        category: 'conversation' as const,
        targetUid: c.targetUid,
        targetUin: c.targetUin.toString(),
        chatType: Number(c.chatType) || 0,
        name: c.targetDisplayName,
        typeLabel: conversationTypeLabel(c.chatType),
      })),
      friends: friendPage.items.map((f) => ({
        category: 'friend' as const,
        uid: f.uid,
        uin: f.uin,
        nick: f.nick,
        remark: f.remark,
        avatarUrl: f.avatarUrl,
      })),
      groupMembers: memberHits,
    };
  }

  /** Slow categories: chat records + files. Cached per keyword (30s TTL). */
  async slowSearch(keyword: string, _limit = 3): Promise<SlowSearchResult> {
    const needle = keyword.trim();
    if (!needle) return { chatRecords: [], files: [], indexStatus: this.indexStatus };
    const cached = this.slowCache.get(needle);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;

    // Ensure the local trigram index is (or becomes) available. Fire-and-forget:
    // the first query still runs the LIKE fallback; later ones use the index.
    void this.ensureIndexes();

    const [chatRecords, files] = await Promise.all([
      this.topChatRecordConversations(needle, 3),
      this.topFiles(needle, 3),
    ]);
    const value = { chatRecords, files, indexStatus: this.indexStatus };
    this.slowCache.set(needle, { at: Date.now(), value });
    return value;
  }

  /** Paginated full results for the "more" modal. */
  async moreSearch(
    category: SearchCategory,
    keyword: string,
    offset: number,
    limit: number,
  ): Promise<MoreSearchResult> {
    const needle = keyword.trim();
    if (!needle) {
      return { category, items: [], total: 0, hasMore: false };
    }
    const page = Math.max(1, limit);

    switch (category) {
      case 'conversation': {
        const r = await this.session.recentContacts.searchByName(needle, page, offset);
        return {
          category,
          items: r.items.map((c) => ({
            category: 'conversation' as const,
            targetUid: c.targetUid,
            targetUin: c.targetUin.toString(),
            chatType: Number(c.chatType) || 0,
            name: c.targetDisplayName,
            typeLabel: conversationTypeLabel(c.chatType),
          })),
          total: r.total,
          hasMore: offset + r.items.length < r.total,
        };
      }
      case 'friend': {
        const r = await this.session.profileInfo.searchFriends(needle, page, offset);
        return {
          category,
          items: r.items.map((f) => ({
            category: 'friend' as const,
            uid: f.uid,
            uin: f.uin,
            nick: f.nick,
            remark: f.remark,
            avatarUrl: f.avatarUrl,
          })),
          total: r.total,
          hasMore: offset + r.items.length < r.total,
        };
      }
      case 'groupMember': {
        const r = await this.session.groupMembers.searchMembers(needle, page, offset);
        return {
          category,
          items: await this.decorateMembers(r.items, needle),
          total: r.total,
          hasMore: offset + r.items.length < r.total,
        };
      }
      case 'chatRecord': {
        // Ranked list is bounded (~hundreds), computed once per keyword + cached.
        const ranked = await this.cachedChatRecordRanking(needle);
        const items = ranked.slice(offset, offset + page);
        return {
          category,
          items,
          total: ranked.length,
          hasMore: offset + items.length < ranked.length,
        };
      }
      case 'file': {
        const ranked = await this.cachedFileRanking(needle);
        const items = ranked.slice(offset, offset + page);
        return {
          category,
          items,
          total: ranked.length,
          hasMore: offset + items.length < ranked.length,
        };
      }
    }
  }

  /** Messages of ONE conversation matching the keyword (chat-record modal). */
  async conversationRecords(
    source: FtsSource,
    conv: string,
    keyword: string,
    offset = 0,
    limit = 20,
  ): Promise<{ items: ConversationRecordHit[]; total: number }> {
    const needle = keyword.trim();
    if (!needle) return { items: [], total: 0 };
    const partition = await this.conversationPartition(source, conv);
    if (partition === undefined) return { items: [], total: 0 };

    const db = source === 'group' ? this.session.groupMsgFts : this.session.buddyMsgFts;
    const r = await db.searchInPartition(partition, needle, limit, offset);
    return {
      items: r.items.map((h) => rowToRecordHit(h)),
      total: r.total,
    };
  }

  // ------------------------------------------------------------- internals

  /** buddy: uid → sortNo; group: conv IS the group code. */
  private async conversationPartition(
    source: FtsSource,
    conv: string,
  ): Promise<bigint | undefined> {
    if (source === 'group') {
      const code = BigInt(conv);
      return Number.isNaN(Number(code)) ? undefined : code;
    }
    return this.session.uidMap.sortNoByUid(conv);
  }

  /** Resolve group names for member hits in one batched query. */
  private async decorateMembers(
    items: Array<{ groupCode: string; uid: string; uin: string; nick: string }>,
    keyword: string,
  ): Promise<GroupMemberSearchHit[]> {
    if (items.length === 0) return [];
    const codes = [...new Set(items.map((m) => m.groupCode).filter(Boolean))].map((c) => BigInt(c));
    const details = await this.session.groupDetail.detailsByGroupCodes(codes);
    const nameByCode = new Map(
      details.map((d) => [d.groupCode.toString(), d.groupName || d.remark]),
    );
    const needle = keyword.trim().toLowerCase();
    return items.map((m) => {
      const groupName = nameByCode.get(m.groupCode) || m.groupCode;
      const nickMatched = !!m.nick && m.nick.toLowerCase().includes(needle);
      return {
        category: 'groupMember' as const,
        groupCode: m.groupCode,
        memberUid: m.uid,
        memberUin: m.uin,
        memberDisplay: nickMatched ? m.nick : m.uin || m.nick,
        groupName,
      };
    });
  }
  /** buddy FTS 40027 = sortNo → uid → recent-contact / profile name. */
  private async buddyConvIdentity(
    partition: bigint,
  ): Promise<{ uid: string; uin: string; name: string }> {
    const uid = this.session.uidMap.uidBySortNo(partition) ?? '';
    const uin = uid ? (this.session.uidMap.uinByUid(uid) ?? 0n).toString() : '0';
    if (!uid) return { uid: '', uin: '0', name: '' };
    const recents = await this.session.recentContacts.getByTargetUids([uid]);
    if (recents.length > 0 && recents[0]!.targetDisplayName) {
      return { uid, uin, name: recents[0]!.targetDisplayName };
    }
    const nicks = await this.session.profileInfo.nicksByUids([uid]);
    return { uid, uin, name: nicks[uid] || uid };
  }

  private async groupConvName(groupCode: bigint): Promise<string> {
    const details = await this.session.groupDetail.detailsByGroupCodes([groupCode]);
    const d = details[0];
    return d?.groupName || d?.remark || groupCode.toString();
  }

  /** Top conversations by match count across buddy + group FTS. */
  private async topChatRecordConversations(
    keyword: string,
    limit: number,
  ): Promise<ChatRecordSearchHit[]> {
    const ranked = await this.cachedChatRecordRanking(keyword);
    return ranked.slice(0, limit);
  }

  private async cachedChatRecordRanking(keyword: string): Promise<ChatRecordSearchHit[]> {
    const hit = this.chatRecordCache.get(keyword);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    // Indexed path first (trigram FTS5, ms-level); LIKE GROUP BY as fallback.
    const indexed = trigramReady(keyword);
    const [buddyTop, groupTop] = await Promise.all([
      indexed && this.buddyIndex?.ready
        ? this.buddyIndex.topPartitions(keyword, 200)
        : this.session.buddyMsgFts.topConversationsByKeyword(keyword, 200),
      indexed && this.groupIndex?.ready
        ? this.groupIndex.topPartitions(keyword, 200)
        : this.session.groupMsgFts.topConversationsByKeyword(keyword, 200),
    ]);

    // Resolve identities for all ranked partitions in parallel.
    const [buddyIds, groupNames] = await Promise.all([
      Promise.all(buddyTop.map((t) => this.buddyConvIdentity(t.partition))),
      (async () => {
        const codes = [...new Set(groupTop.map((t) => t.partition))];
        const details = await this.session.groupDetail.detailsByGroupCodes(codes);
        const map = new Map(details.map((d) => [d.groupCode.toString(), d.groupName || d.remark]));
        return groupTop.map((t) => map.get(t.partition.toString()) || t.partition.toString());
      })(),
    ]);

    const buddyHits: ChatRecordSearchHit[] = buddyTop.map((t, i) => ({
      category: 'chatRecord',
      source: 'buddy',
      partition: t.partition.toString(),
      targetUid: buddyIds[i]!.uid,
      targetUin: buddyIds[i]!.uin,
      name: buddyIds[i]!.name,
      count: t.count,
    }));
    const groupHits: ChatRecordSearchHit[] = groupTop.map((t, i) => ({
      category: 'chatRecord',
      source: 'group',
      partition: t.partition.toString(),
      targetUid: t.partition.toString(),
      targetUin: '0',
      name: groupNames[i]!,
      count: t.count,
    }));

    const value = [...buddyHits, ...groupHits].sort((a, b) => b.count - a.count);
    this.chatRecordCache.set(keyword, { at: Date.now(), value });
    return value;
  }

  /** Top matching file names across buddy + group FTS (deduped by name). */
  private async topFiles(keyword: string, limit: number): Promise<FileSearchHit[]> {
    const ranked = await this.cachedFileRanking(keyword);
    return ranked.slice(0, limit);
  }

  private async cachedFileRanking(keyword: string): Promise<FileSearchHit[]> {
    const hit = this.fileCache.get(keyword);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;

    // Pull a generous pool per source, newest first, then dedupe by file name.
    const indexed = trigramReady(keyword);
    const [buddyPool, groupPool] = await Promise.all([
      indexed && this.buddyIndex?.ready
        ? this.buddyIndex.searchFiles(keyword, 100, 0)
        : this.session.buddyMsgFts.searchFilesByKeyword(keyword, 100, 0),
      indexed && this.groupIndex?.ready
        ? this.groupIndex.searchFiles(keyword, 100, 0)
        : this.session.groupMsgFts.searchFilesByKeyword(keyword, 100, 0),
    ]);
    const seen = new Set<string>();
    const out: FileSearchHit[] = [];
    for (const h of [...buddyPool.items, ...groupPool.items]) {
      const name = h.fileName || '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(await this.fileHit(h));
    }
    const value = out.sort((a, b) => Number(b.sendTime) - Number(a.sendTime));
    this.fileCache.set(keyword, { at: Date.now(), value });
    return value;
  }

  private async fileHit(h: BuddyMsgFtsHit): Promise<FileSearchHit> {
    const isGroup = Number(h.chatType) === 2;
    if (isGroup) {
      return {
        category: 'file',
        source: 'group',
        partition: h.targetUid,
        targetUid: h.targetUid,
        targetUin: '0',
        fileName: h.fileName || '',
        msgSeq: h.msgSeq.toString(),
        sendTime: h.sendTime.toString(),
        convName: await this.groupConvName(BigInt(h.targetUid)),
      };
    }
    // buddy file rows carry the peer uid (40021) — resolve sortNo → uid → name.
    const sortNo = this.session.uidMap.sortNoByUid(h.targetUid) ?? 0n;
    const identity = await this.buddyConvIdentity(sortNo);
    return {
      category: 'file',
      source: 'buddy',
      partition: sortNo.toString(),
      targetUid: identity.uid || h.targetUid,
      targetUin: identity.uin,
      fileName: h.fileName || '',
      msgSeq: h.msgSeq.toString(),
      sendTime: h.sendTime.toString(),
      convName: identity.name,
    };
  }
}
function rowToRecordHit(h: BuddyMsgFtsHit): ConversationRecordHit {
  return {
    msgId: h.msgId.toString(),
    msgSeq: h.msgSeq.toString(),
    senderUid: h.senderUid,
    sendTime: h.sendTime.toString(),
    content: h.content,
  };
}

/** trigram tokenizer only matches 3+ character substrings. */
function trigramReady(keyword: string): boolean {
  return [...keyword.trim()].length >= 3;
}

/** Human label for a recent-contact chatType (from the codec ChatKind). */
function conversationTypeLabel(chatType: string | number): string {
  switch (classifyChatType(chatType)) {
    case 'direct':
      return '私聊';
    case 'group':
      return '群聊';
    case 'dataline':
      return '数据线';
    case 'service':
      return '服务号';
    case 'official':
      return '公众号';
    default:
      return '会话';
  }
}
