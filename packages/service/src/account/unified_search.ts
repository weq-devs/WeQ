/**
 * 当前账号的统一搜索：联系人、群聊为快速来源，兼容旧会话、好友与群友接口；聊天正文、文件、收藏及
 * 生成对话独立并行读取。仅返回本地已取得内容，不隐式联网扩充覆盖范围。
 * bigint 在边界转成字符串，供桌面与 Web 共享 IPC 契约。
 */

import {
  classifyChatType,
  toChatTypeNumber,
  type MsgDecoration,
  type SetEmojiItem,
} from '@weq/codec';
import { algoFor, type AccountSession } from '@weq/account';
import {
  SourceMsgSearchDb,
  type SourceSearchQuery,
  type SourceSearchTable,
  type BuddyMsgFtsHit,
  type C2cMsg,
  type GroupMsg,
} from '@weq/db';
import { toRenderElements, type RenderElement } from './msg_view';
import { elementsToText } from './export/element_text';
import { extractArkCard, extractArkPrompt } from './ark_feed';
import { GuildDirectService } from './guild_direct';
import type { ConversationScope } from './search_policy';
import type { NtHelperBinding } from '@weq/native';
import type { CollectionSearchHit } from './collection_search';
import {
  DEFAULT_SEARCH_CATEGORIES,
  QZONE_SEARCH_CATEGORIES,
  isQzoneSearchCategory,
  qzoneSearchCoverage,
  rankContentSearchHits,
  rankFileSearchHits,
  searchNameRank,
  contentSourcesCoverage,
  DEFAULT_SEARCH_SOURCES,
  searchCategorySupportsSources,
  type SearchSource,
} from './search_policy';
import {
  searchContacts,
  searchGroups,
  type ContactSearchHit,
  type GroupSearchHit,
} from './directory_search';
export type { ContactSearchHit, GroupSearchHit } from './directory_search';
import {
  CONTENT_SEARCH_CATEGORIES,
  type ContentSearchCategory,
  type ContentSearchCoverage,
  type ContentSearchHit,
  type ContentSearchPage,
} from './content_search';
import {
  searchGeneratedMessages,
  type GeneratedSearchHit,
  type GeneratedSearchSources,
} from './generated_search';

export interface UnifiedSearchServiceOptions {
  searchContent?: (
    category: ContentSearchCategory,
    keyword: string,
    limit: number,
    offset: number,
  ) => Promise<ContentSearchPage> | ContentSearchPage;
  searchCollections?: (
    keyword: string,
    limit: number,
    offset: number,
  ) => Promise<{ items: CollectionSearchHit[]; total: number }>;
  generatedSources?: () => GeneratedSearchSources | undefined;
  /**
   * 旧搜索缓存的位置，仅供迁移清理；源库搜索不在这里创建数据库。
   */
  dataDir?: string;
  /** 读取 QQ 搜索库的 native；不会解密复制或写入源库。 */
  nt?: NtHelperBinding;
  sourceSearchQuery?: SourceSearchQuery;
  retireSearchIndex?: (
    source: FtsSource,
    sourcePath: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
}

export const SEARCH_CATEGORIES = [
  'contact',
  'group',
  'conversation',
  'friend',
  'groupMember',
  'chatRecord',
  'file',
  'qzone',
  'collection',
  'cloneMessage',
  'assistantMessage',
  ...CONTENT_SEARCH_CATEGORIES,
] as const;
export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];
export type FtsSource = 'buddy' | 'group';
export const SERVICE_SEARCH_CANDIDATE_LIMIT = 1000;

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
  /** 同一群命中的公告数，与聊天消息条数分开统计；点击该会话直接打开群聊。 */
  matchedBulletins?: number;
}

export interface FileSearchHit {
  category: 'file';
  source: FtsSource;
  partition: string;
  targetUid: string;
  targetUin: string;
  fileName: string;
  msgId: string;
  /** In-conversation seq — jump anchor when present. */
  msgSeq: string;
  sendTime: string;
  convName: string;
}

/** One chat-record modal message row. */
export interface ConversationRecordHit {
  msgId: string;
  msgSeq: string;
  senderUid: string;
  /** Sender QQ number ('' when unresolvable) — for the real sender avatar. */
  senderUin: string;
  /** Sender display name (group card/nick, '' when unknown). */
  senderName: string;
  sendTime: string;
  /**
   * Rendered display text: the original message's elements flattened to text,
   * or the FTS plain text when the original row was missing.
   */
  content: string;
  /**
   * Original message render-view elements — present when the original 40800
   * body was found in c2c/group_msg_table, so the front-end can render a real
   * bubble. Absent rows fall back to the plain `content` row.
   */
  elements?: RenderElement[];
  /** Group sticker reactions (column 40062). */
  setEmojiList?: SetEmojiItem[];
  /** Per-message decoration (column 40801): bubble/font/widget itemIds. */
  decoration?: MsgDecoration;
}

export interface QuickSearchResult {
  contacts?: ContactSearchHit[];
  groups?: GroupSearchHit[];
  conversations: ConversationSearchHit[];
  friends: FriendSearchHit[];
  groupMembers: GroupMemberSearchHit[];
}

/**
 * One `search_history` row（QQ 的「最近搜索」）— already JSON-safe, so the IPC
 * layer returns the array as-is.
 *
 * `kind` picks which fields matter:
 *   - friend      — uid / uin / nick / categoryName(好友分组) / matchedText
 *   - groupMember — uid / uin / nick / groupCard / groupCode / groupName
 *   - group       — groupCode / groupName（群头像用群号）
 *   - file        — fileName / fileSize / groupCode / groupName / sendTime /
 *                   msgId（file 的 uid/nick 是发送者）
 */
