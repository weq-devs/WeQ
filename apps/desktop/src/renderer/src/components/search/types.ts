/** Wire shapes for the unified sidebar search (mirror @weq/service UnifiedSearchService). */

import type { SearchCategory } from '@weq/service';
import { DEFAULT_SEARCH_CATEGORIES, searchNameRank } from '@weq/service/search-policy';
export { DEFAULT_SEARCH_CATEGORIES } from '@weq/service/search-policy';
export type { SearchCategory } from '@weq/service';
import type { GeneratedSearchHit } from '@weq/service';
import type { CollectionSearchHit } from '@weq/service';
import type { ContentSearchHit, ContentSearchCategory, ContentSearchCoverage } from '@weq/service';
export type { ContentSearchHit, ContentSearchTarget } from '@weq/service';
export type { GeneratedSearchHit } from '@weq/service';
export type SearchFtsSource = 'buddy' | 'group';

export interface ConversationSearchHit {
  category: 'conversation';
  targetUid: string;
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
  memberDisplay: string;
  groupName: string;
}

export interface ChatRecordSearchHit {
  category: 'chatRecord';
  source: SearchFtsSource;
  partition: string;
  targetUid: string;
  targetUin: string;
  name: string;
  count: number;
}

export interface FileSearchHit {
  category: 'file';
  source: SearchFtsSource;
  partition: string;
  targetUid: string;
  targetUin: string;
  fileName: string;
  msgId: string;
  msgSeq: string;
  sendTime: string;
  convName: string;
}

export type SearchHit =
  | ConversationSearchHit
  | FriendSearchHit
  | GroupMemberSearchHit
  | ChatRecordSearchHit
  | FileSearchHit
  | GeneratedSearchHit
  | CollectionSearchHit
  | ContentSearchHit;
export function isContentSearchHit(hit: SearchHit): hit is ContentSearchHit {
  return isContentSearchCategory(hit.category);
}
export function isContentSearchCategory(
  category: SearchCategory,
): category is ContentSearchCategory {
  return CONTENT_CATEGORY_ORDER.some((item) => item === category);
}
export function contentCoverageText(coverage: ContentSearchCoverage): string {
  if (coverage.available === false)
    return coverage.scope === 'offline-catalog' ? '离线目录尚不可用' : '本地来源尚不可用';
  return `${coverage.scope === 'observed-cache' ? '已缓存内容' : coverage.scope === 'offline-catalog' ? '离线目录' : '本地数据库'} · ${coverage.records} 条${coverage.limited ? ' · 缓存有回收或截断' : ''}${coverage.persistenceFailed ? ' · 缓存尚未保存' : ''}`;
}

export function isGeneratedSearchHit(hit: SearchHit): hit is GeneratedSearchHit {
  return hit.category === 'cloneMessage' || hit.category === 'assistantMessage';
}

export interface QuickSearchResult {
  conversations: ConversationSearchHit[];
  friends: FriendSearchHit[];
  groupMembers: GroupMemberSearchHit[];
}

export interface SlowSearchResult {
  contentHits?: ContentSearchHit[];
  contentCoverage?: Partial<Record<ContentSearchCategory, ContentSearchCoverage>>;
  collections: CollectionSearchHit[];
  failedCategories?: SearchCategory[];
  chatRecords: ChatRecordSearchHit[];
  files: FileSearchHit[];
  cloneMessages: GeneratedSearchHit[];
  assistantMessages: GeneratedSearchHit[];
  /** 本地 trigram 索引状态 — disabled | building | ready */
  indexStatus: 'disabled' | 'building' | 'ready';
}

export interface MoreSearchResult {
  coverage?: ContentSearchCoverage;
  category: SearchCategory;
  items: SearchHit[];
  total: number;
  hasMore: boolean;
  limited?: boolean;
}

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
   * 展示文本：原消息元素压平后的文本；找不到原消息行时是 FTS 纯文本。
   */
  content: string;
  /**
   * 原消息渲染视图元素（能找到原 40800 正文时才有），有它前端就渲染真实气泡。
   */
  elements?: unknown[];
  /** 群消息贴表情（列 40062）。 */
  setEmojiList?: unknown[];
  /** 单条消息装扮（列 40801）。 */
  decoration?: unknown;
}

