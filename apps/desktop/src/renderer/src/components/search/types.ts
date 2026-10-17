/** Wire shapes for the unified sidebar search (mirror @weq/service UnifiedSearchService). */

import type { SearchCategory } from '@weq/service';
export type { SearchCategory } from '@weq/service';
import type { GeneratedSearchHit } from '@weq/service';
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
  | GeneratedSearchHit;

export interface QuickSearchResult {
  conversations: ConversationSearchHit[];
  friends: FriendSearchHit[];
  groupMembers: GroupMemberSearchHit[];
}

export interface SlowSearchResult {
  chatRecords: ChatRecordSearchHit[];
  files: FileSearchHit[];
  cloneMessages: GeneratedSearchHit[];
  assistantMessages: GeneratedSearchHit[];
  /** 本地 trigram 索引状态 — disabled | building | ready */
  indexStatus: 'disabled' | 'building' | 'ready';
}

export interface MoreSearchResult {
  category: SearchCategory;
  items: SearchHit[];
  total: number;
  hasMore: boolean;
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
  cloneMessage: { label: '克隆消息', plural: '克隆消息' },
  assistantMessage: { label: '助手对话', plural: '助手对话' },
};

export const SEARCH_CATEGORY_ORDER: SearchCategory[] = [
  'conversation',
  'friend',
  'groupMember',
  'chatRecord',
  'file',
  'cloneMessage',
  'assistantMessage',
];

export function isSlowSearchCategory(category: SearchCategory): boolean {
  return (
    category === 'chatRecord' ||
    category === 'file' ||
    category === 'cloneMessage' ||
    category === 'assistantMessage'
  );
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
      return `file:${hit.source}:${hit.targetUid}:${hit.fileName}`;
    case 'cloneMessage':
    case 'assistantMessage':
      return JSON.stringify([hit.category, hit.kind, hit.ownerId, hit.sessionId, hit.messageId]);
  }
}