export interface SearchHistoryHit {
  kind: 'friend' | 'groupMember' | 'group' | 'file';
  /**
   * `search_history."100210"` — 自增主键，越大越新。QQ 淘汰旧行时会删行，所以它
   * 不连续，但每一行唯一；渲染层拿它做稳定 key（同一个人可能被搜过多次，光靠
   * uid / 群号之类去重会撞）。
   */
  histId: string;
  uid: string;
  uin: string;
  qid: string;
  name: string;
  nick: string;
  groupCard: string;
  categoryName: string;
  groupCode: string;
  groupName: string;
  chatType: number;
  fileName: string;
  fileSize: number;
  sendTime: string;
  msgId: string;
  matchedText: string;
}

export interface SlowSearchResult {
  messageCoverage?: ContentSearchCoverage;
  messageHits?: Array<ChatRecordSearchHit | GeneratedSearchHit | ContentSearchHit>;
  contentHits?: ContentSearchHit[];
  contentCoverage?: Partial<Record<ContentSearchCategory, ContentSearchCoverage>>;
  collections: CollectionSearchHit[];
  failedCategories?: SearchCategory[];
  chatRecords: ChatRecordSearchHit[];
  files: FileSearchHit[];
  cloneMessages: GeneratedSearchHit[];
  assistantMessages: GeneratedSearchHit[];
  /** Local trigram index status — 'disabled' | 'building' | 'ready'. */
  indexStatus: 'disabled' | 'building' | 'ready';
}

export interface MoreSearchResult {
  coverage?: ContentSearchCoverage;
  category: SearchCategory;
  items: Array<
    | ConversationSearchHit
    | ContactSearchHit
    | GroupSearchHit
    | FriendSearchHit
    | GroupMemberSearchHit
    | ChatRecordSearchHit
    | FileSearchHit
    | GeneratedSearchHit
    | CollectionSearchHit
    | ContentSearchHit
  >;
  total: number;
  hasMore: boolean;
  /** 命中超过本轮候选池上限；total 仅表示当前候选数，不是完整总数。 */
  limited?: boolean;
}

export class UnifiedSearchService {
  private readonly serviceMessageCache = new Map<
    string,
    {
      at: number;
      result: Promise<{ items: ConversationRecordHit[]; limited: boolean }>;
    }
  >();
  private readonly chatRecordCache = new Map<
    string,
    { at: number; value: ChatRecordSearchHit[]; limited: boolean }
  >();
  private readonly fileCache = new Map<
    string,
    { at: number; value: FileSearchHit[]; limited: boolean }
  >();
  private readonly buddyIndex?: SourceMsgSearchDb;
  private readonly groupIndex?: SourceMsgSearchDb;
  private indexSyncPromise: Promise<void> | null = null;
  private lastIndexSyncAt = 0;
  private disposed = false;
  private readonly retirementAbort = new AbortController();
  private readonly retiredSources = new Set<FtsSource>();
  private readonly retirementAttempts = new Map<FtsSource, number>();
  private readonly retirementPending = new Set<FtsSource>();

  constructor(
    private readonly session: AccountSession,
    private readonly options: UnifiedSearchServiceOptions = {},
  ) {
    if (!options.nt) return;
    this.buddyIndex = this.createIndex(options.nt, session.buddyMsgFts.dbPath, 'buddy_msg_fts');
    this.groupIndex = this.createIndex(options.nt, session.groupMsgFts.dbPath, 'group_msg_fts');
  }

  private createIndex(
    nt: NtHelperBinding,
    sourcePath: string,
    tableName: SourceSearchTable,
  ): SourceMsgSearchDb {
    return new SourceMsgSearchDb({
      nt,
      dbPath: sourcePath,
      key: this.session.context.dbKey,
      algo: algoFor(this.session.context, sourcePath),
      tableName,
      query: this.options.sourceSearchQuery,
    });
  }

  /** 兼容原状态枚举：building 表示校验源库，不再表示构建本地副本。 */
  get indexStatus(): 'disabled' | 'building' | 'ready' {
    if (!this.buddyIndex || !this.groupIndex) return 'disabled';
    if (this.indexSyncPromise) return 'building';
    return this.buddyIndex.ready || this.groupIndex.ready ? 'ready' : 'disabled';
  }