/** Category display metadata. */
export const CATEGORY_META: Record<SearchCategory, { label: string; plural: string }> = {
  conversation: { label: '会话', plural: '会话' },
  friend: { label: '好友', plural: '好友' },
  groupMember: { label: '群友', plural: '群友' },
  chatRecord: { label: '聊天记录', plural: '聊天记录' },
  file: { label: '文件', plural: '文件' },
  collection: { label: '收藏', plural: '收藏' },
  cloneMessage: { label: '克隆消息', plural: '克隆消息' },
  assistantMessage: { label: '助手对话', plural: '助手对话' },
  qzonePost: { label: '个人空间说说', plural: '个人空间说说' },
  qzoneAlbum: { label: '个人空间相册', plural: '个人空间相册' },
  otherQzonePost: { label: '他人空间说说', plural: '他人空间说说' },
  otherQzoneAlbum: { label: '他人空间相册', plural: '他人空间相册' },
  groupAlbum: { label: '群相册', plural: '群相册' },
  groupFile: { label: '群文件', plural: '群文件' },
  mailMessage: { label: '邮件', plural: '邮件' },
  marketEmoji: { label: '商城表情', plural: '商城表情' },
  guildMessage: { label: '频道私聊', plural: '频道私聊' },
};

export const CONTENT_CATEGORY_ORDER: ContentSearchCategory[] = [
  'qzonePost',
  'qzoneAlbum',
  'otherQzonePost',
  'otherQzoneAlbum',
  'groupAlbum',
  'groupFile',
  'mailMessage',
  'marketEmoji',
  'guildMessage',
];

export const SEARCH_CATEGORY_ORDER: SearchCategory[] = [
  ...DEFAULT_SEARCH_CATEGORIES,
  'cloneMessage',
  'assistantMessage',
  'marketEmoji',
];

export function searchHitNameRank(hit: SearchHit, keyword: string): number {
  switch (hit.category) {
    case 'conversation':
    case 'chatRecord':
      return searchNameRank(keyword, hit.name);
    case 'friend':
      return searchNameRank(keyword, hit.remark, hit.nick, hit.uin);
    case 'groupMember':
      return searchNameRank(keyword, hit.memberDisplay, hit.memberUin);
    case 'file':
      return searchNameRank(keyword, hit.fileName);
    case 'collection':
      return searchNameRank(keyword, hit.title);
    default:
      return searchNameRank(keyword, hit.title);
  }
}

export function isSlowSearchCategory(category: SearchCategory): boolean {
  return !['conversation', 'friend', 'groupMember'].includes(category);
}

export function searchHitKey(hit: SearchHit): string {
  switch (hit.category) {
    case 'conversation':
      return `conversation:${hit.targetUid}`;
    case 'friend':
      return `friend:${hit.uid}`;
    case 'groupMember':
      return `groupMember:${hit.groupCode}:${hit.memberUid}`;
    case 'chatRecord':
      return `chatRecord:${hit.source}:${hit.partition}`;
    case 'file':
      return `file:${hit.source}:${hit.targetUid}:${hit.msgId}`;
    case 'collection':
      return `collection:${hit.cid}`;
    case 'cloneMessage':
    case 'assistantMessage':
      return JSON.stringify([hit.category, hit.kind, hit.ownerId, hit.sessionId, hit.messageId]);
    case 'qzonePost':
    case 'qzoneAlbum':
    case 'otherQzonePost':
    case 'otherQzoneAlbum':
    case 'groupAlbum':
    case 'groupFile':
    case 'mailMessage':
    case 'marketEmoji':
    case 'guildMessage':
      return hit.id;
  }
}