  /**
   * Coalesced, throttled (≥30s apart) index sync. Never rejects — failures
   * leave the index disabled and every query falls back to the LIKE scans.
   */
  ensureIndexes(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.buddyIndex || !this.groupIndex) return Promise.resolve();
    if (this.indexSyncPromise) return this.indexSyncPromise;
    const now = Date.now();
    if (now - this.lastIndexSyncAt < 30_000) return Promise.resolve();
    this.lastIndexSyncAt = now;
    this.indexSyncPromise = this.syncIndexes()
      .then(() => undefined)
      .catch((e) => {
        console.error('[unified-search] index sync failed, falling back to LIKE:', e);
      })
      .finally(() => {
        this.indexSyncPromise = null;
      });
    return this.indexSyncPromise;
  }

  /** 两个来源独立校验；缺失或不兼容的一个库不禁用另一个。QQ 自己维护增量。 */
  private async syncIndexes(): Promise<void> {
    const buddy = this.buddyIndex;
    const group = this.groupIndex;
    if (!buddy || !group) return;
    const results = await Promise.allSettled([buddy.sync(), group.sync()]);
    for (const result of results)
      if (result.status === 'rejected')
        console.warn(
          '[unified-search] source search unavailable, falling back to LIKE:',
          result.reason,
        );
  }
  dispose(): void {
    this.disposed = true;
    this.retirementAbort.abort(new Error('搜索来源已关闭'));
    this.buddyIndex?.dispose();
    this.groupIndex?.dispose();
    this.chatRecordCache.clear();
    this.fileCache.clear();
    this.serviceMessageCache.clear();
  }
  private maybeRetire(source: FtsSource): void {
    const index = source === 'group' ? this.groupIndex : this.buddyIndex;
    if (
      this.disposed ||
      !this.options.retireSearchIndex ||
      !index?.accelerated ||
      !index.indexedReadVerified ||
      this.retiredSources.has(source) ||
      this.retirementPending.has(source)
    )
      return;
    const now = Date.now();
    if (now - (this.retirementAttempts.get(source) ?? 0) < 60000) return;
    this.retirementAttempts.set(source, now);
    this.retirementPending.add(source);
    const path =
      source === 'group' ? this.session.groupMsgFts.dbPath : this.session.buddyMsgFts.dbPath;
    void this.options
      .retireSearchIndex(source, path, this.retirementAbort.signal)
      .then((done) => {
        if (done) this.retiredSources.add(source);
      })
      .catch((error) => {
        if (!this.disposed)
          console.warn('[unified-search] legacy cache retirement deferred:', error);
      })
      .finally(() => this.retirementPending.delete(source));
  }

  // ---------------------------------------------------------------- public

  /** 新对象类别在合并去重后取预览；旧分类按原有口径兼容返回。 */
  async quickSearch(
    keyword: string,
    limit = 3,
    categories?: readonly SearchCategory[],
    scope: ConversationScope = 'all',
    sources?: readonly SearchSource[],
  ): Promise<QuickSearchResult> {
    const needle = keyword.trim();
    if (!needle) return { conversations: [], friends: [], groupMembers: [] };
    const selected = this.selectedSources(scope, sources);
    const directoryScope = sources ? 'all' : scope;
    const [convPage, friendPage, memberPage, contacts, groups] = await Promise.all([
      selected.includes('qq') && (categories === undefined || categories.includes('conversation'))
        ? this.session.recentContacts.searchByName(needle, limit, 0)
        : { items: [] },
      selected.includes('qq') && (categories === undefined || categories.includes('friend'))
        ? this.session.profileInfo.searchFriends(needle, limit, 0)
        : { items: [] },
      selected.includes('qq') && (categories === undefined || categories.includes('groupMember'))
        ? this.session.groupMembers.searchMembers(needle, limit, 0)
        : { items: [] },
      categories?.includes('contact')
        ? this.directorySearch('contact', needle, directoryScope, selected)
        : undefined,
      categories?.includes('group')
        ? this.directorySearch('group', needle, directoryScope, selected)
        : undefined,
    ]);

    const memberHits = await this.decorateMembers(memberPage.items, needle);
    return {
      ...(contacts
        ? {
            contacts: contacts
              .filter((hit): hit is ContactSearchHit => hit.category === 'contact')
              .slice(0, limit),
          }
        : {}),
      ...(groups
        ? {
            groups: groups
              .filter((hit): hit is GroupSearchHit => hit.category === 'group')
              .slice(0, limit),
          }
        : {}),
      conversations: convPage.items.map((c) => ({
        category: 'conversation' as const,
        targetUid: c.targetUid,
        targetUin: c.targetUin.toString(),
        chatType: toChatTypeNumber(c.chatType) ?? 0,
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

  /**
   * QQ 自己的「最近搜索命中」列表（`nt_msg.db` 的 `search_history` 表）——
   * 搜索框空着时下拉里显示的那一份，最近搜过的在最前。
   *
   * 只读、只有几行，不需要分页；一行里带齐了展示需要的名字 / 头像种子
   * （uid / uin / 群号）和命中的那一段名字。
   */
  async searchHistory(limit = 20): Promise<SearchHistoryHit[]> {
    const rows = await this.session.searchHistory.list(limit);
    return rows.map((r) => ({
      kind: r.kind,
      histId: r.histId.toString(),
      uid: r.uid,
      uin: r.uin.toString(),
      qid: r.qid,
      name: r.name,
      nick: r.nick,
      groupCard: r.groupCard,
      categoryName: r.categoryName,
      groupCode: r.groupCode > 0n ? r.groupCode.toString() : '',
      groupName: r.groupName,
      chatType: r.chatType,
      fileName: r.fileName,
      fileSize: r.fileSize,
      sendTime: r.sendTime.toString(),
      msgId: r.msgId,
      matchedText: r.matchedText,
    }));
  }

  /** 慢来源并行读取，各类别失败独立呈现，不清空其它来源的有效结果。 */
  async slowSearch(
    keyword: string,
    limit = 3,
    categories?: readonly SearchCategory[],
    scope: ConversationScope = 'all',
    sources?: readonly SearchSource[],
  ): Promise<SlowSearchResult> {
    const needle = keyword.trim();
    const selected = this.selectedSources(scope, sources);
    const directoryScope = sources ? 'all' : scope;
    const enabled = (category: SearchCategory) =>
      Boolean(
        needle &&
          searchCategorySupportsSources(category, selected) &&
          (!sources || (category !== 'groupAlbum' && category !== 'marketEmoji')) &&
          ((categories ?? DEFAULT_SEARCH_CATEGORIES).includes(category) ||
            ((category === 'groupFile' || category === 'flashFile') &&
              (categories ?? DEFAULT_SEARCH_CATEGORIES).includes('file')) ||
            (isQzoneSearchCategory(category) &&
              (categories ?? DEFAULT_SEARCH_CATEGORIES).includes('qzone'))),
      );
    const failures = new Set<SearchCategory>();
    const read = async <T>(
      category: SearchCategory,
      query: () => T[] | Promise<T[]>,
    ): Promise<T[]> => {
      if (!enabled(category)) return [];
      try {
        return await query();
      } catch (error) {
        failures.add(category);
        console.error(`[unified-search] ${category} failed:`, error);
        return [];
      }
    };
    if ((enabled('chatRecord') && selected.includes('qq')) || enabled('file'))
      void this.ensureIndexes();
    const generated = (category: 'cloneMessage' | 'assistantMessage') => {
      const sources = this.options.generatedSources?.();
      return sources ? searchGeneratedMessages(sources, category, needle).slice(0, limit) : [];
    };
    const contentCoverage: Partial<Record<ContentSearchCategory, ContentSearchCoverage>> = {};
    const content = Promise.all(
      CONTENT_SEARCH_CATEGORIES.map((category) =>
        read<ContentSearchHit>(category, async () => {
          const page = await this.options.searchContent?.(category, needle, limit, 0);
          if (page) contentCoverage[category] = page.coverage;
          return page?.items ?? [];
        }),
      ),
    );
    let messageCoverage: ContentSearchCoverage | undefined;
    const [messageHits, files, collections, cloneMessages, assistantMessages] = await Promise.all([
      read('chatRecord', async () => {
        const page = await this.messageSearch(
          needle,
          0,
          limit,
          directoryScope,
          selected,
          (category, error) => {
            failures.add(category);
            console.error(`[unified-search] ${category} failed:`, error);
          },
        );
        messageCoverage = page.coverage;
        return page.items;
      }),
      read('file', () => this.topFiles(needle, limit)),
      read<CollectionSearchHit>(
        'collection',
        async () => (await this.options.searchCollections?.(needle, limit, 0))?.items ?? [],
      ),
      read('cloneMessage', () => generated('cloneMessage')),
      read('assistantMessage', () => generated('assistantMessage')),
    ]);
    return {
      ...(this.options.searchContent
        ? { contentHits: (await content).flat(), contentCoverage }
        : {}),
      messageHits,
      messageCoverage,
      chatRecords: messageHits.filter(
        (hit): hit is ChatRecordSearchHit => hit.category === 'chatRecord',
      ),
      files,
      collections,
      cloneMessages,
      assistantMessages,
      failedCategories: SEARCH_CATEGORIES.filter((category) => failures.has(category)),
      indexStatus: this.indexStatus,
    };
  }

  /** Paginated full results for the "more" modal. */
  async moreSearch(
    category: SearchCategory,
    keyword: string,
    offset: number,
    limit: number,
    scope: ConversationScope = 'all',
    sources?: readonly SearchSource[],
  ): Promise<MoreSearchResult> {
    const needle = keyword.trim();
    const selected = this.selectedSources(scope, sources);
    const directoryScope = sources ? 'all' : scope;
    if (
      !needle ||
      !searchCategorySupportsSources(category, selected) ||
      (sources && (category === 'groupAlbum' || category === 'marketEmoji'))
    ) {
      return { category, items: [], total: 0, hasMore: false };
    }
    const page = Math.max(1, limit);

    switch (category) {
      case 'qzone': {
        const sources = await Promise.all(
          QZONE_SEARCH_CATEGORIES.map(async (source) => ({
            source,
            page: await this.options.searchContent?.(source, needle, offset + page, 0),
          })),
        );
        const ranked = rankContentSearchHits(
          needle,
          sources.flatMap((source) => source.page?.items ?? []),
        );
        const items = ranked.slice(offset, offset + page);
        const total = sources.reduce((sum, source) => sum + (source.page?.total ?? 0), 0);
        return {
          category,
          items,
          total,
          hasMore: offset + items.length < total,
          coverage: qzoneSearchCoverage(
            Object.fromEntries(
              sources.flatMap(({ source, page }) => (page ? [[source, page.coverage]] : [])),
            ),
          ),
        };
      }
      case 'contact':
      case 'group': {
        const ranked = await this.directorySearch(category, needle, directoryScope, selected);
        const items = ranked.slice(offset, offset + page);
        return {
          category,
          items,
          total: ranked.length,
          hasMore: offset + items.length < ranked.length,
        };
      }
      case 'qzonePost':
      case 'qzoneAlbum':
      case 'otherQzonePost':
      case 'otherQzoneAlbum':
      case 'groupAlbum':
      case 'groupFile':
      case 'mailMessage':
      case 'marketEmoji':
      case 'guildMessage':
      case 'groupBulletin':
      case 'groupEssence':
      case 'flashFile':
      case 'qzoneComment':
      case 'otherQzoneComment':
      case 'qzonePublicComment': {
        const result = await this.options.searchContent?.(category, needle, page, offset);
        return {
          category,
          items: result?.items ?? [],
          total: result?.total ?? 0,
          hasMore: result ? offset + result.items.length < result.total : false,
          coverage: result?.coverage,
        };
      }
      case 'collection': {
        const result = (await this.options.searchCollections?.(needle, page, offset)) ?? {
          items: [],
          total: 0,
        };
        return { category, ...result, hasMore: offset + result.items.length < result.total };
      }
      case 'cloneMessage':
      case 'assistantMessage': {
        const sources = this.options.generatedSources?.();
        const ranked = sources ? searchGeneratedMessages(sources, category, needle) : [];
        const items = ranked.slice(offset, offset + page);
        return {
          category,
          items,
          total: ranked.length,
          hasMore: offset + items.length < ranked.length,
        };
      }
      case 'conversation': {
        const r = await this.session.recentContacts.searchByName(needle, page, offset);
        return {
          category,
          items: r.items.map((c) => ({
            category: 'conversation' as const,
            targetUid: c.targetUid,
            targetUin: c.targetUin.toString(),
            chatType: toChatTypeNumber(c.chatType) ?? 0,
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
        return {
          category,
          ...(await this.messageSearch(needle, offset, page, directoryScope, selected)),
        };
      }
      case 'file': {
        // 合并前各取足够的前缀，避免先分页再合并导致跨来源漏项或顺序漂移。
        const [messages, directory, flash] = await Promise.all([
          this.cachedFileRanking(needle),
          this.options.searchContent?.('groupFile', needle, offset + page, 0),
          this.options.searchContent?.('flashFile', needle, offset + page, 0),
        ]);
        const ranked = rankFileSearchHits<FileSearchHit | ContentSearchHit>(needle, [
          ...messages,
          ...(directory?.items ?? []),
          ...(flash?.items ?? []),
        ]);
        const items = ranked.slice(offset, offset + page);
        const total = messages.length + (directory?.total ?? 0) + (flash?.total ?? 0);
        return {
          category,
          items,
          total,
          hasMore: offset + items.length < total,
          limited: this.fileCache.get(needle)?.limited ?? false,
          coverage: contentSourcesCoverage(
            { groupFile: directory?.coverage, flashFile: flash?.coverage },
            ['groupFile', 'flashFile'],
          ),
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
  ): Promise<{ items: ConversationRecordHit[]; total: number; limited?: boolean }> {
    const needle = keyword.trim();
    if (!needle) return { items: [], total: 0 };
    if (source === 'buddy' && /^service:[1-9]\d*$/.test(conv)) {
      const { items, limited } = await this.serviceRecords(conv.slice('service:'.length));
      const matching = items.filter((row) =>
        row.content.toLocaleLowerCase().includes(needle.toLocaleLowerCase()),
      );
      return { items: matching.slice(offset, offset + limit), total: matching.length, limited };
    }
    const partition = await this.conversationPartition(source, conv);
    if (partition === undefined) return { items: [], total: 0 };

    const db = source === 'group' ? this.session.groupMsgFts : this.session.buddyMsgFts;
    const index = source === 'group' ? this.groupIndex : this.buddyIndex;
    const r = index?.ready
      ? await index.searchPartition(partition, needle, limit, offset, true)
      : await db.searchInPartition(partition, needle, limit, offset);
    this.maybeRetire(source);
    // 把 FTS 命中回查原消息表（同一 40027 分区 + 40003 seq），能取到真实
    // 40800 正文就渲染原消息，取不到（已撤回/未同步/行被删）回退 FTS 纯文本。
    const originals = await this.loadOriginalMessages(source, partition, r.items);
    return {
      items: await this.decorateSenders(source, conv, r.items, originals),
      total: r.total,
    };
  }

  /**
   * Batch-resolve FTS hits back to their original 40800 bodies. Queries the msg
   * table by the SAME indexed partition (40027) + msgSeq list (40003), so both
   * legs of the join hit the (40027,40003) composite index: the FTS rows were
   * already narrowed by 40027, and the original lookup stays inside that same
   * partition. Hits whose row is missing (recalled / unsynced / deleted) are
   * simply absent from the map — the caller falls back to the FTS text.
   */
  private async loadOriginalMessages(
    source: FtsSource,
    partition: bigint,
    hits: BuddyMsgFtsHit[],
  ): Promise<Map<bigint, C2cMsg | GroupMsg>> {
    const seqs = [...new Set(hits.map((h) => h.msgSeq).filter((s) => s > 0n))];
    if (seqs.length === 0) return new Map();
    const rows =
      source === 'group'
        ? await this.session.groupMsgs.listBySeqsInPartition(partition.toString(), seqs)
        : await this.session.c2cMsgs.listBySeqsInPartition({ sortNo: partition }, seqs);
    return new Map(rows.map((m) => [m.msgId, m]));
  }

  /** Resolve each FTS row's sender uid → uin + display name for the avatar row. */
  private async decorateSenders(
    source: FtsSource,
    conv: string,
    hits: BuddyMsgFtsHit[],
    originals: Map<bigint, C2cMsg | GroupMsg>,
  ): Promise<ConversationRecordHit[]> {
    const uids = [...new Set(hits.map((h) => h.senderUid).filter(Boolean))];
    const uinByUid = new Map<string, bigint>();
    const nameByUid = new Map<string, string>();
    // 原消息行自带 senderUin（40033），比 FTS 后反查更可靠（含退群/换号场景）。
    for (const h of hits) {
      const orig = originals.get(h.msgId);
      if (orig && orig.senderUin > 0n) uinByUid.set(h.senderUid, orig.senderUin);
    }
    if (source === 'group') {
      // 群消息：发送者是群成员，批量查 group_member3 拿 uin + 群名片/昵称。
      const members = await this.session.groupMembers.getMembersByUids(BigInt(conv), uids);
      for (const m of members) {
        uinByUid.set(m.uid, m.uin);
        nameByUid.set(m.uid, m.card || m.nick || '');
      }
    }
    // 兜底：曾在私聊里出现过的 uid 也能从 uid 映射表反查出 uin。
    for (const uid of uids) {
      if (!uinByUid.has(uid)) {
        const uin = this.session.uidMap.uinByUid(uid);
        if (uin) uinByUid.set(uid, uin);
      }
    }
    return hits.map((h) => {
      const uin = uinByUid.get(h.senderUid);
      const orig = originals.get(h.msgId);
      const rendered = orig ? toRenderElements(orig.elements) : undefined;
      return rowToRecordHit(
        h,
        uin ? uin.toString() : '0',
        nameByUid.get(h.senderUid) ?? '',
        orig ? originalContentText(rendered!, h.content) : h.content,
        orig
          ? {
              elements: rendered!,
              setEmojiList: source === 'group' ? (orig as GroupMsg).setEmojiList : undefined,
              decoration: orig.decoration,
            }
          : undefined,
      );
    });
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

  private async directorySearch(
    category: 'contact' | 'group',
    keyword: string,
    scope: ConversationScope,
    sources: readonly SearchSource[],
  ): Promise<Array<ContactSearchHit | GroupSearchHit>> {
    const hits: Array<ContactSearchHit | GroupSearchHit> =
      sources.includes('qq') && (scope === 'all' || scope === 'real')
        ? await (category === 'contact'
            ? searchContacts(this.session, keyword)
            : searchGroups(this.session, keyword))
        : [];
    if (sources.includes('clone')) {
      const lab = this.options.generatedSources?.()?.agentLab;
      if (lab) {
        for (const row of category === 'contact' ? lab.listPersonas() : lab.listGroups()) {
          if (!searchNameRank(keyword, row.name, row.id)) continue;
          hits.push(
            category === 'contact'
              ? {
                  category,
                  target: { kind: 'persona', ownerId: row.id },
                  uid: row.id,
                  uin: '',
                  nick: row.name,
                  remark: '',
                  avatarUrl: null,
                  isFriend: false,
                  hasConversation: true,
                  temporary: false,
                  aliases: [row.name, row.id],
                  groups: [],
                }
              : {
                  category,
                  target: { kind: 'group', ownerId: row.id },
                  groupCode: row.id,
                  name: row.name,
                  remark: '',
                  inDirectory: false,
                  hasConversation: true,
                  aliases: [row.name, row.id],
                },
          );
        }
      }
    }
    if (
      category === 'contact' &&
      sources.includes('qq') &&
      (scope === 'all' || scope === 'guild')
    ) {
      const rows = await new GuildDirectService(this.session).listSessions();
      for (const row of rows) {
        if (!searchNameRank(keyword, row.peerNick, row.peerTinyId)) continue;
        hits.push({
          category,
          target: { kind: 'guild', nodeId: row.nodeId },
          uid: row.peerTinyId,
          uin: '',
          nick: row.peerNick,
          remark: '',
          avatarUrl: row.peerAvatarUrl,
          isFriend: false,
          hasConversation: true,
          temporary: false,
          aliases: [row.peerNick, row.peerTinyId],
          groups: [],
        });
      }
    }
    const rank = (hit: ContactSearchHit | GroupSearchHit) =>
      hit.category === 'contact'
        ? searchNameRank(keyword, hit.uid, hit.uin, ...hit.aliases)
        : searchNameRank(keyword, hit.groupCode, ...hit.aliases);
    return hits.sort((a, b) => rank(b) - rank(a));
  }

  private async messageSearch(
    keyword: string,
    offset: number,
    limit: number,
    scope: ConversationScope,
    sources: readonly SearchSource[],
    onFailure?: (category: SearchCategory, error: unknown) => void,
  ) {
    // 各来源采用相同的名称相关度顺序，取足够前缀后再合并分页。
    const read = async <T>(
      category: SearchCategory,
      query: () => T | Promise<T>,
      fallback: T,
    ): Promise<T> => {
      try {
        return await query();
      } catch (error) {
        if (!onFailure) throw error;
        onFailure(category, error);
        return fallback;
      }
    };
    const [real, service, guild, groupContent] = await Promise.all([
      sources.includes('qq') && (scope === 'all' || scope === 'real')
        ? read('chatRecord', () => this.cachedChatRecordRanking(keyword), [])
        : [],
      sources.includes('qq') && (scope === 'all' || scope === 'real')
        ? read('chatRecord', () => this.serviceChatRecords(keyword), { items: [], limited: false })
        : { items: [], limited: false },
      sources.includes('qq') && (scope === 'all' || scope === 'guild')
        ? read(
            'guildMessage',
            () => this.options.searchContent?.('guildMessage', keyword, offset + limit, 0),
            undefined,
          )
        : undefined,
      sources.includes('qq') && (scope === 'all' || scope === 'real')
        ? Promise.all(
            (['groupBulletin', 'groupEssence'] as const).map((category) =>
              read(
                category,
                // 公告必须先按群合并，不能截取原公告页后再计算会话分页。
                () =>
                  this.options.searchContent?.(
                    category,
                    keyword,
                    category === 'groupBulletin' ? Number.MAX_SAFE_INTEGER : offset + limit,
                    0,
                  ),
                undefined,
              ),
            ),
          )
        : [],
    ]);
    const clones = sources.includes('clone')
      ? await read('cloneMessage', () => {
          const sources = this.options.generatedSources?.();
          return sources ? searchGeneratedMessages(sources, 'cloneMessage', keyword) : [];
        }, [])
      : [];
    const assistants = sources.includes('assistant')
      ? await read('assistantMessage', () => {
          const generated = this.options.generatedSources?.();
          return generated ? searchGeneratedMessages(generated, 'assistantMessage', keyword) : [];
        }, [])
      : [];
    const conversations = real.map((hit) => ({ ...hit }));
    const groupConversations = new Map(
      conversations.filter((hit) => hit.source === 'group').map((hit) => [hit.targetUid, hit]),
    );
    const bulletinCounts = new Map<string, number>();
    const bulletinTimes = new Map<string, number>();
    for (const hit of groupContent[0]?.items ?? []) {
      if (hit.category !== 'groupBulletin' || hit.target.kind !== 'groupBulletin') continue;
      const code = hit.target.groupCode;
      bulletinCounts.set(code, (bulletinCounts.get(code) ?? 0) + 1);
      bulletinTimes.set(code, Math.max(bulletinTimes.get(code) ?? 0, hit.time));
    }
    const missingGroups = [...bulletinCounts.keys()].filter(
      (code) => !groupConversations.has(code),
    );
    const details = missingGroups.length
      ? await this.session.groupDetail.detailsByGroupCodes(
          missingGroups.map((code) => BigInt(code)),
        )
      : [];
    const names = new Map(
      details.map((group) => [String(group.groupCode), group.groupName || group.remark]),
    );
    for (const [code, count] of bulletinCounts) {
      const existing = groupConversations.get(code);
      if (existing) existing.matchedBulletins = count;
      else
        conversations.push({
          category: 'chatRecord',
          source: 'group',
          partition: code,
          targetUid: code,
          targetUin: '0',
          name: names.get(code) || code,
          count: 0,
          matchedBulletins: count,
        });
    }
    const name = (hit: ChatRecordSearchHit | GeneratedSearchHit | ContentSearchHit) =>
      hit.category === 'chatRecord'
        ? hit.name
        : hit.category === 'assistantMessage'
          ? hit.sessionTitle
          : hit.title;
    const ranked = [
      ...conversations,
      ...service.items,
      ...clones,
      ...assistants,
      ...(guild?.items ?? []),
      ...(groupContent[1]?.items ?? []),
    ].sort(
      (a, b) =>
        searchNameRank(keyword, name(b)) - searchNameRank(keyword, name(a)) ||
        ('ts' in b
          ? b.ts
          : 'time' in b
            ? b.time
            : b.source === 'group'
              ? (bulletinTimes.get(b.targetUid) ?? 0)
              : 0) -
          ('ts' in a
            ? a.ts
            : 'time' in a
              ? a.time
              : a.source === 'group'
                ? (bulletinTimes.get(a.targetUid) ?? 0)
                : 0),
    );
    const items = ranked.slice(offset, offset + limit);
    const total =
      conversations.length +
      service.items.length +
      clones.length +
      assistants.length +
      (guild?.total ?? 0) +
      (groupContent[1]?.total ?? 0);
    return {
      items,
      total,
      hasMore: offset + items.length < total,
      limited:
        service.limited ||
        ((scope === 'all' || scope === 'real') &&
          (this.chatRecordCache.get(keyword)?.limited ?? false)),
      coverage: contentSourcesCoverage(
        {
          guildMessage: guild?.coverage,
          groupBulletin: groupContent[0]?.coverage,
          groupEssence: groupContent[1]?.coverage,
        },
        ['guildMessage', 'groupBulletin', 'groupEssence'],
      ),
    };
  }

  private selectedSources(scope: ConversationScope, sources?: readonly SearchSource[]) {
    if (sources) return sources;
    if (scope === 'virtual') return ['clone'] as const;
    if (scope === 'real' || scope === 'guild') return ['qq'] as const;
    return DEFAULT_SEARCH_SOURCES;
  }

  private async cachedChatRecordRanking(keyword: string): Promise<ChatRecordSearchHit[]> {
    const hit = this.chatRecordCache.get(keyword);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    // Indexed path first (trigram FTS5, ms-level); LIKE GROUP BY as fallback.
    const [buddyTop, groupTop] = await Promise.all([
      this.buddyIndex?.ready
        ? this.buddyIndex.topPartitions(keyword, 200)
        : this.session.buddyMsgFts.topConversationsByKeyword(keyword, 200),
      this.groupIndex?.ready
        ? this.groupIndex.topPartitions(keyword, 200)
        : this.session.groupMsgFts.topConversationsByKeyword(keyword, 200),
    ]);
    this.maybeRetire('buddy');
    this.maybeRetire('group');

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

    const value = [...buddyHits, ...groupHits].sort(
      (a, b) =>
        searchNameRank(keyword, b.name) - searchNameRank(keyword, a.name) ||
        b.count - a.count ||
        a.source.localeCompare(b.source) ||
        a.partition.localeCompare(b.partition),
    );
    this.chatRecordCache.set(keyword, {
      at: Date.now(),
      value,
      limited: buddyTop.length >= 200 || groupTop.length >= 200,
    });
    return value;
  }

  private async serviceChatRecords(keyword: string) {
    const contacts = (await this.session.serviceAssistantContacts?.listContacts()) ?? [];
    const pages = await Promise.all(
      contacts.map(async (contact) => {
        const appId = String(contact.appId);
        const page = await this.serviceRecords(appId);
        const count = page.items.filter((row) =>
          row.content.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()),
        ).length;
        return {
          limited: page.limited,
          hit: count
            ? {
                category: 'chatRecord' as const,
                source: 'buddy' as const,
                partition: appId,
                targetUid: `service:${appId}`,
                targetUin: '0',
                name: contact.displayName || appId,
                count,
              }
            : null,
        };
      }),
    );
    return {
      items: pages.flatMap((page) => (page.hit ? [page.hit] : [])),
      limited: pages.some((page) => page.limited),
    };
  }

  /** 服务号按独立消息表的原分区有界读取，不依赖普通私聊 FTS 的覆盖范围。 */
  private serviceRecords(
    appId: string,
  ): Promise<{ items: ConversationRecordHit[]; limited: boolean }> {
    const cached = this.serviceMessageCache.get(appId);
    if (cached && Date.now() - cached.at < 30_000) return cached.result;
    const result = (async () => {
      const rows =
        (await this.session.serviceAssistantMsgs?.listLatest(
          { appId: BigInt(appId) },
          SERVICE_SEARCH_CANDIDATE_LIMIT + 1,
        )) ?? [];
      return {
        limited: rows.length > SERVICE_SEARCH_CANDIDATE_LIMIT,
        items: rows.slice(0, SERVICE_SEARCH_CANDIDATE_LIMIT).map((row): ConversationRecordHit => {
          const elements = toRenderElements(row.elements);
          const cards = elements.flatMap((element) => {
            if (element.type !== 'ark') return [];
            const card = extractArkCard(element.data.arkData ?? '');
            return [extractArkPrompt(element) ?? '', card?.title ?? '', card?.text ?? ''].filter(
              Boolean,
            );
          });
          return {
            msgId: String(row.msgId),
            msgSeq: String(row.msgSeq),
            senderUid: row.senderUid,
            senderUin: String(row.senderUin),
            senderName: '',
            sendTime: String(row.sendTime),
            content: [...new Set([elementsToText(elements), ...cards])].join('\n'),
            elements,
          };
        }),
      };
    })();
    this.serviceMessageCache.set(appId, { at: Date.now(), result });
    while (this.serviceMessageCache.size > 32) {
      const oldest = this.serviceMessageCache.keys().next().value;
      if (oldest === undefined) break;
      this.serviceMessageCache.delete(oldest);
    }
    void result.catch(() => {
      if (this.serviceMessageCache.get(appId)?.result === result)
        this.serviceMessageCache.delete(appId);
    });
    return result;
  }

  /** 文件命中保留消息身份，不把不同会话里的同名附件合并。 */
  private async topFiles(keyword: string, limit: number): Promise<FileSearchHit[]> {
    const ranked = await this.cachedFileRanking(keyword);
    return ranked.slice(0, limit);
  }

  private async cachedFileRanking(keyword: string): Promise<FileSearchHit[]> {
    const hit = this.fileCache.get(keyword);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;

    // 候选池有界；只去掉同一来源、会话、消息的重复索引行。
    const [buddyPool, groupPool] = await Promise.all([
      this.buddyIndex?.ready
        ? this.buddyIndex.searchFiles(keyword, 100, 0)
        : this.session.buddyMsgFts.searchFilesByKeyword(keyword, 100, 0),
      this.groupIndex?.ready
        ? this.groupIndex.searchFiles(keyword, 100, 0)
        : this.session.groupMsgFts.searchFilesByKeyword(keyword, 100, 0),
    ]);
    this.maybeRetire('buddy');
    this.maybeRetire('group');
    const seen = new Set<string>();
    const out: FileSearchHit[] = [];
    const candidates = [
      ...buddyPool.items.map((hit) => ({ hit, source: 'buddy' as const })),
      ...groupPool.items.map((hit) => ({ hit, source: 'group' as const })),
    ].sort((a, b) => Number(b.hit.sendTime) - Number(a.hit.sendTime));
    for (const { hit: h, source } of candidates) {
      const name = h.fileName || '';
      const key = JSON.stringify([source, h.targetUid, h.msgId.toString()]);
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push(await this.fileHit(h, source));
    }
    const value = rankFileSearchHits(keyword, out);
    this.fileCache.set(keyword, {
      at: Date.now(),
      value,
      limited: buddyPool.total > buddyPool.items.length || groupPool.total > groupPool.items.length,
    });
    return value;
  }

  private async fileHit(h: BuddyMsgFtsHit, source: FtsSource): Promise<FileSearchHit> {
    const isGroup = source === 'group';
    if (isGroup) {
      return {
        category: 'file',
        source: 'group',
        partition: h.targetUid,
        targetUid: h.targetUid,
        targetUin: '0',
        fileName: h.fileName || '',
        msgId: h.msgId.toString(),
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
      msgId: h.msgId.toString(),
      msgSeq: h.msgSeq.toString(),
      sendTime: h.sendTime.toString(),
      convName: identity.name,
    };
  }
}
function rowToRecordHit(
  h: BuddyMsgFtsHit,
  senderUin = '0',
  senderName = '',
  content = h.content,
  original?: {
    elements: RenderElement[];
    setEmojiList?: SetEmojiItem[];
    decoration?: MsgDecoration;
  },
): ConversationRecordHit {
  return {
    msgId: h.msgId.toString(),
    msgSeq: h.msgSeq.toString(),
    senderUid: h.senderUid,
    senderUin,
    senderName,
    sendTime: h.sendTime.toString(),
    content,
    ...(original
      ? {
          elements: original.elements,
          ...(original.setEmojiList ? { setEmojiList: original.setEmojiList } : {}),
          ...(original.decoration ? { decoration: original.decoration } : {}),
        }
      : {}),
  };
}

/**
 * Flatten original-message render elements to display text. Falls back to the
 * FTS text when the body renders empty, or when it renders as only a bare
 * media/forward label (`[合并转发]` / `[卡片消息]` …): QQ's FTS column (41701)
 * carries the expanded forward text / card body there, so it is more complete.
 */
function originalContentText(elements: RenderElement[], ftsText: string): string {
  const text = elementsToText(elements).trim();
  if (!text) return ftsText;
  return isBareLabel(text) && ftsText.trim() ? ftsText : text;
}

/** A bracketed media label like `[图片]` — no readable text beyond the tag. */
function isBareLabel(text: string): boolean {
  return /^\[[^[\]]+\]$/.test(text.trim());
}

/** trigram tokenizer only matches 3+ character substrings. */

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
