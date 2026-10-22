// @ts-nocheck
import {
  useContentMultiSelect,
  useRequestContentExport,
  useRequestContentAnalysis,
} from '../../state/contentSelection';
import {
  conversationExportSelection,
  conversationAnalysisTarget,
} from '../../lib/conversationActions';
import { ConversationActionsMenu } from '../../components/ConversationActionsMenu';
import { useMediaSave } from '../../components/MediaSaveControls';
import { useMessageMarquee } from '../../hooks/useMessageMarquee';
import '../../styles/message-selection-toolbar.css';
import '../../styles/conversation-title.css';
import { GroupProfileDialog } from './profilePanes';
import { ConversationMessageActions } from '../../components/ConversationMessageActions';
import { QQMessageEssenceAction } from '../../components/QQMessageEssenceAction';
import { MessageTodoAction, TypingStatus } from '../../components/qq-actions/ChatActions';
import { ConversationDirectoryContext } from '../../lib/conversationDirectory';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { useMessageSelectionFlow } from '../../hooks/useMessageSelectionFlow';
import { selectionGapId, parseSelectionGap, type SelectionGap } from '../../lib/messageSelection';
import { createSelectionGapIndex } from '../../lib/selectionGapIndex';
import { hasActiveModal } from '../../lib/overlayStack';
import { useWorkspaceSidecarOpen } from '../../components/WorkspacePages';
import { useAtAllMention } from '../../hooks/useAtAllMention';
import { nextMentionIndex, type AtAllMentionState } from '../../lib/atAllMention';
import '../../styles/at-all-mention.css';
import {
  AudioLines,
  BarChart3,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUp,
  CirclePlus,
  Download,
  Eye,
  Search,
  Trash2,
  RotateCcw,
  ListPlus,
  FileText,
  FolderOpen,
  UsersRound,
  Bug,
  Hand,
  Image as ImageIcon,
  Link2,
  ClipboardCopy,
  MessageSquareText,
  Mic,
  Rocket,
  SendHorizontal,
  Settings2,
  Zap,
  Share2,
  Forward,
  Copy,
  Loader2,
  Smile,
  Sparkles,
  Vibrate,
  X,
} from 'lucide-react';
import { AiOutlineRedEnvelope } from 'react-icons/ai';
import { resourceUrl } from '../../lib/resourceUrl';
import { isSelfIdentity, selfIdentityValues } from '../../lib/selfIdentity';
import { groupMemberEditing } from '../../lib/groupMemberEditing';
import { canDiscardFailedMessage, isUnpositionedFailure } from '../../lib/localOutgoing';
import {
  messageBatchBlockReason,
  partitionMessageBatch,
  type MessageBatchAction,
} from '../../lib/messageBatchAction';
import { MessageBatchActionDialog } from '../../components/MessageBatchActionDialog';
import { confirmMessageDeletion } from '../../components/confirmMessageDeletion';
import { deletionIdentity, hiddenDeletionLookup } from '../../lib/messageDeletion';
import { useThemeStore } from '../../state/theme';
import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ReplyJumpContext } from '../../components/QqMessageContent';
import { openLightbox } from '../../components/ImageLightbox';
import '../../styles/composer-image-preview.css';
import { ChatBackdrop } from '../../components/ChatBackdrop';
import { useChatBackdrop } from '../../hooks/useDressSkin';
import type { GroupMemberSearchView } from '../../hooks/useGroupMemberSearch';
import type {
  ChangeEvent as ReactChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
} from 'react';
import { loadLayoutNumber, saveLayoutNumber } from './layoutStorage';
import {
  attachmentToken,
  clipboardFiles,
  createAttachment,
  createAttachments,
  createMediaId,
  dataTransferHasFiles,
  formatFileSize,
  isImageFile,
  MAX_ATTACHMENT_BYTES,
  MAX_COMPOSER_ATTACHMENTS,
  releaseAttachment,
  voiceClipToken,
  type ComposerAttachment,
  type VoiceClip,
} from './composerMedia';
import {
  ComposerDropVeil,
  ComposerMediaStage,
  ComposerSuperEmojiStage,
  collectFiles,
} from './composerMediaStage';
import { VoicePanel, type TtsSpeechResult } from './voicePanel';
import { FlashComposer, type FlashSendPayload } from './flashComposer';
import {
  ComposerQuoteBar,
  composerQuoteToken,
  quoteBlockReason,
  quoteFromMessage,
  type ComposerQuote,
} from './composerQuote';
import { ArkPanel } from './arkPanel';
import type { ArkContactSource, ArkLocationProvider, ArkPayload } from './arkCards';
import { AiVoicePanel, aiVoiceToken, type AiVoiceDraft } from './aiVoicePanel';
import { BounceEmojiPanel, bounceEmojiToken, type BounceEmojiDraft } from './bounceEmojiPanel';
import { RedPacketPanel, type RedPacketDraft } from './redPacketPanel';
import {
  PokeEmojiPanel,
  pokeEmojiToken,
  randomFaceToken,
  type PokeEmojiDraft,
  type RandomFaceDraft,
} from './pokeEmojiPanel';
import { copyTextToClipboard } from './clipboard';
import {
  isLocalOutgoingMessage,
  outgoingActionBlockReason,
  selectedMessagesText,
} from '../../lib/messageSelection';
import { cn } from './classNames';
import { PROJECT_GROUP_IDS } from '../../../../shared/project_groups';
import { chatHeaderTitle, isBotConversation, resolveMessageSender } from './conversationDisplay';
import { createEmojiToken, parseMessageParts } from './emojiPacks';
import type { EmojiItem } from './emojiPacks';
import { elementToToken, elementsToComposerText } from './draftElements';
import { planNeedsLocalMedia, type LocalMediaRef } from './composerSend';
import { prepareReeditDraft } from './composerReedit';
import {
  ComposerResizeHandle,
  focusComposerEnd,
  getActiveComposerMentionTrigger,
  insertComposerNode,
  isNodeInside,
  replaceComposerTextRange,
  restoreComposer,
  serializeComposer,
} from './composer';
import {
  isComposerActionDisabled,
  resolveComposerActionRegistry,
  type ComposerActionContext,
  type ComposerActionRegistry,
  type ComposerButtonAction,
} from './composerActions';
import { GroupInfoPanel, type GroupInfoDetail } from './conversationDetails';
import { EmojiPanel } from './emojiPanel';
import { useTabActive } from '../../components/RetainedTabs';
import { loadHiddenMessageIds, saveHiddenMessageIds } from './hiddenMessages';
import { MessageRow, grayTipOf, messageElements } from './messageRow';
import { IntentSenseProvider } from '../../components/intentSense/context';
import { intentTimelineTargets } from '../../lib/intentTimeline';
import { AffinityPill } from '../../components/intentSense/AffinityPill';
import { IntentSuggestionBar } from '../../components/intentSense/IntentSuggestionBar';
import { useDialog } from '../../components/Dialog';
import { MessageContextMenu } from './messageContextMenu';
import { AvatarContextMenu, type AvatarContextMenuState } from './avatarContextMenu';
import { ReactionPicker } from './reactionPicker';
import type { MessageContextMenuState } from './messageContextMenu';
import type { MessageRenderer } from './messageRenderers';
import { filterMentionMembers, mentionText } from './mentions';
import { canRepeatMessage, repeatTarget } from '../../lib/messageRepeat';
import { mediaUrl } from '../../lib/resourceUrl';
import { exportMedia } from '../../lib/mediaExport';
import {
  messageContentClipboard,
  messageNodeClipboard,
  messageRichClipboard,
  selectedMessageClipboard,
} from '../../lib/messageClipboard';
import type { RepeatElement } from '../../lib/messageRepeat';
import { readMentionClipboard, writeMentionClipboard } from '../../lib/mentionClipboard';
import '../../styles/message-repeat.css';
import '../../styles/new-message-preview.css';
import { MessageTimeDivider, shouldShowMessageTime } from './messageTime';
import { MessageGapDivider, isSeqBetween, messageGapCount } from './messageGap';
import { defaultConversationPreference } from './preferences';
import { Avatar, ChatMessagesSkeleton, EmptyState } from './primitives';
import type {
  Conversation,
  ConversationPreference,
  GroupMember,
  GroupMemberRole,
  Message,
  MessageAction,
  UnreadDock,
  User,
} from './types';
import { dockStopLabel, dockStopTone } from './unreadDock';
import { displayUserName } from './user';
import { OnlineStatus } from '../../components/OnlineStatus';
import { MessageDecorationCard } from '../../components/MessageDecorationCard';
import { trpc } from '../../trpc/client';
import { useToast } from '../../components/Toast';

const composerHeightStorageKey = 'chat-template.layout.composerHeight';
const groupInfoCollapsedStorageKey = 'chat-template.layout.groupInfoCollapsed';
const composerCollapsedStorageKey = 'chat-template.layout.composerCollapsed';
/**
 * 输入区高度（桌面端可拖拽）。默认值按「语音条内联时也不用变高度」定：
 *
 *   composerHeight - 内边距 28 - 工具行 42 >= 语音面板（声纹舞台 126 + 脚注 ≈ 26）
 *
 * 语音条已经去掉外框和头部那一栏，整块只要 152px；算下来 222 就够，取 224 做下限，
 * 这样点语音键不会再让输入区越长越高、把聊天区顶上去。比这个矮的存量拖拽值会被
 * 自动夹上来。（配了 TTS 时头部会多出页签那一行，那种情况下语音面板内部自己滚动。）
 */
const composerHeightDefault = 230;
const composerHeightMin = 224;
const composerHeightMax = 430;

/**
 * 移动布局下输入框最多长到几行 —— 超过就内部滚动，并露出「展开」按钮（见
 * `scheduleMobileComposerMeasure` / responsive.css 的 `.mobile-composer-long`）。
 * 桌面端走的是上面那套可拖拽的 `composerHeight`，与这里无关；但测量函数两种布局都会
 * 跑到，常量必须在。
 */
const mobileComposerMaxLines = 4;

type MentionMenuState = {
  query: string;
  activeIndex: number;
  members: GroupMember[];
};

type UnreadJumpState = {
  conversationId: string;
  remaining: number;
  startScrollTop?: number;
  targetScrollTop?: number;
  total: number;
};

type UnreadJumpSeed = {
  conversationId: string;
  total: number;
};

function loadGroupInfoCollapsed() {
  return localStorage.getItem(groupInfoCollapsedStorageKey) === '1';
}

function saveGroupInfoCollapsed(value: boolean) {
  localStorage.setItem(groupInfoCollapsedStorageKey, value ? '1' : '0');
}

function loadComposerCollapsed() {
  return localStorage.getItem(composerCollapsedStorageKey) === '1';
}

function saveComposerCollapsed(value: boolean) {
  localStorage.setItem(composerCollapsedStorageKey, value ? '1' : '0');
}

function _hasGroupAnnouncements(conversation: Conversation) {
  return (
    conversation.type === 'group' &&
    (Boolean(conversation.group.announcement?.trim()) ||
      Boolean(conversation.group.bulletins?.length))
  );
}

function getMessageDownloadUrl(message: Message) {
  const picture = message.qqElements?.find((element) => element.type === 'pic');
  if (picture) {
    const data = picture.data ?? {};
    return mediaUrl('pic', {
      t: Date.parse(message.createdAt),
      name: String(data.fileName ?? ''),
      token: String(data.fileToken ?? ''),
      orig: String(data.originalUrl ?? ''),
      md5: String(data.md5 ?? ''),
      recv: data.subType === 1 ? 1 : 0,
    });
  }
  const markdownImage = message.body.match(/!\[[^\]\n]*\]\((https?:\/\/[^\s)]+)\)/i)?.[1];
  if (markdownImage) {
    return markdownImage;
  }

  for (const part of parseMessageParts(message.body)) {
    if (part.type === 'emoji' && part.item.large && part.item.src) {
      return part.item.src;
    }
  }

  return undefined;
}

function imageFilenameFromUrl(url: string) {
  try {
    const { pathname } = new URL(url);
    const filename = pathname.split('/').filter(Boolean).pop();
    return filename || 'chat-image';
  } catch {
    return 'chat-image';
  }
}

function pureImageUrl(message: Message) {
  const elements = (message.qqElements ?? []).filter(
    (element) => !(element.type === 'text' && !String(element.data?.textContent ?? '').trim()),
  );
  return elements.length === 1 && elements[0].type === 'pic'
    ? getMessageDownloadUrl(message)
    : undefined;
}

function formatUnreadJumpCount(value: number) {
  return value > 99 ? '99+' : String(value);
}

/**
 * How many messages were appended at the tail since `lastId`. Falls back to
 * "1" when the previous tail can't be located (e.g. it scrolled out of the
 * loaded window) so the pill still nudges the user.
 */
function countAppendedMessages(lastId: string | null, messages: Message[]) {
  if (!lastId) {
    return messages.length > 0 ? 1 : 0;
  }
  const index = messages.findIndex((message) => message.id === lastId);
  if (index === -1) {
    return 1;
  }
  return messages.length - 1 - index;
}

function isMobileComposerViewport() {
  return window.matchMedia('(max-width: 760px)').matches;
}

/**
 * 键盘抬起后还需要重扫一次 @ 触发词的按键。
 *
 * 会改内容的按键（字母 / 数字 / 退格 / 回车……）已经由 `onInput` 里的
 * `syncComposerBody` 扫过了，再扫一遍等于每个字符做两轮「光标前内容序列化 +
 * 全群成员匹配 + 可能的远端搜索」。只有**不动内容、只挪光标**的按键需要在这里补：
 * 否则光标从 `@abc` 后面移开时，mention 菜单会停在原位。
 */
const MENTION_RESCAN_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** 禁言时长（秒）→ 中文档位名，用于 toast 回显。 */
const MUTE_DURATION_LABELS: Record<number, string> = {
  [10 * 60]: '10 分钟',
  [60 * 60]: '1 小时',
  [12 * 60 * 60]: '12 小时',
  [24 * 60 * 60]: '1 天',
};

function formatMuteDuration(seconds: number): string {
  return MUTE_DURATION_LABELS[seconds] ?? `${Math.round(seconds / 60)} 分钟`;
}

export function ChatPane({
  user,
  conversation,
  messages,
  composerActions,
  messageRenderers,
  loading,
  atLatest = true,
  latestMessageSeq,
  onPreviewLatest,
  onJumpToLatest,
  onReadCurrentConversation,
  preference,
  onLoadMoreGroupMembers,
  groupMembersLoading,
  groupMembersError,
  groupMemberSearch,
  onGroupMemberSearchChange,
  onLoadMoreGroupMemberSearch,
  profileLoading,
  sendAvailable = true,
  onSend,
  onRepeatMessage,
  onResolveMentions,
  onSearchMentionMembers,
  onSendWindowShake,
  onSendArk,
  onSendFlash,
  onSendRedPacket,
  arkLocation,
  arkContacts,
  defaultSignupGroupCode,
  onMessageAction,
  draft,
  onDraftChange,
  onDraftClear,
  onBack,
  onEditRaw,
  onDeleteMessage,
  onOpenGroupAlbums,
  onOpenGroupFiles,
  onOpenGroupAnnouncements,
  groupTodos,
  onOpenGroupSign,
  onOpenGroupEssence,
  onOpenGroupInfoDetail,
  onRenameGroupMember,
  onChangeGroupMemberTitle,
  onKickGroupMember,
  onOpenConversationSettings,
  onOpenGroupBug,
  onOpenGroupLeftMembers,
  groupBugOnline,
  onOpenGroupMember,
  onAddMessage,
  onViewDeleted,
  onViewRecalled,
  onOpenGapMessages,
  onLoadSelectionMessages,
  onSearchChatRecords,
  onOpenRoamingBackfill,
  deletedIds,
  hiddenDeletedIds,
  onRestoreMessage,
  onMergeForward,
  onAddToComposition,
  onForwardMessages,
  unreadDock,
  missingJumpSeq,
}: {
  user: User;
  conversation: Conversation | undefined;
  messages: Message[];
  composerActions?: Partial<ComposerActionRegistry>;
  messageRenderers?: MessageRenderer[];
  loading: boolean;
  /** 是否为最新窗口；历史分页不触发新消息提示，分离窗口改由实时会话水位驱动。 */
  atLatest?: boolean;
  latestMessageSeq?: string;
  onPreviewLatest?: (conversation: Conversation) => void;
  onJumpToLatest?: () => Promise<boolean>;
  onReadCurrentConversation?: (conversation: Conversation) => void;
  preference: ConversationPreference | undefined;
  onLoadMoreGroupMembers?: () => void;
  groupMembersLoading?: boolean;
  groupMembersError?: string | null;
  /** 群资料面板的群内成员搜索（服务端搜全群）—— 关键字、命中成员与分页状态。 */
  groupMemberSearch?: GroupMemberSearchView | null;
  /** 群内成员搜索关键字变化（受控输入）。 */
  onGroupMemberSearchChange?: (keyword: string) => void;
  /** 追加下一页搜索命中。 */
  onLoadMoreGroupMemberSearch?: () => void;
  /** 群详情（群资料）拉取中，群资料区显示 skeleton。 */
  profileLoading?: boolean;
  /** 当前账号是否有可用于发消息的、在线且允许注入的 QQ 实例。 */
  sendAvailable?: boolean;
  /**
   * 发一条消息。`body` 是输入框序列化正文（含各类 token）；`locals` 是正文里那些
   * 图片 / 视频 / 语音 / 文件的**本地句柄**（路径优先 / 字节兜底），应用层据此补上
   * 媒体本体再走 IPC。
   */
  onSend: (body: string, locals?: LocalMediaRef[]) => Promise<void>;
  onRepeatMessage?: (message: Message, conversation: Conversation) => Promise<void>;
  onResolveMentions?: (
    elements: RepeatElement[],
    conversation: Conversation,
  ) => Promise<RepeatElement[]>;
  onSearchMentionMembers?: (query: string, conversation: Conversation) => Promise<GroupMember[]>;
  /**
   * 私聊「窗口抖动」（只做私聊）—— 点一下发一条独立消息，不动输入框里的正文 / 草稿。
   * 群聊没有这个能力，所以按钮只在 `conversation.type === 'direct'` 时渲染。
   */
  onSendWindowShake?: (conversation: Extract<Conversation, { type: 'direct' }>) => Promise<void>;
  /**
   * Ark 卡片面板「发送」—— 面板只收输入、不知道发到哪，所以把**当前会话**一起交回
   * 应用层，由它补 peerType / targetId 再走 IPC（与 onSendWindowShake 同）。
   * 抛出即失败：面板会显示原因并保留已填内容。
   */
  onSendArk?: (conversation: Conversation, payload: ArkPayload) => Promise<void>;
  /**
   * 闪传文件框「发送」—— 面板收齐文件 + 封面后交回应用层，由它补 peerType / targetId
   * 再走 IPC（与 onSendArk 同）。抛出即失败：面板保留已选文件并显示原因。
   */
  onSendFlash?: (conversation: Conversation, payload: FlashSendPayload) => Promise<void>;
  /**
   * 红包面板「发红包」—— 面板只收「类型 / 金额 / 个数 / 祝福语（口令）」，发送目标
   * （私聊对方 / 群号）由应用层补，所以把**当前会话**一起交回（与 onSendArk 同）。
   * 抛出即失败：面板会显示原因并保留已填内容。
   */
  onSendRedPacket?: (conversation: Conversation, draft: RedPacketDraft) => Promise<void>;
  /** 位置卡片要用的地点搜索 / 逆地址解析（应用层注入；不传就只有地图 + 手填）。 */
  arkLocation?: ArkLocationProvider;
  /** 推荐好友 / 群 的候选列表（应用层注入；不传就只能手填号码）。 */
  arkContacts?: ArkContactSource;
  /** 「报名」那栏的默认目标群号（在群聊里打开时预填当前群号）。 */
  defaultSignupGroupCode?: string;
  onMessageAction?: (message: Message, action: MessageAction) => Promise<void>;
  draft: string;
  onDraftChange: (conversationId: string, value: string) => void;
  onDraftClear: (conversationId: string) => void;
  onBack: () => void;
  onEditRaw?: (message: Message) => void;
  onDeleteMessage?: (
    message: Message,
    conversation: Conversation,
    hidden?: boolean,
  ) => void | Promise<void>;
  onOpenGroupAlbums?: (conversation: Extract<Conversation, { type: 'group' }>) => void;
  onOpenGroupFiles?: (conversation: Extract<Conversation, { type: 'group' }>) => void;
  onOpenGroupAnnouncements?: (conversation: Extract<Conversation, { type: 'group' }>) => void;
  groupTodos?: React.ReactNode;
  onOpenGroupSign?: (conversation: Extract<Conversation, { type: 'group' }>) => void;
  onOpenGroupEssence?: (conversation: Extract<Conversation, { type: 'group' }>) => void;
  /** 群资料面板「群资料」入口：卡片本体搬到了应用层（components/GroupInfoDetailDialog）。 */
  onOpenGroupInfoDetail?: (
    conversation: Extract<Conversation, { type: 'group' }>,
    detail: GroupInfoDetail,
  ) => void;
  /** 群管理「修改群昵称」：应用层开弹窗（与群公告 / 群精华同层）。 */
  onRenameGroupMember?: (
    conversation: Extract<Conversation, { type: 'group' }>,
    sender: User,
    targetUid: string,
  ) => void;
  /** 群主编辑成员头衔，应用层复用现有编辑器。 */
  onChangeGroupMemberTitle?: (
    conversation: Extract<Conversation, { type: 'group' }>,
    sender: User,
    targetUid: string,
  ) => void;
  /** 群管理「踢出群聊」：应用层开二次确认。 */
  onKickGroupMember?: (
    conversation: Extract<Conversation, { type: 'group' }>,
    sender: User,
    targetUid: string,
  ) => void;
  /** 顶栏设置按钮：群聊 / 私聊各自的会话设置（防撤回 + 群提醒词）。 */
  onOpenConversationSettings?: (
    conversation: Extract<Conversation, { type: 'group' | 'direct' }>,
    anchor?: HTMLElement,
  ) => void;
  onOpenGroupBug?: (conversation: Extract<Conversation, { type: 'group' }>) => void;
  /**
   * 群资料面板「已退群」入口：把信号交给应用层，由它拉本地 group_member3 并弹出灯箱
   * （与群公告 / 群精华同层，见 components/GroupLeftMembersDialog）。不传则入口不渲染。
   */
  onOpenGroupLeftMembers?: (conversation: Extract<Conversation, { type: 'group' }>) => void;
  /** QQ 在线状态 —— 决定「反馈 bug」图标亮/灰。 */
  groupBugOnline?: boolean;
  onOpenGroupMember?: (member: User, anchor: { x: number; y: number }) => void;
  onAddMessage?: (conversation: Conversation) => void;
  onViewDeleted?: (conversation: Conversation) => void;
  onViewRecalled?: (conversation: Conversation) => void;
  /** 顶栏「搜索聊天记录」按钮：在当前会话内搜索并跳转。 */
  onSearchChatRecords?: (conversation: Conversation) => void;
  onOpenRoamingBackfill?: (conversation: Conversation) => void;
  /** 缺失消息占位条点击：携带占位条两侧消息的 seq（开区间即缺失窗口）。 */
  onOpenGapMessages?: (gap: {
    conversation: Conversation;
    previousSeq: string;
    currentSeq: string;
    count: number;
  }) => void | Promise<void>;
  onLoadSelectionMessages?: import('../../lib/messageSelection').LoadSelectionMessages;
  /** msgIds WeQ deleted in this conversation — rendered in place under a translucent overlay. */
  deletedIds?: Set<string>;
  hiddenDeletedIds?: Set<string>;
  /** Restore one WeQ-deleted message (the overlay's hover button). */
  onRestoreMessage?: (msgId: string) => Promise<void>;
  /** 多选「合并转发」：把选中的消息交给应用层开合并转发灯箱。 */
  onMergeForward?: (messages: Message[], conversation: Conversation) => void;
  onAddToComposition?: (messages: Message[]) => void;
  onForwardMessages?: (messages: Message[], conversation: Conversation) => void;
  /**
   * 打开会话时从 msg_unread_info_table 读进内存的未读/高亮快照。上层在「读一次
   * 未读 → 标记已读」之后交下来，本组件据此在右上角逐个引导跳转。
   */
  unreadDock?: UnreadDock | null;
  /**
   * 最近一次跳转落空的目标 seq（被撤回 / 删除 / 未同步）。非 null 时，若它恰好
   * 落在相邻两行之间的「单条缺口」上（seq 差为 1，默认缺口条不渲染），就在那里
   * 补一条可点击拉取的缺口条。
   */
  missingJumpSeq?: string | null;
}) {
  // 空态占位图按深浅色切换(im_1.png / im_2.jpg),订阅主题以即时跟随。
  const theme = useThemeStore((s) => s.resolved);
  const mediaSave = useMediaSave();
  // 复用 replyJump 的跳转能力（含翻页/重建窗口），供群精华消息跳转使用。
  const jumpToSeq = useContext(ReplyJumpContext);
  const backdrop = useChatBackdrop();
  const tabActive = useTabActive();
  const directory = useContext(ConversationDirectoryContext);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const composerSendRef = useRef<{ conversationId: string } | null>(null);
  const composerTabActive = useRef(tabActive);
  composerTabActive.current = tabActive;
  const [repeating, setRepeating] = useState(false);
  const repeatBusy = useRef(false);
  const mentionConversation = useRef(conversation?.id);
  mentionConversation.current = conversation?.id;
  const mentionRequest = useRef(0);
  useEffect(() => {
    setMentionMenu((current) =>
      current && !current.query
        ? { ...current, members: filterMentionMembers(conversation, '', user.id) }
        : current,
    );
  }, [conversation, user.id]);
  const [composerHeight, setComposerHeight] = useState(() =>
    loadLayoutNumber(
      composerHeightStorageKey,
      composerHeightDefault,
      composerHeightMin,
      composerHeightMax,
    ),
  );
  const [groupInfoCollapsed, setGroupInfoCollapsed] = useState(loadGroupInfoCollapsed);
  const [mobileGroupInfoOpen, setMobileGroupInfoOpen] = useState(false);
  useEffect(() => setMobileGroupInfoOpen(false), [conversation?.id, tabActive]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => {
      if (!query.matches) setMobileGroupInfoOpen(false);
    };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const sidecarOpen = useWorkspaceSidecarOpen();
  // 桌面端可把整条输入区收起来（只留底边一个把手），和群资料栏同一套交互。
  const [composerCollapsed, setComposerCollapsed] = useState(loadComposerCollapsed);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  // 「链接卡片」面板：填标题 / 描述 / 图标 / 跳转链接，summary 固定 [分享]。
  const [arkOpen, setArkOpen] = useState(false);
  // 「AI 声聊」面板：输入文字 + 选声线 + 试听，合成后**单独发送**（仅群聊）。
  const [aiVoiceOpen, setAiVoiceOpen] = useState(false);
  // 「弹射表情」面板：选一枚系统表情 + 填个数，发射后**单独发送**。
  const [bounceOpen, setBounceOpen] = useState(false);
  // 「戳一戳」面板：选互动表情 + 连击次数，戳出去**单独发送**。
  const [pokeOpen, setPokeOpen] = useState(false);
  // 「闪传」文件框：拖文件 / 选文件夹 → 灯箱确认封面 → 走 fileset 发送。
  // 它内联占掉输入框正文那一行（需求就是「输入框变成文件框」），所以与其余面板互斥。
  const [flashOpen, setFlashOpen] = useState(false);
  // 「红包」面板：群聊三档（普通 / 拼手气 / 口令），私聊两档（普通 / 拼手气）；
  // 下单出码后由应用层弹二维码灯箱。
  const [redPacketOpen, setRedPacketOpen] = useState(false);

  // 闪传文件框占着输入框正文那一行：别的面板一打开就把它收起来，避免两套东西打架。
  useEffect(() => {
    if (
      emojiOpen ||
      toolsOpen ||
      voiceOpen ||
      arkOpen ||
      aiVoiceOpen ||
      bounceOpen ||
      pokeOpen ||
      redPacketOpen
    ) {
      setFlashOpen(false);
    }
  }, [emojiOpen, toolsOpen, voiceOpen, arkOpen, aiVoiceOpen, bounceOpen, pokeOpen, redPacketOpen]);
  // 图片内联进输入框（见 insertInlineImage），所以待发送的「卡片」只有视频 / 文件
  // 和超级表情，而且一次只挂一个 —— 它们只能单独发，发送键不带走输入框里的文字。
  // 两者共用同一个槽位：挂上新的就把旧的卸掉。
  const [mediaAttachment, setMediaAttachment] = useState<ComposerAttachment | null>(null);
  const [pendingSuperEmoji, setPendingSuperEmoji] = useState<EmojiItem | null>(null);
  // 右键「引用」挂上的待发送引用：显示在输入框上方，与「只能单独发」的卡片互斥。
  const [pendingQuote, setPendingQuote] = useState<ComposerQuote | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const emojiUtils = trpc.useUtils();
  const recordRecentEmoji = trpc.account.emojiPanel.recordRecent.useMutation({
    // 写入成功后刷新整份 overview 缓存。这里必须带 `refetchType: 'all'`：选完表情
    // 面板会立刻关闭，`EmojiPanel` 卸载后 overview 的 observer 退订、query 变成
    // inactive，而 invalidate 默认只重取 active 的 query —— inactive 的只会被标记成
    // stale 却不真正重取；又因为全局 `refetchOnMount: false`，下次打开面板也不会补
    // 一次，于是「最近使用」还是旧顺序（刚点的表情排不到第一）。带 all 就在写入后
    // 直接把缓存刷成新数据，下一次打开读到的就是对的。
    onSuccess: () =>
      emojiUtils.account.emojiPanel.overview.invalidate(undefined, { refetchType: 'all' }),
  });
  // 轻互动：戳一戳（0xED3_1）与群消息贴表情（0x9082）。都需要在线且已注入的 QQ。
  const sendPoke = trpc.account.sendPoke.useMutation();
  const setMessageReaction = trpc.account.setMessageReaction.useMutation();
  const reactionRequestPending = useRef(false);
  const [pendingActions, setPendingActions] = useState<Record<string, string>>({});
  const actionContext = useRef(conversation?.id);
  actionContext.current = conversation?.id;
  useEffect(() => setPendingActions({}), [conversation?.id]);
  function beginInlineAction(id: string, label: string) {
    const context = conversation?.id;
    setPendingActions((current) => ({ ...current, [id]: label }));
    return () => {
      if (actionContext.current === context)
        setPendingActions((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
    };
  }
  // 会话治理：撤回 + 群管理（改群名片 / 踢人 / 禁言 / 设撤管理员）。同戳一戳一样需要
  // 在线且已注入的 QQ；一律不做乐观渲染，成功与否只看 toast。
  const recallMessage = trpc.account.recallMessage.useMutation();
  const muteGroupMember = trpc.account.muteGroupMember.useMutation();
  const setGroupAdmin = trpc.account.setGroupAdmin.useMutation();
  // 「随机表情」（骰子 / 包剪锤 / 活动表情）目录：打开戳一戳面板时才拉 —— 来源是
  // 本机资源目录，不内置 faceId 白名单。结果片段变了（QQ 更新）刷新即得。
  const randomFacesQuery = trpc.account.sysEmoji.randomFaces.useQuery(undefined, {
    enabled: pokeOpen,
    staleTime: 5 * 60_000,
  });
  // 口令候选池：只在红包面板打开、且 QQ 在线时拉一次。
  const redbagPasswordsQuery = trpc.account.redbagPasswords.useQuery(undefined, {
    enabled: redPacketOpen && sendAvailable,
    staleTime: 5 * 60_000,
  });
  const pushToast = useToast((state) => state.push);
  // 语音 / TTS 能力由「设置 → 语音配置」决定：没配转录模型就没有转文字，没配 TTS
  // 服务商就没有文字转语音那一栏。
  const mediaSettings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const ttsProviders = mediaSettings.data?.voiceTranscribe?.ttsProviders ?? [];
  const transcribeEnabled = Boolean(mediaSettings.data?.voiceTranscribe?.modelId);
  const synthesizeSpeechMutation = trpc.bootstrap.synthesizeSpeech.useMutation();

  /**
   * 输入框「文字转语音」：把文字交给**设置里配好的 TTS 服务商**合成，返回 base64 音频。
   *
   * 之前那一版用本机 `speechSynthesis` 只能出声、拿不到字节，所以「合成并发送」发出去的
   * 是一条空语音 —— 现在合成真的发生在服务商那侧，字节回到渲染层当普通音频发送。
   */
  async function synthesizeSpeech(request: {
    text: string;
    providerId?: string;
    voice?: string;
  }): Promise<TtsSpeechResult> {
    const result = await synthesizeSpeechMutation.mutateAsync(request);
    return {
      providerName: result.providerName,
      format: result.format,
      audioBase64: result.audioBase64,
    };
  }
  const [contextMenu, setContextMenu] = useState<MessageContextMenuState | null>(null);
  // 右键头像 → 「@他 / 戳一戳」轻互动菜单。
  const [avatarMenu, setAvatarMenu] = useState<AvatarContextMenuState | null>(null);
  // 右键消息 → 「贴表情」打开的表情面板（仅群聊可用）。
  const [reactionPicker, setReactionPicker] = useState<{
    message: Message;
    x: number;
    y: number;
  } | null>(null);
  // 多选：右键进入，输入框让位给批量操作；选择数不设上限。
  const selection = useContentMultiSelect({
    kind: 'messages',
    container: `${conversation?.type ?? 'none'}:${conversation?.id ?? ''}`,
  });
  const {
    selectionMode,
    setSelectionMode,
    selectedIds,
    setSelectedIds,
    anchorRef: selectionAnchor,
  } = selection;
  const selectionCancelRef = useRef<(() => void) | null>(null);
  const requestExport = useRequestContentExport();
  const requestAnalysis = useRequestContentAnalysis();
  const [selectionMenu, setSelectionMenu] = useState<{
    kind: 'copy' | 'forward';
    x: number;
    y: number;
  } | null>(null);
  const selectionMenuTrigger = useRef<HTMLElement | null>(null);
  const closeSelectionMenu = useCallback(() => {
    setSelectionMenu(null);
    selectionMenuTrigger.current?.focus({ preventScroll: true });
  }, []);
  const openSelectionMenu = (kind: 'copy' | 'forward', anchor: HTMLElement) => {
    selectionMenuTrigger.current = anchor;
    const rect = anchor.getBoundingClientRect();
    setSelectionMenu({ kind, x: rect.left, y: rect.top });
  };
  const exportMessageIds = (ids: string[]) => {
    if (ids.some((id) => parseSelectionGap(id))) {
      pushToast({ tone: 'warning', title: '请先补全或取消所选消息缺口' });
      return;
    }
    const scope = conversationExportSelection(conversation);
    if (requestExport && scope && ids.length)
      requestExport({ ...scope, scope: { type: 'items', ids: [...ids] } });
    setContextMenu(null);
  };
  const [decorationCard, setDecorationCard] = useState<{
    decoration: { fontId: number; bubbleId: number; widgetId: number } | null;
    anchor: { x: number; y: number };
  } | null>(null);
  // Local "清空聊天记录" hide set (localStorage). Per-message delete no longer
  // touches this — deleted messages stay visible under an overlay; this set
  // only backs the clear-conversation action.
  const [hiddenMessageIds, setHiddenMessageIds] = useState<Set<string>>(new Set());
  const [mentionMenu, setMentionMenu] = useState<MentionMenuState | null>(null);
  const atAllMention = useAtAllMention(
    Boolean(mentionMenu && tabActive && conversation?.type === 'group'),
    Number(conversation?.group?.identityValue),
  );
  const [unreadJump, setUnreadJump] = useState<UnreadJumpState | null>(null);
  // 未读跳转坞：当前跳到第几个跳转点（越界即整串收起）。换了会话就归零。
  const [dockIndex, setDockIndex] = useState(0);
  // Count of newly-arrived (live) messages while the user is reading history.
  // Surfaces the floating "jump to bottom" pill; cleared once at the bottom.
  const [newMessagePill, setNewMessagePill] = useState(0);
  const latestSeqRef = useRef<{ conversationId: string | undefined; seq: string | undefined }>({
    conversationId: undefined,
    seq: undefined,
  });
  const [jumpingToLatest, setJumpingToLatest] = useState(false);
  const [clearMessagesConfirmOpen, setClearMessagesConfirmOpen] = useState(false);
  const [titleProfileGroupId, setTitleProfileGroupId] = useState<string | null>(null);
  const [mobileComposerEditorHeight, setMobileComposerEditorHeight] = useState(42);
  const [mobileComposerLong, setMobileComposerLong] = useState(false);
  const [mobileComposerExpanded, setMobileComposerExpanded] = useState(false);
  const emojiPanelRef = useRef<HTMLDivElement | null>(null);
  const emojiButtonRef = useRef<HTMLButtonElement | null>(null);
  const expandedEmojiButtonRef = useRef<HTMLButtonElement | null>(null);

  function handleOpenGroupInfoDetail(detail: GroupInfoDetail) {
    if (conversation?.type === 'group') {
      onOpenGroupInfoDetail?.(conversation, detail);
    }
  }

  // 会话选区和锚点由独立 owner 保留，只关闭临时菜单。
  useEffect(() => {
    setSelectionMenu(null);
    setTitleProfileGroupId(null);
  }, [conversation?.id]);

  // 多选模式下按 Esc 退出。
  useLayoutEffect(() => {
    if (!tabActive || !selectionMode) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (hasActiveModal() || selectionMenu || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        selectionCancelRef.current?.();
        setSelectionMode(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [tabActive, selectionMode, setSelectionMode, selectionMenu]);

  const toolsPanelRef = useRef<HTMLDivElement | null>(null);
  const toolsButtonRef = useRef<HTMLButtonElement | null>(null);
  const voicePanelRef = useRef<HTMLDivElement | null>(null);
  const voiceButtonRef = useRef<HTMLButtonElement | null>(null);
  const voiceBusyRef = useRef(false);
  const arkPanelRef = useRef<HTMLDivElement | null>(null);
  const arkButtonRef = useRef<HTMLButtonElement | null>(null);
  const aiVoicePanelRef = useRef<HTMLDivElement | null>(null);
  const aiVoiceButtonRef = useRef<HTMLButtonElement | null>(null);
  const bouncePanelRef = useRef<HTMLDivElement | null>(null);
  const bounceButtonRef = useRef<HTMLButtonElement | null>(null);
  const pokePanelRef = useRef<HTMLDivElement | null>(null);
  const pokeButtonRef = useRef<HTMLButtonElement | null>(null);
  const redPacketPanelRef = useRef<HTMLDivElement | null>(null);
  const redPacketButtonRef = useRef<HTMLButtonElement | null>(null);
  const flashPanelRef = useRef<HTMLDivElement | null>(null);
  const flashButtonRef = useRef<HTMLButtonElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mentionMenuRef = useRef<HTMLDivElement | null>(null);
  const composerEditorRef = useRef<HTMLDivElement | null>(null);
  const expandedComposerEditorRef = useRef<HTMLDivElement | null>(null);
  const composerSelectionRef = useRef<Range | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  // Tracks whether the view is pinned to the bottom of the message list.
  // Drives auto-scroll-on-new-message vs. "new messages" pill behaviour.
  const atBottomRef = useRef(true);
  const readGestureUntil = useRef(0);
  const lastReadSignal = useRef({ key: '', at: 0 });
  const readContextRef = useRef({
    tabActive,
    atLatest,
    loading,
    conversation,
    onReadCurrentConversation,
    lastId: messages.at(-1)?.id,
  });
  readContextRef.current = {
    tabActive,
    atLatest,
    loading,
    conversation,
    onReadCurrentConversation,
    lastId: messages.at(-1)?.id,
  };
  // Last message id we auto-scrolled / accounted for, to detect new arrivals.
  const lastMessageIdRef = useRef<string | null>(null);
  // Conversation id the scroll-tracking refs above currently describe.
  const scrollConversationRef = useRef<string | null>(null);
  const unreadSeedRef = useRef<UnreadJumpSeed | null>(null);
  const unreadConversationRef = useRef<string | null>(null);
  const unreadScrollFrameRef = useRef<number | null>(null);

  // 换会话（或上层重下了新的一份快照）时，跳转坞从第一个跳转点重新开始。
  useEffect(() => {
    setDockIndex(0);
  }, [conversation?.id, unreadDock]);
  const deletedKeys = useMemo(
    () => new Set([...(deletedIds ?? [])].map(deletionIdentity)),
    [deletedIds],
  );
  const hiddenDeletedKeys = useMemo(
    () => new Set([...(hiddenDeletedIds ?? [])].map(deletionIdentity)),
    [hiddenDeletedIds],
  );
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          !hiddenMessageIds.has(message.id) && !hiddenDeletedKeys.has(deletionIdentity(message.id)),
      ),
    [messages, hiddenMessageIds, hiddenDeletedKeys],
  );
  const hasHiddenDeletionBetween = useMemo(
    () => hiddenDeletionLookup(messages, hiddenDeletedIds ?? new Set()),
    [messages, hiddenDeletedIds],
  );
  // 分析和回复使用不同目标，自己的消息不触发推荐；跳过灰条、撤回和删除。
  const intentSupported = Boolean(
    conversation &&
      conversation.chatType !== 8 &&
      !conversation.id.startsWith('dataline:') &&
      conversation.id !== 'weq-assistant',
  );
  const intentKind = conversation?.type === 'group' ? 'group' : 'c2c';
  const intentConv = intentSupported ? (conversation?.id ?? '') : '';
  const { latestMessageId, latestPeerMsgId, latestSuggestionId } = useMemo(
    () =>
      intentSupported
        ? intentTimelineTargets(visibleMessages, new Set(selfIdentityValues(user)), (message) =>
            Boolean(grayTipOf(message)),
          )
        : { latestMessageId: null, latestPeerMsgId: null, latestSuggestionId: null },
    [intentSupported, visibleMessages, user],
  );
  // 选中的消息（按时间线顺序）—— 合并转发 / 删除 / 复制 JSON 都用它。
  const selectionFlow = useMessageSelectionFlow({
    conversation,
    messages: visibleMessages,
    selection,
    onLoad: onLoadSelectionMessages,
    missingJumpSeq,
    active: tabActive,
  });
  selectionCancelRef.current = selectionFlow.cancel;
  const selectionOrder = selectionFlow.order;
  const actionScope = useMemo(() => ({}), [conversation?.id, user.id, tabActive]);
  const actionScopeRef = useRef<object | null>(actionScope);
  actionScopeRef.current = actionScope;
  useEffect(() => {
    actionScopeRef.current = actionScope;
    return () => {
      if (actionScopeRef.current === actionScope) actionScopeRef.current = null;
    };
  }, [actionScope]);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const restorableSelection = selectionFlow.selectedMessages.filter(
    (message) => deletedKeys.has(deletionIdentity(message.id)) || message.deletedKind === 'weq',
  );
  const selectionBlockedReason = selectionFlow.busy ? '正在加载所选范围' : null;
  const [batchAction, setBatchAction] = useState<{
    action: MessageBatchAction;
    batch: ReturnType<typeof partitionMessageBatch>;
  } | null>(null);
  useEffect(() => {
    setBatchAction(null);
  }, [conversation?.id, user.id, tabActive, selectionMode]);
  async function performBatchAction(action: MessageBatchAction, messages: Message[]) {
    setBatchAction(null);
    setContextMenu(null);
    if (!conversation || !tabActive || selectionBlockedReason || !selectionMode) return;
    if (action === 'export') exportMessageIds(messages.map((message) => message.id));
    else if (action === 'analysis')
      requestAnalysis?.(
        conversationAnalysisTarget(conversation),
        messages.map((message) => message.id),
      );
    else {
      if (deletionBusy) return;
      const hidden = await confirmMessageDeletion(messages.length);
      if (hidden === null || actionScopeRef.current !== actionScope) return;
      setDeletionBusy(true);
      const processed = new Set<string>();
      for (const message of messages) {
        if (actionScopeRef.current !== actionScope) break;
        try {
          await onDeleteMessage?.(message, conversation, hidden);
          processed.add(message.id);
        } catch {
          /* 失败记录保留选择，上层统一报告。 */
        }
      }
      setDeletionBusy(false);
      if (actionScopeRef.current !== actionScope) return;
      // 只移除已处理的选择；不支持的记录留在原选区供后续同步或复制。
      if ([...selection.selectedIdsRef.current].every((id) => processed.has(id))) exitSelection();
      else {
        selection.removeSelectedIds([...processed]);
        if (selectionAnchor.current && processed.has(selectionAnchor.current))
          selectionAnchor.current = null;
      }
    }
  }
  async function restoreSelectedMessages() {
    if (!onRestoreMessage || deletionBusy || !restorableSelection.length) return;
    setDeletionBusy(true);
    const restored: string[] = [];
    for (const message of restorableSelection) {
      if (actionScopeRef.current !== actionScope) break;
      try {
        await onRestoreMessage(message.id);
        restored.push(message.id);
      } catch (error) {
        pushToast({ tone: 'error', title: '恢复消息失败', detail: String(error) });
      }
    }
    setDeletionBusy(false);
    if (actionScopeRef.current === actionScope) selection.removeSelectedIds(restored);
  }
  async function requestBatchAction(action: MessageBatchAction) {
    if (selectionBlockedReason || !selectedIds.size) return;
    const picked = await selectionFlow.prepare(
      action === 'export' ? '导出' : action === 'analysis' ? '分析' : '删除',
    );
    if (!picked?.length) return;
    const batch = partitionMessageBatch(picked, action);
    if (batch.unsupported.length) setBatchAction({ action, batch });
    else performBatchAction(action, batch.supported);
  }
  const multi = useMultiSelection({
    ids: selectionOrder,
    selected: selectedIds,
    onChange: selectionFlow.onChange,
    enabled: selectionMode,
    disabled: !tabActive || Boolean(selectionMenu) || selectionFlow.busy,
    onStart: () => setSelectionMode(true),
    onExit: exitSelection,
    anchorRef: selectionAnchor,
    beforeSelect: selectionFlow.beforeSelect,
  });
  const marquee = useMessageMarquee({
    conversationKey: conversation?.id,
    enabled: tabActive && Boolean(conversation) && !selectionMenu && !selectionFlow.busy,
    selectionMode,
    selected: selectedIds,
    orderedIds: selectionOrder,
    anchorRef: selectionAnchor,
    onChange: selectionFlow.onChange,
    onStart: () => setSelectionMode(true),
    onSelect: (id, modifiers) => multi.toggle(id, modifiers),
  });
  const previewGapIndex = useMemo(
    () =>
      marquee.previewIds
        ? createSelectionGapIndex(
            [...marquee.previewIds].flatMap((id) => {
              const gap = parseSelectionGap(id);
              return gap ? [gap] : [];
            }),
          )
        : null,
    [marquee.previewIds],
  );
  const displayedGapSelected = (gap: SelectionGap) =>
    previewGapIndex ? previewGapIndex.containsGap(gap) : selectionFlow.gapSelected(gap);
  const displayedSelectedIds = marquee.previewIds ?? selectedIds;
  const copySelectedMessagesText = useCallback(async () => {
    if (!conversation) return;
    if (selectionBlockedReason) {
      pushToast({ tone: 'warning', title: selectionBlockedReason });
      return;
    }
    const picked = await selectionFlow.prepare('复制');
    if (!picked?.length) return;
    try {
      const copied = await copyTextToClipboard(selectedMessagesText(picked, conversation, user));
      if (!copied) throw new Error('未能写入剪贴板，请重新复制。');
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '复制失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }, [conversation, selectionFlow.prepare, user, pushToast, selectionBlockedReason]);
  const copySelectedMessagesRich = useCallback(async () => {
    if (selectionBlockedReason) {
      pushToast({ tone: 'warning', title: selectionBlockedReason });
      return;
    }
    const picked = await selectionFlow.prepare('复制');
    if (!picked?.length) return;
    const value = messageRichClipboard(
      picked.map((message) => ({
        sender: displayUserName(resolveMessageSender(message, conversation, user)),
        time: message.createdAt,
        body: message.body,
        elements: message.qqElements,
      })),
    );
    if (!(await writeMentionClipboard(value)))
      pushToast({ tone: 'error', message: '复制富文本失败' });
  }, [conversation, selectionFlow.prepare, user, pushToast, selectionBlockedReason]);
  useLayoutEffect(() => {
    if (!tabActive || !selectionMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasActiveModal()) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')
      )
        return;
      if (event.key.toLowerCase() === 'c' && selectedIds.size) {
        event.preventDefault();
        if (event.shiftKey) void copySelectedMessagesRich();
        else void copySelectedMessagesText();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    tabActive,
    selectionMode,
    selectedIds.size,
    copySelectedMessagesText,
    copySelectedMessagesRich,
  ]);

  // 下面几个 effect 只该在会话/消息变化时跑，但正文里要调用这些每次渲染都重建的
  // 函数。用 ref 转发拿最新实现，避免把它们塞进依赖导致 effect 每次渲染重跑。
  const scrollMessagesToBottomRef = useRef<() => void>(() => {});
  const updateUnreadJumpRemainingRef = useRef<() => void>(() => {});
  const scheduleMobileComposerMeasureRef = useRef<(editor?: HTMLElement | null) => void>(() => {});
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const bodyRef = useRef(body);
  bodyRef.current = body;

  useLayoutEffect(() => {
    const conversationId = conversation?.id ?? null;
    if (unreadConversationRef.current === conversationId) {
      return;
    }

    unreadConversationRef.current = conversationId;
    setUnreadJump(null);
    const total = Math.max(0, conversation?.unreadCount ?? 0);
    unreadSeedRef.current =
      conversationId && total > 0
        ? {
            conversationId,
            total,
          }
        : null;
  }, [conversation?.id, conversation?.unreadCount]);

  useLayoutEffect(() => {
    const seed = unreadSeedRef.current;
    if (
      !seed ||
      seed.conversationId !== conversation?.id ||
      loading ||
      visibleMessages.length === 0
    ) {
      return;
    }

    const total = Math.min(seed.total, visibleMessages.length);
    unreadSeedRef.current = null;
    setUnreadJump(
      total > 0
        ? {
            conversationId: seed.conversationId,
            remaining: total,
            total,
          }
        : null,
    );
  }, [conversation?.id, loading, visibleMessages]);

  useLayoutEffect(() => {
    if (!tabActive) return;
    const conversationId = conversation?.id ?? null;
    const newestId = visibleMessages[visibleMessages.length - 1]?.id ?? null;

    // Conversation switched (or first paint): jump to bottom, reset trackers.
    if (scrollConversationRef.current !== conversationId) {
      scrollConversationRef.current = conversationId;
      lastMessageIdRef.current = newestId;
      atBottomRef.current = true;
      setNewMessagePill(0);
      scrollMessagesToBottomRef.current();
      const frame = window.requestAnimationFrame(() => scrollMessagesToBottomRef.current());
      return () => window.cancelAnimationFrame(frame);
    }

    // 尾部 id 没变，但列表内容可能变了。典型情况：打开会话时末尾挂着「数据库里还没有」
    // 的乐观消息，它先成为尾部，随后真实历史在它**上面**补全 —— 尾部 id 一直没变，
    // 早退就会停在第一页中间而不是底部。仍钉在底部（且是实时窗口）时就跟着贴底；
    // 用户在看历史（atBottom=false）或脱离实时窗口时不动。
    if (newestId === lastMessageIdRef.current) {
      if (atBottomRef.current && atLatest) {
        scrollMessagesToBottomRef.current();
      }
      return;
    }

    const prevId = lastMessageIdRef.current;
    // The window was swapped wholesale (reply-jump rebuild) when the previous
    // tail is no longer present — that's not a live arrival.
    const replaced = prevId !== null && !visibleMessages.some((message) => message.id === prevId);
    const appended = countAppendedMessages(prevId, visibleMessages);
    lastMessageIdRef.current = newestId;

    // Detached history window (reply-jump context or downward history paging):
    // tail changes are programmatic. Don't pill, don't yank to the bottom — the
    // host positions the view itself.
    if (replaced || !atLatest) {
      return;
    }

    // Pinned to bottom → follow the new message down, no pill.
    if (atBottomRef.current) {
      setNewMessagePill(0);
      scrollMessagesToBottomRef.current();
      const frame = window.requestAnimationFrame(() => scrollMessagesToBottomRef.current());
      return () => window.cancelAnimationFrame(frame);
    }

    // Reading history → surface the pill instead of yanking the view down.
    setNewMessagePill((current) => current + appended);
    return;
  }, [tabActive, visibleMessages, conversation?.id, loading, atLatest]);

  // 分离的历史窗口不会追加实时消息，用会话水位识别新到记录，而非历史分页。
  useEffect(() => {
    const previous = latestSeqRef.current;
    latestSeqRef.current = { conversationId: conversation?.id, seq: latestMessageSeq };
    if (
      atLatest ||
      previous.conversationId !== conversation?.id ||
      !previous.seq ||
      !latestMessageSeq ||
      !/^\d+$/.test(previous.seq) ||
      !/^\d+$/.test(latestMessageSeq)
    )
      return;
    const delta = BigInt(latestMessageSeq) - BigInt(previous.seq);
    if (delta < 0n) latestSeqRef.current = previous;
    if (delta > 0n) setNewMessagePill((count) => count + Number(delta > 100n ? 100n : delta));
  }, [conversation?.id, latestMessageSeq, atLatest]);

  // updateUnreadJumpRemaining 会写回 unreadJump.remaining，所以这里只认「换会话 /
  // 换未读总数」这两个稳定信号，不能整体依赖 unreadJump，否则每次滚动都要多跑一轮。
  const unreadJumpKey = unreadJump ? `${unreadJump.conversationId}:${unreadJump.total}` : null;

  useLayoutEffect(() => {
    if (!tabActive || !unreadJumpKey) {
      return;
    }

    updateUnreadJumpRemainingRef.current();
    const frame = window.requestAnimationFrame(() => updateUnreadJumpRemainingRef.current());
    return () => window.cancelAnimationFrame(frame);
  }, [tabActive, unreadJumpKey, visibleMessages, loading]);

  useEffect(
    () => () => {
      if (unreadScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(unreadScrollFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    setEmojiOpen(false);
    setToolsOpen(false);
    setContextMenu(null);
    setMentionMenu(null);
    setClearMessagesConfirmOpen(false);
    setMobileComposerExpanded(false);
    setHiddenMessageIds(loadHiddenMessageIds(conversation?.id));
  }, [conversation?.id]);

  useEffect(() => {
    const editor = composerEditorRef.current;
    const currentDraft = draftRef.current;
    setBody(currentDraft);
    composerSelectionRef.current = null;
    if (editor) {
      restoreComposer(editor, currentDraft);
      scheduleMobileComposerMeasureRef.current(editor);
    }
  }, [conversation?.id]);

  useEffect(() => {
    if (!tabActive || !mobileComposerExpanded) {
      return;
    }

    const editor = expandedComposerEditorRef.current;
    if (!editor) {
      return;
    }

    restoreComposer(editor, bodyRef.current);
    composerSelectionRef.current = null;
    const frame = window.requestAnimationFrame(() => focusComposerEnd(editor));
    return () => window.cancelAnimationFrame(frame);
  }, [tabActive, mobileComposerExpanded]);

  // 只关心「菜单开着 / 关着」和它锚在哪条消息上；重新定位读的是 setContextMenu 的
  // 函数式更新，所以不需要整体依赖 contextMenu（它每次重定位都会变新对象）。
  const contextMenuOpen = contextMenu !== null;
  const contextMenuVariant = contextMenu?.variant ?? null;
  const contextMenuMessageId = contextMenu?.message.id ?? null;

  useLayoutEffect(() => {
    if (!tabActive || !contextMenuOpen) {
      return;
    }

    function closeMenu() {
      setContextMenu(null);
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        closeMenu();
      }
    }

    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeMenu);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeMenu);
    };
  }, [tabActive, contextMenuOpen]);

  // 头像菜单同款：点外面 / Esc / 改窗口尺寸就收起。
  const avatarMenuOpen = avatarMenu !== null;
  useLayoutEffect(() => {
    if (!tabActive || !avatarMenuOpen) {
      return;
    }
    function closeAvatarMenu() {
      setAvatarMenu(null);
    }
    function closeAvatarOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        closeAvatarMenu();
      }
    }
    document.addEventListener('keydown', closeAvatarOnEscape);
    window.addEventListener('resize', closeAvatarMenu);
    return () => {
      document.removeEventListener('keydown', closeAvatarOnEscape);
      window.removeEventListener('resize', closeAvatarMenu);
    };
  }, [tabActive, avatarMenuOpen]);

  // Keep the desktop context menu glued to its message as the list scrolls,
  // instead of floating in place. Dismisses once the message leaves the list
  // viewport. Mobile menus (long-press sheet) keep their fixed placement.
  useLayoutEffect(() => {
    if (!tabActive || !contextMenuMessageId || contextMenuVariant === 'mobile') {
      return;
    }
    const scroll = messageScrollRef.current;
    if (!scroll) {
      return;
    }

    let frame = 0;
    function reposition() {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setContextMenu((current) => {
          if (!current || current.variant === 'mobile') {
            return current;
          }
          const container = messageScrollRef.current;
          if (!container) {
            return current;
          }
          const idSelector = current.message.id.replace(/["\\]/g, '\\$&');
          const el = container.querySelector<HTMLElement>(`[data-message-id="${idSelector}"]`);
          if (!el) {
            return current;
          }
          const rect = el.getBoundingClientRect();
          const bounds = container.getBoundingClientRect();
          // Message scrolled out of the list viewport → dismiss the menu.
          if (rect.bottom < bounds.top || rect.top > bounds.bottom) {
            return null;
          }
          const x = Math.min(rect.left + (current.anchorOffsetX ?? 0), window.innerWidth - 126);
          const y = Math.min(
            Math.max(rect.top + (current.anchorOffsetY ?? 0), 8),
            window.innerHeight - 84,
          );
          return { ...current, x, y };
        });
      });
    }

    scroll.addEventListener('scroll', reposition, { passive: true });
    return () => {
      scroll.removeEventListener('scroll', reposition);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [tabActive, contextMenuMessageId, contextMenuVariant]);

  useLayoutEffect(() => {
    if (!tabActive || !emojiOpen) {
      return;
    }

    function closeEmojiFromOutside(event: globalThis.MouseEvent) {
      if (hasActiveModal()) return;
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        emojiPanelRef.current?.contains(target) ||
        emojiButtonRef.current?.contains(target) ||
        expandedEmojiButtonRef.current?.contains(target) ||
        toolsButtonRef.current?.contains(target)
      ) {
        return;
      }
      setEmojiOpen(false);
    }

    function closeEmojiOnEscape(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || hasActiveModal()) return;
      if (event.key === 'Escape') {
        setEmojiOpen(false);
      }
    }

    document.addEventListener('mousedown', closeEmojiFromOutside);
    document.addEventListener('keydown', closeEmojiOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeEmojiFromOutside);
      document.removeEventListener('keydown', closeEmojiOnEscape);
    };
  }, [tabActive, emojiOpen]);

  useLayoutEffect(() => {
    if (!tabActive || !toolsOpen) {
      return;
    }

    function closeToolsFromOutside(event: globalThis.MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        toolsPanelRef.current?.contains(target) ||
        toolsButtonRef.current?.contains(target) ||
        emojiButtonRef.current?.contains(target) ||
        expandedEmojiButtonRef.current?.contains(target)
      ) {
        return;
      }
      setToolsOpen(false);
    }

    function closeToolsOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setToolsOpen(false);
      }
    }

    document.addEventListener('mousedown', closeToolsFromOutside);
    document.addEventListener('keydown', closeToolsOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeToolsFromOutside);
      document.removeEventListener('keydown', closeToolsOnEscape);
    };
  }, [tabActive, toolsOpen]);

  useLayoutEffect(() => {
    if (!tabActive || !voiceOpen) {
      return;
    }

    // 正在录音（含请求麦克风）时不能因为点到外面就把这条丢掉。
    function closeVoiceFromOutside(event: globalThis.MouseEvent) {
      if (voiceBusyRef.current) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (voicePanelRef.current?.contains(target) || voiceButtonRef.current?.contains(target)) {
        return;
      }
      setVoiceOpen(false);
    }

    function closeVoiceOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || voiceBusyRef.current) return;
      setVoiceOpen(false);
    }

    document.addEventListener('mousedown', closeVoiceFromOutside);
    document.addEventListener('keydown', closeVoiceOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeVoiceFromOutside);
      document.removeEventListener('keydown', closeVoiceOnEscape);
    };
  }, [tabActive, voiceOpen]);

  // 闪传文件框：点到外面 / Esc 就收起来（与语音 / ark 面板同一套交互）。
  // 灯箱在面板内部，所以点灯箱不会被误判成「点到外面」。
  useLayoutEffect(() => {
    if (!tabActive || !flashOpen) return;

    function closeFlashFromOutside(event: globalThis.MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (flashPanelRef.current?.contains(target) || flashButtonRef.current?.contains(target)) {
        return;
      }
      // 灯箱 `createPortal` 到 document.body（见 FlashComposer 的注释）：DOM 上已经
      // 不算面板的子孙了。不认它会点一下灯箱就把整份草稿关掉。
      if (target instanceof Element && target.closest('.flash-lightbox') !== null) {
        return;
      }
      setFlashOpen(false);
    }

    function closeFlashOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      // 灯箱自己处理 Esc（只退回文件框）；它开着时这一层不要再抢。
      if (document.querySelector('.flash-lightbox')) return;
      setFlashOpen(false);
    }

    document.addEventListener('mousedown', closeFlashFromOutside);
    document.addEventListener('keydown', closeFlashOnEscape);
    // 灯箱打开时不允许误关：合成/发送中也不关（见 FlashComposer 自己的 Esc 处理）。
    return () => {
      document.removeEventListener('mousedown', closeFlashFromOutside);
      document.removeEventListener('keydown', closeFlashOnEscape);
    };
  }, [tabActive, flashOpen]);

  useLayoutEffect(() => {
    if (!tabActive || !arkOpen) {
      return;
    }

    function closeLinkFromOutside(event: globalThis.MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        arkPanelRef.current?.contains(target) ||
        arkButtonRef.current?.contains(target) ||
        emojiButtonRef.current?.contains(target) ||
        toolsButtonRef.current?.contains(target) ||
        // 好友 / 群的选择下拉挂在 document.body 上（不被预览区截断），在 DOM 里
        // 已经不算面板的子孙了；不认它的话，点一行联系人会先把整个面板关掉。
        (target instanceof Element && target.closest('.ark-contact-list') !== null)
      ) {
        return;
      }
      setArkOpen(false);
    }

    function closeLinkOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setArkOpen(false);
      }
    }

    document.addEventListener('mousedown', closeLinkFromOutside);
    document.addEventListener('keydown', closeLinkOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeLinkFromOutside);
      document.removeEventListener('keydown', closeLinkOnEscape);
    };
  }, [tabActive, arkOpen]);

  useLayoutEffect(() => {
    if (!tabActive || !aiVoiceOpen) {
      return;
    }

    function closeAiVoiceFromOutside(event: globalThis.MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        aiVoicePanelRef.current?.contains(target) ||
        aiVoiceButtonRef.current?.contains(target) ||
        emojiButtonRef.current?.contains(target) ||
        toolsButtonRef.current?.contains(target)
      ) {
        return;
      }
      setAiVoiceOpen(false);
    }

    function closeAiVoiceOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setAiVoiceOpen(false);
      }
    }

    document.addEventListener('mousedown', closeAiVoiceFromOutside);
    document.addEventListener('keydown', closeAiVoiceOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeAiVoiceFromOutside);
      document.removeEventListener('keydown', closeAiVoiceOnEscape);
    };
  }, [tabActive, aiVoiceOpen]);

  useLayoutEffect(() => {
    if (!tabActive || !bounceOpen) {
      return;
    }

    function closeBounceFromOutside(event: globalThis.MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        bouncePanelRef.current?.contains(target) ||
        bounceButtonRef.current?.contains(target) ||
        emojiButtonRef.current?.contains(target) ||
        toolsButtonRef.current?.contains(target)
      ) {
        return;
      }
      setBounceOpen(false);
      setPokeOpen(false);
    }

    function closeBounceOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setBounceOpen(false);
      }
    }

    document.addEventListener('mousedown', closeBounceFromOutside);
    document.addEventListener('keydown', closeBounceOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeBounceFromOutside);
      document.removeEventListener('keydown', closeBounceOnEscape);
    };
  }, [tabActive, bounceOpen]);

  useLayoutEffect(() => {
    if (!tabActive || !pokeOpen) {
      return;
    }

    function closePokeFromOutside(event: globalThis.MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        pokePanelRef.current?.contains(target) ||
        pokeButtonRef.current?.contains(target) ||
        emojiButtonRef.current?.contains(target) ||
        toolsButtonRef.current?.contains(target) ||
        bounceButtonRef.current?.contains(target)
      ) {
        return;
      }
      setPokeOpen(false);
    }

    function closePokeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setPokeOpen(false);
      }
    }

    document.addEventListener('mousedown', closePokeFromOutside);
    document.addEventListener('keydown', closePokeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closePokeFromOutside);
      document.removeEventListener('keydown', closePokeOnEscape);
    };
  }, [tabActive, pokeOpen]);

  useLayoutEffect(() => {
    if (!tabActive || !redPacketOpen) {
      return;
    }

    function closeRedPacketFromOutside(event: globalThis.MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        redPacketPanelRef.current?.contains(target) ||
        redPacketButtonRef.current?.contains(target)
      ) {
        return;
      }
      setRedPacketOpen(false);
    }

    function closeRedPacketOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setRedPacketOpen(false);
      }
    }

    document.addEventListener('mousedown', closeRedPacketFromOutside);
    document.addEventListener('keydown', closeRedPacketOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeRedPacketFromOutside);
      document.removeEventListener('keydown', closeRedPacketOnEscape);
    };
  }, [tabActive, redPacketOpen]);

  // 附件跟着会话走：切会话时清掉上一条会话的待发送素材（预览地址一并释放）。
  const mediaAttachmentRef = useRef<ComposerAttachment | null>(null);
  mediaAttachmentRef.current = mediaAttachment;
  const inlineImagesRef = useRef<ComposerAttachment[]>([]);
  const retainedSendUrlsRef = useRef(new Set<string>());
  const reeditObjectUrlsRef = useRef<string[]>([]);
  const reeditLocalsRef = useRef<LocalMediaRef[]>([]);
  const reeditAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => reeditAbortRef.current?.abort(), [conversation?.id, user.id]);
  /** 释放所有内联图片的预览地址（发送成功 / 切会话 / 卸载时）。 */
  const releaseInlineImages = useCallback(() => {
    for (const item of inlineImagesRef.current) releaseAttachment(item);
    inlineImagesRef.current = [];
    for (const url of reeditObjectUrlsRef.current) URL.revokeObjectURL(url);
    reeditObjectUrlsRef.current = [];
  }, []);
  useEffect(() => {
    if (sending) return;
    const referenced = new Set(
      messages.flatMap((message) =>
        (message.composerDraft?.locals ?? []).flatMap((local) => [local.key, local.previewUrl]),
      ),
    );
    for (const url of retainedSendUrlsRef.current) {
      if (referenced.has(url)) continue;
      URL.revokeObjectURL(url);
      retainedSendUrlsRef.current.delete(url);
    }
  }, [messages, sending]);
  const attachmentConversationRef = useRef<string | null>(null);
  useEffect(() => {
    const conversationId = conversation?.id ?? null;
    if (attachmentConversationRef.current === conversationId) {
      return;
    }
    attachmentConversationRef.current = conversationId;
    reeditLocalsRef.current = [];
    releaseInlineImages();
    setMediaAttachment((current) => {
      if (current) releaseAttachment(current);
      return null;
    });
    setPendingSuperEmoji(null);
    // 引用也跟着会话走：换了会话就不能再引用上一条会话里的消息了。
    setPendingQuote(null);
    // AI 声聊 / 弹射表情面板同理：换会话不能把上一会话的面板留在屏幕上。
    setAiVoiceOpen(false);
    setBounceOpen(false);
    setPokeOpen(false);
    setAttachmentError(null);
    setDropActive(false);
  }, [conversation?.id, releaseInlineImages]);

  useLayoutEffect(
    () => () => {
      releaseInlineImages();
      for (const url of retainedSendUrlsRef.current) URL.revokeObjectURL(url);
      retainedSendUrlsRef.current.clear();
      if (mediaAttachmentRef.current) releaseAttachment(mediaAttachmentRef.current);
    },
    [releaseInlineImages],
  );

  useLayoutEffect(() => {
    if (!tabActive || !mentionMenu) {
      return;
    }

    function closeMentionFromOutside(event: globalThis.MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        mentionMenuRef.current?.contains(target) ||
        composerEditorRef.current?.contains(target) ||
        expandedComposerEditorRef.current?.contains(target)
      ) {
        return;
      }
      setMentionMenu(null);
    }

    document.addEventListener('mousedown', closeMentionFromOutside);
    return () => {
      document.removeEventListener('mousedown', closeMentionFromOutside);
    };
  }, [tabActive, mentionMenu]);

  function currentComposerEditor() {
    if (mobileComposerExpanded) {
      return expandedComposerEditorRef.current ?? composerEditorRef.current;
    }
    return composerEditorRef.current;
  }

  function saveComposerSelection(editor = currentComposerEditor()) {
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (isNodeInside(editor, range.startContainer) && isNodeInside(editor, range.endContainer)) {
      composerSelectionRef.current = range.cloneRange();
    }
  }

  function composerPreviewImage(event: ReactMouseEvent<HTMLDivElement>) {
    const editor = event.currentTarget;
    const ElementClass = editor.ownerDocument.defaultView?.Element;
    if (!ElementClass || !(event.target instanceof ElementClass)) return null;
    const image = event.target.closest<HTMLImageElement>(
      'img.composer-inline-attachment, img.composer-sticker-token',
    );
    return image && editor.contains(image) ? image : null;
  }

  function prepareComposerImagePreview(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || !composerPreviewImage(event)) return;
    saveComposerSelection(event.currentTarget);
    event.preventDefault();
  }

  function previewComposerImage(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const image = composerPreviewImage(event);
    if (!image) return;
    event.preventDefault();
    event.stopPropagation();
    const editor = event.currentTarget;
    const owner = editor.ownerDocument;
    const range = composerSelectionRef.current?.cloneRange();
    const id = conversation?.id;
    openLightbox(image.currentSrc || image.src, image.alt, null, owner, () => {
      owner.defaultView?.requestAnimationFrame(() => {
        if (
          !editor.isConnected ||
          owner.defaultView?.closed ||
          readContextRef.current.conversation?.id !== id ||
          !readContextRef.current.tabActive
        )
          return;
        if (
          range &&
          isNodeInside(editor, range.startContainer) &&
          isNodeInside(editor, range.endContainer)
        ) {
          editor.focus({ preventScroll: true });
          const selection = owner.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          composerSelectionRef.current = range.cloneRange();
        } else focusComposerEnd(editor);
      });
    });
  }

  function syncComposerBody(editor = currentComposerEditor()) {
    if (!editor) {
      return;
    }

    setComposerBody(serializeComposer(editor));
    saveComposerSelection(editor);
    if (editor === composerEditorRef.current) {
      scheduleMobileComposerMeasure(editor);
    }
    updateMentionMenu(editor);
  }

  function insertComposerText(value: string) {
    const editor = currentComposerEditor();
    if (!editor) {
      setComposerBody(`${body}${value}`);
      return;
    }

    insertComposerNode(editor, document.createTextNode(value), composerSelectionRef.current);
    syncComposerBody();
  }

  function insertMention(member: GroupMember) {
    if (currentPreference.blocked || sending || (member.id === 'all' && !atAllMention.selectable)) {
      return;
    }

    const editor = currentComposerEditor();
    const label = mentionText(member);
    if (!editor) {
      setComposerBody(`${body}${label} `);
      setMentionMenu(null);
      return;
    }

    const trigger = getActiveComposerMentionTrigger(editor, composerSelectionRef.current);
    const token = document.createElement('span');
    token.className = cn('composer-mention-token');
    token.contentEditable = 'false';
    token.dataset.chatMention = label;
    token.dataset.weqAtUid = member.id;
    // 真正的 @ 语义（uid/uin）靠元素 token 带走：序列化时原样取回，发送时还原成
    // `at` 元素。只留 label 的话发出去会退化成一串纯文本 `@昵称`，不会真的提醒对方。
    const mentionUin = /^\d+$/.test(member.identityValue)
      ? Number(member.identityValue)
      : undefined;
    token.dataset.chatToken = elementToToken({
      kind: 'at',
      textContent: label,
      atTargetUid: member.id,
      ...(member.id === 'all' ? { all: true } : {}),
      ...(mentionUin ? { atTargetUin: mentionUin } : {}),
    });
    token.textContent = label;

    if (trigger) {
      replaceComposerTextRange(editor, trigger.start, trigger.end, [
        token,
        document.createTextNode(' '),
      ]);
    } else {
      insertComposerNode(editor, token, composerSelectionRef.current);
      insertComposerNode(editor, document.createTextNode(' '), null);
    }

    syncComposerBody(editor);
    setMentionMenu(null);
  }

  /** 头像菜单「@他」：把 `@昵称 ` 写进输入框（没有活动的 @ 触发词就插在光标处）。 */
  function mentionAvatar(sender: User) {
    setAvatarMenu(null);
    insertMention(sender as GroupMember);
    window.requestAnimationFrame(() => focusComposerEnd(currentComposerEditor()));
  }

  /**
   * 头像菜单「戳一戳」：群聊戳成员 / 私聊戳对方或**自己**（OIDB 0xED3_1）。
   *
   * 被戳的人在协议里是 `uin`、AIO 是 `friendUin`，两者可以不同（SnowLuma 的
   * friend poke 就是 `uin = targetUin ?? peerUin`、`friendUin = peerUin`；群聊
   * 也是同一套形状 —— 群号 + 被戳成员）。所以右键**自己的**头像时，`friendUin`
   * 仍填对方、被戳人换成自己 = 戳自己。之前私聊分支把被戳人写死成对方，导致
   * 戳自己也会戳到对方。
   */
  function pokeAvatar(sender: User) {
    setAvatarMenu(null);
    if (!conversation) {
      return;
    }
    const targetId =
      conversation.type === 'group'
        ? conversation.group.identityValue
        : conversation.otherUser.identityValue;
    // 私聊里「被戳的人」可能是对方，也可能是我（右键自己的头像）。sender 是
    // 已解析好的 User：命中「自己」的身份集合（`self:<uin>` / uin / uid）即戳自己。
    const pokingSelf =
      conversation.type === 'direct' &&
      isSelfIdentity(new Set(selfIdentityValues(user)), sender.id);
    const params =
      conversation.type === 'group'
        ? { peerType: 'group' as const, targetId, targetUin: sender.identityValue }
        : {
            peerType: 'c2c' as const,
            targetId,
            ...(pokingSelf ? { targetUin: user.identityValue } : {}),
          };
    const finish = atLatest ? beginInlineAction('timeline:poke', '正在戳一戳') : () => {};
    sendPoke.mutate(params, {
      onSettled: finish,
      onError: (error) => {
        pushToast({
          tone: 'error',
          title: '戳一戳失败',
          detail: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  function openAvatarMenu(event: ReactMouseEvent, sender: User) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    window.getSelection()?.removeAllRanges();
    setAvatarMenu({
      sender,
      x: Math.min(event.clientX, window.innerWidth - 140),
      y: Math.min(event.clientY, window.innerHeight - 72),
    });
  }

  /** 右键消息「贴表情」：把表情面板锜在这条消息下面。 */
  function openReactionPicker(message: Message) {
    setContextMenu(null);
    if (messageReactionBlockedReason(message)) return;
    const idSelector = message.id.replace(/["\\]/g, '\\$&');
    const el = messageScrollRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${idSelector}"]`,
    );
    const rect = el?.getBoundingClientRect();
    setReactionPicker({
      message,
      x: rect
        ? Math.min(rect.left, Math.max(8, window.innerWidth - 336))
        : window.innerWidth / 2 - 160,
      y: rect ? Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 340)) : 120,
    });
  }

  function chooseReaction(code: string) {
    const picker = reactionPicker;
    setReactionPicker(null);
    if (picker) changeMessageReaction(picker.message, code, true);
  }

  function messageReactionBlockedReason(message: Message): string | null {
    if (grayTipOf(message)) return '系统消息不支持贴表情';
    if (conversation?.type !== 'group') return '只有群消息支持贴表情';
    if (reactionRequestPending.current) return '正在处理表情回应';
    return (
      outgoingActionBlockReason(message) ??
      reactionBlockedReason ??
      (Number.isSafeInteger(Number(message.msgSeq)) && Number(message.msgSeq) > 0
        ? null
        : '这条消息缺少会话内序号，无法贴表情')
    );
  }

  function changeMessageReaction(message: Message, code: string, isSet: boolean) {
    const current = visibleMessages.find((row) => row.id === message.id);
    if (!current || !conversation || conversation.type !== 'group') return;
    const reason = messageReactionBlockedReason(current);
    if (reason) {
      pushToast({ tone: 'warning', message: reason });
      return;
    }
    if (!isSet && !current.setEmojiList?.some((item) => item.emojiId === code && item.isSelfSet))
      return;
    reactionRequestPending.current = true;
    const finish = beginInlineAction(message.id, isSet ? '正在贴表情' : '正在撤回表情回应');
    setMessageReaction.mutate(
      {
        groupId: conversation.group.identityValue,
        sequence: Number(current.msgSeq),
        code,
        isSet,
      },
      {
        onError: (error) => {
          pushToast({
            tone: 'error',
            title: isSet ? '贴表情失败' : '撤回贴表情失败',
            detail: error instanceof Error ? error.message : String(error),
          });
        },
        onSettled: () => {
          finish();
          reactionRequestPending.current = false;
        },
      },
    );
  }

  /** 头像是否是「我」——按身份串集合判定（id / uin / uid 任一命中）。 */
  function isSelfAvatar(sender: User): boolean {
    if (sender.id === user.id) {
      return true;
    }
    return isSelfIdentity(new Set(selfIdentityValues(user)), sender.id);
  }

  /**
   * 取群管理协议需要的目标 uid。别人 = 发送者 uid（群消息 sender.id 就是 uid）；
   * 自己 = 当前账号 uid，全局资料里没有时退回成员表按 uin 反查。
   */
  function groupTargetUid(sender: User): string | null {
    if (!isSelfAvatar(sender)) {
      const identities = [
        ...new Set(
          [sender.id, sender.uid].filter((identity) => /^u_[A-Za-z0-9_-]+$/.test(identity ?? '')),
        ),
      ];
      return identities.length === 1 ? identities[0] : null;
    }
    if (user.uid) {
      return user.uid;
    }
    if (conversation?.type === 'group') {
      const me = conversation.members.find(
        (m) => m.identityValue === user.identityValue || m.uin === user.identityValue,
      );
      return me?.id ?? null;
    }
    return null;
  }

  /**
   * 名片／头衔与资料卡共用展示规则；踢人、禁言等仍要求目标职权更低。
   */
  function avatarModerationFlags(sender: User): {
    showChangeCard: boolean;
    showChangeTitle: boolean;
    showKick: boolean;
    showMute: boolean;
    showSetAdmin: boolean;
    showUnsetAdmin: boolean;
  } | null {
    if (conversation?.type !== 'group') {
      return null;
    }
    const myRole = conversation.group.roleKnown === false ? null : conversation.group.role;
    const targetUid = groupTargetUid(sender);
    const targetMember = conversation.members.find((member) =>
      selfIdentityValues(member).some((identity) => selfIdentityValues(sender).includes(identity)),
    );
    const targetRole = isSelfAvatar(sender) ? myRole : (targetMember?.role ?? sender.role);
    const editing = groupMemberEditing(myRole, targetRole);
    const validUid = Boolean(targetUid && /^u_[A-Za-z0-9_-]+$/.test(targetUid));
    if (isSelfAvatar(sender)) {
      return {
        showChangeCard: editing.card && validUid,
        showChangeTitle: editing.title && validUid,
        showKick: false,
        showMute: false,
        showSetAdmin: false,
        showUnsetAdmin: false,
      };
    }
    if (myRole !== 'owner' && myRole !== 'admin') {
      return null;
    }
    const rank: Record<GroupMemberRole, number> = { owner: 2, admin: 1, member: 0 };
    const canModerate = targetRole !== undefined && rank[myRole] > rank[targetRole];
    return {
      showChangeCard: editing.card && validUid,
      showChangeTitle: editing.title && validUid,
      showKick: canModerate,
      showMute: canModerate,
      showSetAdmin: canModerate && myRole === 'owner' && targetRole === 'member',
      showUnsetAdmin: canModerate && myRole === 'owner' && targetRole === 'admin',
    };
  }

  /**
   * 右键消息「撤回」的可用性。
   *   - 私聊 / 群聊：自己的消息都显示；群聊里群主 / 管理员对**任何**消息都显示（越级）。
   *   - 2 分钟规则：普通成员只能撤自己 2 分钟内的；群主 / 管理员无视该规则。
   * 返回 `show=false` 表示这项根本不出现；`reason` 非空表示出现但置灰。
   */
  function recallAvailability(message: Message): { show: boolean; reason: string | null } {
    if (!conversation || grayTipOf(message)) {
      return { show: false, reason: null };
    }
    const mine = isSelfIdentity(new Set(selfIdentityValues(user)), message.senderId);
    const elevated = conversation.type === 'group' && conversation.group.role !== 'member';
    if (!mine && !elevated) {
      return { show: false, reason: null };
    }
    if (
      message.source === 'roaming' &&
      !(conversation.type === 'direct' && message.ntSeqVerified === true)
    ) {
      return { show: true, reason: '漫游消息缺少已确认的撤回定位，等待 QQ 同步后重试' };
    }
    if (moderationBlockedReason) {
      return { show: true, reason: moderationBlockedReason };
    }
    const pendingReason = outgoingActionBlockReason(message);
    if (pendingReason) return { show: true, reason: pendingReason };
    const seq = Number((message as { msgSeq?: unknown }).msgSeq);
    if (!Number.isFinite(seq) || seq <= 0) {
      return { show: true, reason: '这条消息缺少会话内序号，无法撤回' };
    }
    if (conversation.type === 'direct') {
      const clientSeq = Number(message.clientSeq);
      const random = Number(message.msgRandom);
      if (
        !Number.isSafeInteger(clientSeq) ||
        clientSeq <= 0 ||
        !Number.isSafeInteger(random) ||
        random < 0 ||
        random > 0xffff_ffff ||
        !Number.isFinite(Date.parse(message.createdAt))
      ) {
        return { show: true, reason: '这条私聊消息缺少完整定位信息，等待 QQ 同步后重试' };
      }
    }
    if (elevated) {
      return { show: true, reason: null };
    }
    const sentAt = Date.parse(message.createdAt);
    if (Number.isFinite(sentAt) && Date.now() - sentAt > 120_000) {
      return { show: true, reason: '超过 2 分钟的消息无法撤回' };
    }
    return { show: true, reason: null };
  }

  /** 撤回一条消息。不做乐观渲染，只把结果 toast 出来，等 QQ 同步翻新会话。 */
  function recallMessageFor(message: Message) {
    setContextMenu(null);
    const current = visibleMessages.find((row) => row.id === message.id);
    if (!current || grayTipOf(current)) return;
    message = current;
    const availability = recallAvailability(message);
    if (!availability.show || availability.reason) return;
    if (!conversation || moderationBlockedReason) {
      return;
    }
    const seq = Number((message as { msgSeq?: unknown }).msgSeq);
    if (!Number.isFinite(seq) || seq <= 0) {
      pushToast({ tone: 'warning', message: '这条消息缺少会话内序号，无法撤回' });
      return;
    }
    const random = Number((message as { msgRandom?: unknown }).msgRandom) || 0;
    const timestamp = Math.floor(Date.parse(message.createdAt) / 1000) || 0;
    const params =
      conversation.type === 'group'
        ? {
            kind: 'group' as const,
            conv: conversation.group.identityValue,
            sequence: seq,
            ...(random > 0 ? { random } : {}),
          }
        : {
            kind: 'c2c' as const,
            conv: conversation.otherUser.id,
            sequence: seq,
            clientSequence: Number(message.clientSeq),
            ...(random > 0 ? { random } : {}),
            ...(timestamp > 0 ? { timestamp } : {}),
          };
    const finish = beginInlineAction(message.id, '正在撤回消息');
    recallMessage.mutate(params, {
      onSettled: finish,
      onError: (error) => {
        pushToast({
          tone: 'error',
          title: '撤回失败',
          detail: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  /**
   * 群管理：改群昵称 / 踢人 —— 弹窗挂在应用层（与群公告 / 群精华同层），
   * 这里只负责解析目标 uid 并上报意图，不再自己开灯箱。
   */
  function startCardEdit(sender: User) {
    setAvatarMenu(null);
    if (conversation?.type !== 'group' || !avatarModerationFlags(sender)?.showChangeCard) {
      return;
    }
    const targetUid = groupTargetUid(sender);
    if (!targetUid) {
      pushToast({ tone: 'warning', message: '拿不到该成员的 uid，无法修改群昵称' });
      return;
    }
    onRenameGroupMember?.(conversation, sender, targetUid);
  }

  function startTitleEdit(sender: User) {
    setAvatarMenu(null);
    if (conversation?.type !== 'group' || conversation.group.role !== 'owner') return;
    const targetUid = groupTargetUid(sender);
    if (!targetUid || !/^u_[A-Za-z0-9_-]+$/.test(targetUid)) {
      pushToast({ tone: 'warning', message: '拿不到该成员的 uid，无法编辑头衔' });
      return;
    }
    onChangeGroupMemberTitle?.(conversation, sender, targetUid);
  }

  function startKick(sender: User) {
    setAvatarMenu(null);
    if (conversation?.type !== 'group') {
      return;
    }
    const targetUid = groupTargetUid(sender);
    if (!targetUid) {
      pushToast({ tone: 'warning', message: '拿不到该成员的 uid，无法踢出' });
      return;
    }
    onKickGroupMember?.(conversation, sender, targetUid);
  }

  /** 群管理：禁言（时长由子菜单给定，秒）。 */
  function muteAvatar(sender: User, durationSeconds: number) {
    setAvatarMenu(null);
    if (conversation?.type !== 'group') {
      return;
    }
    const targetUid = groupTargetUid(sender);
    if (!targetUid) {
      pushToast({ tone: 'warning', message: '拿不到该成员的 uid，无法禁言' });
      return;
    }
    muteGroupMember.mutate(
      {
        groupId: conversation.group.identityValue,
        targetUid,
        duration: durationSeconds,
      },
      {
        onSuccess: () =>
          pushToast({ tone: 'success', message: `已禁言 ${formatMuteDuration(durationSeconds)}` }),
        onError: (error) =>
          pushToast({
            tone: 'error',
            title: '禁言失败',
            detail: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  /** 群管理：设置 / 取消管理员（仅群主）。 */
  function toggleAvatarAdmin(sender: User, enable: boolean) {
    setAvatarMenu(null);
    if (conversation?.type !== 'group') {
      return;
    }
    const targetUid = groupTargetUid(sender);
    if (!targetUid) {
      pushToast({ tone: 'warning', message: '拿不到该成员的 uid，无法设置管理员' });
      return;
    }
    setGroupAdmin.mutate(
      { groupId: conversation.group.identityValue, targetUid, enable },
      {
        onSuccess: () =>
          pushToast({ tone: 'success', message: enable ? '已设为管理员' : '已取消管理员' }),
        onError: (error) =>
          pushToast({
            tone: 'error',
            title: enable ? '设置管理员失败' : '取消管理员失败',
            detail: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  function insertComposerLineBreak() {
    const editor = currentComposerEditor();
    if (!editor) {
      setComposerBody(`${body}\n`);
      return;
    }

    insertComposerNode(editor, document.createElement('br'), composerSelectionRef.current);
    insertComposerNode(editor, document.createTextNode('\u200b'), null);
    syncComposerBody(editor);
  }

  function insertEmoji(item: EmojiItem) {
    if (currentPreference.blocked || sending) {
      return;
    }

    // 使用系统 / 字符表情时写回 QQ 的「最近使用」表（颜文字不算）。
    if (item.kind === 'system') {
      recordRecentEmoji.mutate({
        faceId: Number(item.id) || 0,
        unicode: false,
        sourceType: 0,
      });
    } else if (item.kind === 'unicode' && !item.id.startsWith('kaomoji:')) {
      recordRecentEmoji.mutate({ faceId: 0, unicode: true, extra: item.glyph });
    }

    const mobileEmojiMode = isMobileComposerViewport();

    // 字符 / 颜文字：直接插入字形文本。
    if (!item.src) {
      insertComposerText(item.glyph || item.name);
      if (!mobileEmojiMode) {
        setEmojiOpen(false);
      }
      return;
    }

    const editor = currentComposerEditor();
    if (!editor) {
      setComposerBody(`${body}${createEmojiToken(item)}`);
      return;
    }

    const image = document.createElement('img');
    image.src = item.src;
    image.alt = item.name;
    image.title = item.name;
    image.draggable = false;
    image.dataset.chatToken = createEmojiToken(item);
    image.className = cn(
      item.large
        ? 'composer-token-image composer-sticker-token'
        : 'composer-token-image composer-inline-emoji',
    );

    insertComposerNode(editor, image, composerSelectionRef.current);
    syncComposerBody();
    if (!mobileEmojiMode) {
      setEmojiOpen(false);
    }
  }

  /**
   * 选中一枚超级表情。
   *
   * 大表情只能单独发（跟视频 / 文件同一个约束），所以它不进输入框，而是占住「单独发」
   * 那个槽位：先把已经挂着的视频 / 文件卸掉（预览地址一并释放），再挂上这张卡片，
   * 并把表情 / 语音 / 更多面板收起来。
   */
  function stageSuperEmoji(item: EmojiItem) {
    if (currentPreference.blocked || sending) {
      return;
    }

    // 跟普通表情一样写回 QQ 的「最近使用」表。
    if (item.kind === 'system') {
      recordRecentEmoji.mutate({
        faceId: Number(item.id) || 0,
        unicode: false,
        sourceType: 0,
      });
    }

    setMediaAttachment((current) => {
      if (current) releaseAttachment(current);
      return null;
    });
    // 「单独发」的卡片与引用互斥：挂上卡片就把引用条收起来。
    setPendingQuote(null);
    setPendingSuperEmoji(item);
    setAttachmentError(null);
    setEmojiOpen(false);
    setToolsOpen(false);
    setVoiceOpen(false);
    setArkOpen(false);
    setAiVoiceOpen(false);
    // 移动端长文展开态里没有卡片的位置，选完就把展开态收回去（正文会跟着搬回去）。
    if (mobileComposerExpanded) {
      closeMobileComposerExpanded();
    }
  }

  function removePendingSuperEmoji() {
    setPendingSuperEmoji(null);
    window.requestAnimationFrame(() => focusComposerEnd(composerEditorRef.current));
  }

  /**
   * 右键菜单「引用」：把这条消息挂到输入框上方。
   *
   * 不能引用的消息（系统灰条 / 无 seq）在菜单里已经置灰，这里再兜一层。
   * **嵌套引用是允许的**：引用的消息自己也是引用也行，只是它的 reply 元素会被排掉
   * （见 composerQuote 的 composerQuoteElement / quotePreview），不会嵌到新引用里。
   * 引用条与「只能单独发」的卡片互斥 —— 挂上引用就把卡片卸掉（预览地址一并释放），
   * 反过来卡片顶掉引用见 setMedia / stageSuperEmoji。
   */
  function startQuote(message: Message) {
    if (quoteBlockReason(message)) {
      return;
    }
    const quote = quoteFromMessage(message);
    if (!quote) {
      return;
    }

    setContextMenu(null);
    setMediaAttachment((current) => {
      if (current) releaseAttachment(current);
      return null;
    });
    setPendingSuperEmoji(null);
    setAttachmentError(null);
    setPendingQuote(quote);
    // 引用条要占正文上面那一行，表情 / 语音 / 更多 / 链接面板先收起来。
    setEmojiOpen(false);
    setToolsOpen(false);
    setVoiceOpen(false);
    setArkOpen(false);
    setAiVoiceOpen(false);
    setBounceOpen(false);
    setPokeOpen(false);
    window.requestAnimationFrame(() => focusComposerEnd(composerEditorRef.current));
  }

  function removeQuote() {
    setPendingQuote(null);
    window.requestAnimationFrame(() => focusComposerEnd(composerEditorRef.current));
  }

  /**
   * 发消息。
   *
   * 内联图片本来就在正文里（`serializeComposer` 会把 `<img>` 上的 token 原样取回），
   * 语音 / 视频 / 文件 / 超级表情的 token 在这里续到正文后面（`voiceClipToken` /
   * `attachmentToken` / `createEmojiToken`）—— 素材走的都是草稿里既有的「元素 token」通路。
   *
   * 挂着视频 / 文件 / 超级表情时正文一律不参与本次发送：它们只能单独发，输入框里的
   * 文字原样留着。
   */
  /**
   * 收集本次要发的本地媒体句柄：内联图片 + 挂着的那张「单独发」卡片 + 调用方额外
   * 交进来的（语音条）。key 与 composerSend 的 {@link localKeyOf} 的复算规则对齐。
   *
   * 优先给绝对路径（`webUtils.getPathForFile`）；剪贴板截图这类没有落盘来源的图
   * 读不到路径，回退成字节。
   */
  async function collectLocalMedia(extra: LocalMediaRef[]): Promise<LocalMediaRef[]> {
    const out: LocalMediaRef[] = [...extra];
    const attachments = [...inlineImagesRef.current];
    if (mediaAttachment) attachments.push(mediaAttachment);
    for (const attachment of attachments) {
      const key = attachment.url ?? `${attachment.name}:${attachment.size}`;
      const path = window.weq?.pathForFile?.(attachment.file) ?? '';
      // 预览地址只给乐观渲染用（发完即丢）；拿不到就退回本地路径 / 不预览。
      const previewUrl = attachment.url ?? undefined;
      if (path) {
        out.push({ key, path, name: attachment.name, ...(previewUrl ? { previewUrl } : {}) });
        continue;
      }
      try {
        out.push({
          key,
          bytes: new Uint8Array(await attachment.file.arrayBuffer()),
          name: attachment.name,
          ...(previewUrl ? { previewUrl } : {}),
        });
      } catch {
        // 读不出字节就让上层报缺路径 / 字节，而不是发一条空消息。
      }
    }
    return out;
  }

  async function submitMessage(
    options: {
      extraTokens?: string[];
      text?: string;
      keepBody?: boolean;
      /** 独立发送（链接卡片）：本次不带引用，引用条的清理也在调用方。 */
      omitQuote?: boolean;
      /** 本条第额外本地媒体句柄（如语音条）。 */
      locals?: LocalMediaRef[];
    } = {},
  ) {
    const editor = currentComposerEditor();
    const draftBody = editor ? serializeComposer(editor) : body;
    const nextBody = options.text ?? draftBody;
    const trimmed = nextBody.trim();
    const singleToken = mediaAttachment
      ? attachmentToken(mediaAttachment)
      : pendingSuperEmoji
        ? createEmojiToken(pendingSuperEmoji)
        : null;
    // 引用元素必须排在最前面（与 service 的 buildTextElements 一致）：
    // 它描述的是「本消息在回复哪一条」，不是正文的一部分。
    const quote = options.omitQuote ? null : pendingQuote;
    const tokens = [
      ...(quote ? [composerQuoteToken(quote)] : []),
      ...(singleToken ? [singleToken] : []),
      ...(options.extraTokens ?? []),
    ];
    const text = singleToken ? '' : trimmed;
    if (
      !conversation ||
      (!text && tokens.length === 0) ||
      !sendAvailable ||
      currentPreference.blocked ||
      sending ||
      composerSendRef.current
    ) {
      return;
    }

    const payloadBody = `${text}${tokens.join('')}`;
    const request = { conversationId: conversation.id };
    composerSendRef.current = request;
    const clearsBody = !singleToken && !options.keepBody;
    const sentImages = clearsBody ? [...inlineImagesRef.current] : [];
    const sentReeditUrls = clearsBody ? [...reeditObjectUrlsRef.current] : [];
    let failed = false;
    const initialFocus = document.activeElement;
    const isCurrentComposer = () =>
      mentionConversation.current === request.conversationId &&
      composerEditorRef.current?.isConnected;
    const restoreSendFocus = () => {
      if (!isCurrentComposer() || !composerTabActive.current) return;
      const focused = document.activeElement;
      if (focused === composerEditorRef.current) return;
      if (
        focused !== initialFocus &&
        focused !== editor &&
        focused !== composerEditorRef.current &&
        focused !== expandedComposerEditorRef.current &&
        focused !== document.body
      )
        return;
      focusComposerEnd(composerEditorRef.current);
    };
    const readAfterSend = atLatest && isScrolledToBottom(2);
    if (readAfterSend) requestReadAtBottom();
    readGestureUntil.current = 0;
    setSending(true);
    try {
      // 先捕获媒体句柄；清空后它们归本次发送所有，不能释放仍在读取的预览。
      const localMedia = planNeedsLocalMedia(payloadBody)
        ? collectLocalMedia([...(options.locals ?? []), ...reeditLocalsRef.current])
        : undefined;
      if (clearsBody) {
        inlineImagesRef.current = [];
        reeditLocalsRef.current = [];
        reeditObjectUrlsRef.current = [];
        setComposerBody('');
        onDraftClear(request.conversationId);
        setPendingQuote(null);
        for (const target of [composerEditorRef.current, expandedComposerEditorRef.current]) {
          if (target) target.innerHTML = '';
        }
        composerSelectionRef.current = null;
        setMentionMenu(null);
        resetMobileComposerHeight();
        setMobileComposerExpanded(false);
        setEmojiOpen(false);
        setToolsOpen(false);
      }
      restoreSendFocus();
      window.requestAnimationFrame(restoreSendFocus);
      const locals = localMedia ? await localMedia : undefined;
      await onSend(payloadBody, locals);
      if (!isCurrentComposer()) return;
      if (readAfterSend) requestReadAtBottom();

      // 独立卡片不带走正文；普通发送的正文已交接，回执不能清掉下一条草稿。
      if (singleToken) {
        setMediaAttachment((current) => {
          if (current !== mediaAttachment) return current;
          if (current) releaseAttachment(current);
          return null;
        });
        setPendingSuperEmoji((current) => (current === pendingSuperEmoji ? null : current));
      }
      setVoiceOpen(false);
      setAiVoiceOpen(false);
      setBounceOpen(false);
      setPokeOpen(false);
      if (singleToken || options.keepBody) window.requestAnimationFrame(restoreSendFocus);
    } catch (error) {
      failed = true;
      // 失败只保留消息上的重新编辑入口，不回填或覆盖下一条草稿。
      for (const url of [...sentImages.map((image) => image.url), ...sentReeditUrls]) {
        if (!url) continue;
        if (composerEditorRef.current) retainedSendUrlsRef.current.add(url);
        else URL.revokeObjectURL(url);
      }
      console.error('[composer] send failed:', error);
    } finally {
      if (!failed) for (const image of sentImages) releaseAttachment(image);
      if (!failed) for (const url of sentReeditUrls) URL.revokeObjectURL(url);
      if (composerSendRef.current === request) {
        composerSendRef.current = null;
        setSending(false);
      }
    }
  }

  /** 语音面板「发送」：语音本身编成 ptt 元素 token；本地 blob 作为字节一并交出。 */
  async function sendVoiceClip(clip: VoiceClip) {
    const locals: LocalMediaRef[] = [];
    if (clip.blob) {
      try {
        const bytes = new Uint8Array(await clip.blob.arrayBuffer());
        locals.push({
          key: `voice-${clip.id}.silk`,
          bytes,
          name: `voice-${clip.id}.silk`,
          // 乐观渲染：直接放录音 blob（浏览器放得了 webm/opus），并用采样峰值画波形。
          ...(clip.url ? { previewUrl: clip.url } : {}),
          ...(clip.levels.length > 0
            ? { waveform: clip.levels.map((level) => Math.round(level * 255)) }
            : {}),
        });
      } catch {
        // 读不出字节时让上层报错（不静默丢语音）。
      }
    }
    await submitMessage({ extraTokens: [voiceClipToken(clip)], locals });
  }

  /**
   * 语音面板「选择音频」：把一个本机音频文件当语音条发。
   *
   * 字节原样交给 {@link sendVoiceClip} —— 它会把 blob 读成 bytes 塞进 ptt 元素的
   * 本地句柄，主链路的 `decodeRecordingToWav` 再用 WebAudio 解码（mp3 / m4a / ogg…
   * 浏览器能解的都能收），所以内置了一个格式转换器、不需要 ffmpeg。
   */
  async function sendAudioFile(bytes: Uint8Array, _fileName: string) {
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const clip: VoiceClip = {
      id: createMediaId('audio'),
      source: 'record',
      url,
      blob,
      durationMs: 0,
      levels: [],
      transcript: '',
    };
    try {
      await sendVoiceClip(clip);
    } finally {
      // 乐观预览的 blob 要留到发送完成后再释放。
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  }

  /** 语音面板「发送文字」：只把识别 / 合成的文字发出去。 */
  async function sendTranscriptText(text: string) {
    if (!text) return;
    await submitMessage({ text });
  }

  /**
   * Ark 卡片面板「发送」：面板已经收好了卡片（五类各有各的校验），这里只把
   * **当前会话**一起交给应用层（`onSendArk`），由它补 peerType / targetId 再走 IPC。
   *
   * 不走输入框那条「元素 token」通路是有意的：推荐好友 / 推荐群 / 位置卡片根本编不
   * 成草稿元素（取卡与位置卡片是两条独立协议），让「图文 / 自定义 JSON」也走同一条
   * 路，五类卡片的行为才一致。
   *
   * 与旧的链接卡片一致：卡片是**独立的一条消息**，输入框里的文字原样留着；发送失败
   * 会抛出来，面板负责显示原因并保留已填内容。
   */
  /**
   * 闪传文件框「确认 → 发送」：单独一条消息（顶掉挂着的引用），失败原样抛给面板。
   *
   * 与 Ark 卡片一样，闪传编不成输入框的元素 token（它是 fileset，不是 richText 元素），
   * 所以走「面板 → 应用层 → IPC」这条独立通路。
   */
  async function sendFlashTransfer(payload: FlashSendPayload): Promise<void> {
    if (!conversation || conversation.type === 'merged' || !onSendFlash) {
      throw new Error('这个会话不支持发送闪传。');
    }
    setPendingQuote(null);
    await onSendFlash(conversation, payload);
  }

  async function sendArkCard(payload: ArkPayload) {
    if (!conversation || conversation.type === 'merged' || !onSendArk) {
      throw new Error('这个会话不支持发送 Ark 卡片。');
    }
    // 卡片只能单独发：它顶掉挂着的引用（跟视频 / 文件同一套互斥）。
    setPendingQuote(null);
    await onSendArk(conversation, payload);
    setArkOpen(false);
  }

  /**
   * 红包面板「发红包」：把当前会话与草稿交给应用层，由它补目标走 IPC 下单出码。
   *
   * 成功才关面板 —— 下单失败（服务端拒绝 / 未在线）就保留面板与已填内容，错误由
   * 应用层 toast 出来（与 ark / 闪传同一套）。
   */
  async function sendRedPacket(draft: RedPacketDraft): Promise<void> {
    if (!conversation || conversation.type === 'merged' || !onSendRedPacket) {
      throw new Error('这个会话不支持发红包。');
    }
    setPendingQuote(null);
    await onSendRedPacket(conversation, draft);
    setRedPacketOpen(false);
  }

  /**
   * AI 声聊面板「合成并发送」：这条语音**只能单独发** —— 不带输入框里的文字、
   * 也不带挂着的引用（跟视频 / 文件那套「单独发」同一套互斥）。
   *
   * 只做前端：这里不碰任何协议（`SendAiVoice` 那条 OIDB 还没接进来），只把
   * 「文字 + 声线」编成一枚 ptt 元素 token 交给上层；`keepBody` 让用户正在打的
   * 那段字原样留在输入框里。
   */
  async function sendAiVoice(draft: AiVoiceDraft) {
    setAiVoiceOpen(false);
    setPendingQuote(null);
    await submitMessage({
      extraTokens: [aiVoiceToken(draft)],
      text: '',
      keepBody: true,
      omitQuote: true,
    });
  }

  /**
   * 弹射表情面板「发射」：一枚 `emojiBounce` 元素编成 token 走既有的 `extraTokens`
   * 通路（跟链接卡片 / 语音同一条）。弹射是**独立的一条消息** —— 不带输入框里的
   * 文字、不带挂着的引用，`keepBody` 让用户正在打的字原样留着。
   *
   * 只做前端：这里不碰任何协议，真正下发由上层 `onSend` 决定（没接上会报错，
   * 输入框里的内容不会丢）。
   */
  async function sendBounceEmoji(draft: BounceEmojiDraft) {
    setBounceOpen(false);
    setPokeOpen(false);
    setPendingQuote(null);
    // 跟普通表情一样写回 QQ 的「最近使用」表（失败不影响发送）。
    recordRecentEmoji.mutate({ faceId: draft.faceId, unicode: false, sourceType: 0 });
    await submitMessage({
      extraTokens: [bounceEmojiToken(draft)],
      text: '',
      keepBody: true,
      omitQuote: true,
    });
  }

  /**
   * 戳一戳面板「戳一下」：一枚 `pokeEmoji` 元素编成 token 走既有的 `extraTokens`
   * 通路（跟弹射表情 / 语音同一条）。戳一戳是**独立的一条消息** —— 不带输入框里的
   * 文字、不带挂着的引用，`keepBody` 让用户正在打的字原样留着。群聊 / 私聊都能发。
   *
   * 只做前端：这里不碰任何协议，真正下发由上层 `onSend` 决定。
   */
  async function sendPokeEmoji(draft: PokeEmojiDraft) {
    setPokeOpen(false);
    setBounceOpen(false);
    setPendingQuote(null);
    await submitMessage({
      extraTokens: [pokeEmojiToken(draft)],
      text: '',
      keepBody: true,
      omitQuote: true,
    });
  }

  /**
   * 随机表情面板「发送」：把「faceId + 目录三件套 + innerId」编成一枚 face 元素
   * token（superSticker.resultId = innerId），同样走 `extraTokens` 单独成一条消息。
   * 收端/乐观渲染都会播 `lottie/<faceId>_<innerId>.json` 那个结果片段。
   */
  async function sendRandomFace(draft: RandomFaceDraft) {
    setPokeOpen(false);
    setBounceOpen(false);
    setPendingQuote(null);
    await submitMessage({
      extraTokens: [randomFaceToken(draft)],
      text: '',
      keepBody: true,
      omitQuote: true,
    });
  }

  /**
   * 私聊「窗口抖动」：点一下直接发一条独立消息，输入框里的正文、草稿、挂着的引用
   * 都不动。真正的下发走 `onSendWindowShake`（应用层直接接 protocol 的
   * `commonElem serviceType=2`），这里只负责置忙态、失败时报错。
   */
  async function sendWindowShake() {
    if (conversation?.type !== 'direct' || !onSendWindowShake) return;
    if (!sendAvailable || currentPreference.blocked || sending) return;

    setSending(true);
    try {
      await onSendWindowShake(conversation);
    } catch (error) {
      // 应用层已经弹过提示，这里只留一条控制台记录（与 submitMessage 的失败路径一致）。
      console.error('[composer] window shake failed:', error);
    } finally {
      setSending(false);
      window.requestAnimationFrame(() => focusComposerEnd(currentComposerEditor()));
    }
  }

  /**
   * 光标移动后补扫 @ 触发词（清掉 / 挪动已经失效的菜单）。
   *
   * 内容变化的按键不用走这里 —— `onInput` 的 `syncComposerBody` 已经扫过一遍。
   * 但「只挪光标」的按键不产生 input 事件，菜单会滞留在原处，所以单独补一次。
   */
  function rescanMentionOnKeyUp(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    if (!MENTION_RESCAN_KEYS.has(event.key)) return;
    // 用事件源而不是 currentComposerEditor()：桌面的窄输入框与移动端展开态是两个
    // 编辑器，按「当前该用哪个」去猜会在切换瞬间扫错对象。
    saveComposerSelection(event.currentTarget);
    updateMentionMenu(event.currentTarget);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.currentTarget.ownerDocument.querySelector('.weq-lightbox-layer')) {
      event.preventDefault();
      return;
    }
    if (event.nativeEvent.isComposing || event.key === 'Process') {
      return;
    }

    if (mentionMenu) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionMenu((current) => {
          if (!current || current.members.length === 0) {
            return current;
          }
          const offset = event.key === 'ArrowDown' ? 1 : -1;
          return {
            ...current,
            activeIndex: nextMentionIndex(
              current.members,
              current.activeIndex,
              offset,
              atAllMention.selectable,
            ),
          };
        });
        return;
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const selected = mentionMenu.members[mentionMenu.activeIndex];
        const member =
          selected?.id === 'all' && !atAllMention.selectable
            ? mentionMenu.members[
                nextMentionIndex(mentionMenu.members, mentionMenu.activeIndex, 1, false)
              ]
            : selected;
        if (member) {
          insertMention(member);
        }
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionMenu(null);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // 移动端长文展开、以及 QQ 未注入（发送按钮灰着）时，回车只当换行用，
      // 不能落到 submitMessage 上去。
      if (mobileComposerExpanded || !sendAvailable) {
        insertComposerLineBreak();
        return;
      }
      void submitMessage();
    }
  }

  function handleComposerPaste(event: ReactClipboardEvent<HTMLDivElement>) {
    // 剪贴板里带文件（截图 / 复制的图片）就吃进来：图片直接内联插进输入框，
    // 视频 / 文件挂成待发送的单独卡片。其余情况当纯文本贴。
    const files = clipboardFiles(event.clipboardData);
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
      return;
    }
    event.preventDefault();
    const structured = readMentionClipboard(event.clipboardData.getData('text/html'));
    if (structured && onResolveMentions && conversation) {
      const editor = event.currentTarget;
      const savedRange = composerSelectionRef.current?.cloneRange() ?? null;
      const currentConversation = conversation;
      void onResolveMentions(structured, currentConversation)
        .then((resolved) => {
          if (
            !editor.isConnected ||
            currentComposerEditor() !== editor ||
            mentionConversation.current !== currentConversation.id
          )
            return;
          const holder = document.createElement('div');
          restoreComposer(
            holder,
            elementsToComposerText(
              resolved.map((element) => ({ ...element.data, kind: element.type })),
            ),
          );
          const fragment = document.createDocumentFragment();
          fragment.append(...holder.childNodes);
          if (savedRange && editor.contains(savedRange.startContainer)) {
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(savedRange);
          }
          insertComposerNode(editor, fragment, savedRange);
          syncComposerBody(editor);
        })
        .catch((error) =>
          pushToast({
            tone: 'error',
            message: '粘贴提及失败',
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      return;
    }
    insertComposerText(event.clipboardData.getData('text/plain'));
  }

  // ── 图片（内联进输入框）/ 视频、文件（单独发）────────────────────────────

  /**
   * 图片像表情一样直接插进输入框：一个 `<img data-chat-token>`，token 里装着可无损
   * 还原的 pic 元素。发送时 `serializeComposer` 会把它取回，跟草稿里其它元素同一条通路。
   */
  function insertInlineImage(attachment: ComposerAttachment) {
    const editor = currentComposerEditor();
    if (!editor || !attachment.url) {
      return;
    }

    const image = document.createElement('img');
    image.src = attachment.url;
    image.alt = attachment.name;
    image.title = `${attachment.name}（${formatFileSize(attachment.size)}）`;
    image.draggable = false;
    image.dataset.chatToken = attachmentToken(attachment);
    image.className = cn('composer-token-image composer-inline-attachment');

    insertComposerNode(editor, image, composerSelectionRef.current);
    syncComposerBody(editor);
  }

  /**
   * 视频 / 文件只能挂一个：新的顶掉旧的，旧预览地址释放。挂上它也会顶掉挂着的
   * 超级表情 —— 「单独发」这个槽位一次只放一个。
   */
  function setMedia(attachment: ComposerAttachment) {
    setMediaAttachment((current) => {
      if (current && current.id !== attachment.id) releaseAttachment(current);
      return attachment;
    });
    setPendingSuperEmoji(null);
    // 同上：视频 / 文件顶掉引用；也顺手收掉 AI 声聊 / 弹射面板（同样占「单独发」槽位）。
    setPendingQuote(null);
    setAiVoiceOpen(false);
    setBounceOpen(false);
    setPokeOpen(false);
  }

  function removeMediaAttachment() {
    setMediaAttachment((current) => {
      if (current) releaseAttachment(current);
      return null;
    });
    setAttachmentError(null);
    window.requestAnimationFrame(() => focusComposerEnd(composerEditorRef.current));
  }

  async function addFiles(files: File[]) {
    if (files.length === 0 || currentPreference.blocked || sending) {
      return;
    }

    const oversized: string[] = [];
    const usable = files.filter((file) => {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        oversized.push(file.name);
        return false;
      }
      return true;
    });
    if (usable.length === 0) {
      setAttachmentError(`${oversized[0] ?? '文件'} 超过 100MB，已跳过`);
      return;
    }

    const images = usable.filter(isImageFile);
    const media = usable.filter((file) => !isImageFile(file));

    if (media.length === 0 && (mediaAttachment || pendingSuperEmoji)) {
      setAttachmentError(
        pendingSuperEmoji
          ? '超级表情只能单独发，先移除卡片再插图片'
          : '视频 / 文件只能单独发，先移除卡片再插图片',
      );
      return;
    }

    if (media.length > 0) {
      // 视频 / 文件只能单独发：优先挂上它，同一批里的图片这次就不收了。
      setMedia(await createAttachment(media[0]));
      // 表情 / 语音 / 更多 / 链接面板跟卡片互斥，一并收起来。
      setEmojiOpen(false);
      setToolsOpen(false);
      setVoiceOpen(false);
      setArkOpen(false);
      setBounceOpen(false);
      setPokeOpen(false);
      setAttachmentError(
        media.length > 1
          ? '视频 / 文件只能单独发送，只保留了第一个'
          : images.length > 0
            ? '视频 / 文件不能和图片一起发，图片已忽略'
            : oversized.length > 0
              ? `${oversized[0]} 超过 100MB，已跳过`
              : null,
      );
      return;
    }

    const room = MAX_COMPOSER_ATTACHMENTS - inlineImagesRef.current.length;
    if (room <= 0) {
      setAttachmentError(`最多只能插 ${MAX_COMPOSER_ATTACHMENTS} 张图片`);
      return;
    }

    const created = await createAttachments(images.slice(0, room));
    inlineImagesRef.current = [...inlineImagesRef.current, ...created];
    for (const item of created) {
      insertInlineImage(item);
    }
    setAttachmentError(
      oversized.length > 0
        ? `${oversized[0]} 超过 100MB，已跳过`
        : images.length > room
          ? `最多只能插 ${MAX_COMPOSER_ATTACHMENTS} 张图片，多余的已忽略`
          : null,
    );
  }

  function openMediaPicker(kind: 'image' | 'file') {
    if (currentPreference.blocked || sending) {
      return;
    }
    (kind === 'image' ? imageInputRef : fileInputRef).current?.click();
  }

  function handleMediaPickerChange(event: ReactChangeEvent<HTMLInputElement>) {
    const files = collectFiles(event.target.files);
    // 清空 value：同一个文件再选一次也要能触发 change。
    event.target.value = '';
    void addFiles(files);
  }

  // ── 拖拽投递 ──────────────────────────────────────────────────────────────

  function handleComposerDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) {
      return;
    }
    // 闪传文件框开着时拖拽归它（见 FlashComposer 里挂在 .composer 上的捕获监听）：
    // 这里让开，否则整块输入区会亮起「松开即可添加」的纱，让人以为会铺成一张单独发的卡。
    if (flashOpen) {
      setDropActive(false);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!dropActive) setDropActive(true);
  }

  function handleComposerDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    // 在输入区内部移动时 relatedTarget 仍在容器里，不算离开。
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) {
      return;
    }
    setDropActive(false);
  }

  function handleComposerDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) {
      return;
    }
    // 闪传文件框开着时落点归它（同上）。这里只吃掉这次事件 —— 不 preventDefault
    // 的话浏览器会直接打开这个文件，那是更糟的结果。
    if (flashOpen) {
      event.preventDefault();
      setDropActive(false);
      return;
    }
    event.preventDefault();
    setDropActive(false);
    void addFiles(clipboardFiles(event.dataTransfer));
  }

  function updateMentionMenu(editor = currentComposerEditor()) {
    const request = ++mentionRequest.current;
    if (!editor || conversation?.type !== 'group') {
      setMentionMenu(null);
      return;
    }

    const trigger = getActiveComposerMentionTrigger(editor, composerSelectionRef.current);
    if (!trigger) {
      setMentionMenu(null);
      return;
    }

    const members = filterMentionMembers(conversation, trigger.query, user.id);
    setMentionMenu((current) => ({
      query: trigger.query,
      members,
      activeIndex:
        current?.query === trigger.query ? Math.min(current.activeIndex, members.length - 1) : 0,
    }));
    if (trigger.query && onSearchMentionMembers) {
      const context = conversation;
      void onSearchMentionMembers(trigger.query, context)
        .then((found) => {
          if (request !== mentionRequest.current || mentionConversation.current !== context.id)
            return;
          const merged = [
            ...new Map([...members, ...found].map((member) => [member.id, member])).values(),
          ];
          setMentionMenu((current) =>
            current?.query === trigger.query
              ? { ...current, members: merged, activeIndex: 0 }
              : current,
          );
        })
        .catch(() => {
          /* 本地已加载成员仍可选，远端失败不替换为猜测结果。 */
        });
    }
  }

  function openMessageMenu(event: ReactMouseEvent, message: Message) {
    event.preventDefault();
    const selection = window.getSelection();
    const quote = event.target instanceof Element ? event.target.closest('.qq-reply-quote') : null;
    const selected =
      selection?.rangeCount && selection.getRangeAt(0).intersectsNode(event.currentTarget)
        ? selectedMessageClipboard(event.currentTarget.closest('.chat-pane'))
        : null;
    const clipboard = selected ?? (quote ? messageNodeClipboard(quote) : undefined);
    if (window.matchMedia('(max-width: 760px)').matches) {
      const rect = event.currentTarget.getBoundingClientRect();
      openMobileMessageMenu(
        {
          x: rect.left + rect.width / 2,
          y: rect.bottom,
        },
        message,
        clipboard,
      );
      return;
    }
    window.getSelection()?.removeAllRanges();
    // Record where the click landed inside the message row so the menu can
    // track that row as the list scrolls (see the reposition effect below).
    const anchorEl = (event.currentTarget as HTMLElement).closest?.(
      '[data-message-id]',
    ) as HTMLElement | null;
    const anchorRect = anchorEl?.getBoundingClientRect();
    const imageUrl =
      event.target instanceof HTMLImageElement
        ? event.target.currentSrc || event.target.src
        : pureImageUrl(message);
    setContextMenu({
      message,
      imageUrl,
      clipboard,
      downloadUrl:
        (event.target instanceof HTMLImageElement
          ? event.target.currentSrc || event.target.src
          : undefined) || getMessageDownloadUrl(message),
      x: Math.min(event.clientX, window.innerWidth - 126),
      y: Math.min(event.clientY, window.innerHeight - 84),
      variant: 'desktop',
      anchorOffsetX: anchorRect ? event.clientX - anchorRect.left : undefined,
      anchorOffsetY: anchorRect ? event.clientY - anchorRect.top : undefined,
    });
  }

  function openMobileMessageMenu(
    point: { x: number; y: number },
    message: Message,
    clipboard?: { text: string; html: string },
  ) {
    const menuHalfWidth = 112;
    const maxTop = Math.max(92, window.innerHeight - 166);
    setContextMenu({
      message,
      imageUrl: pureImageUrl(message),
      clipboard,
      downloadUrl: getMessageDownloadUrl(message),
      x: Math.min(Math.max(point.x, menuHalfWidth), window.innerWidth - menuHalfWidth),
      y: Math.min(Math.max(point.y + 10, 92), maxTop),
      variant: 'mobile',
    });
  }

  /** 进入多选：右键「多选」→ 选中该条并切到多选模式。 */
  function enterSelection(message: Message) {
    setContextMenu(null);
    setDecorationCard(null);
    window.getSelection()?.removeAllRanges();
    setSelectionMode(true);
    selection.messageCache.set(message.id, message);
    setSelectedIds(new Set([message.id]));
    selectionAnchor.current = message.id;
  }

  function toggleSelectMessage(message: Message, event?: ReactMouseEvent) {
    window.getSelection()?.removeAllRanges();
    multi.toggle(message.id, event);
  }

  function exitSelection() {
    selectionFlow.cancel();
    setSelectionMode(false);
    selectionAnchor.current = null;
  }

  async function mergeForwardSelected() {
    if (!conversation || selectionBlockedReason || !selectedIds.size) {
      return;
    }
    const picked = await selectionFlow.prepare('合并转发');
    if (!picked?.length) return;
    exitSelection();
    onMergeForward?.(picked, conversation);
  }

  async function forwardSelected() {
    const picked = await selectionFlow.prepare('逐条转发');
    if (picked?.length) onForwardMessages?.(picked, conversation);
  }

  async function addSelectedToComposition() {
    const picked = await selectionFlow.prepare('添加到素材库');
    if (picked?.length) onAddToComposition?.(picked);
  }

  function deleteSelectedMessages() {
    requestBatchAction('delete');
  }

  async function copySelectedMessagesJson() {
    if (selectionBlockedReason) {
      pushToast({ tone: 'warning', title: selectionBlockedReason });
      return;
    }
    const picked = await selectionFlow.prepare('复制');
    if (!picked?.length) return;
    const payload = picked.map((message) => {
      const sender = resolveMessageSender(message, conversation as Conversation, user);
      const decoration = (message as { decoration?: unknown }).decoration ?? null;
      const qqElements = (message as { qqElements?: unknown }).qqElements ?? null;
      return {
        msgId: message.msgId ?? message.id,
        senderId: message.senderId,
        senderUin: sender.identityValue,
        senderName: displayUserName(sender),
        createdAt: message.createdAt,
        body: message.body,
        decoration,
        elements: qqElements,
      };
    });
    void copyTextToClipboard(JSON.stringify(payload, null, 2));
  }

  function updateComposerHeight(height: number) {
    setComposerHeight(height);
    saveLayoutNumber(composerHeightStorageKey, height);
  }

  function setComposerBody(value: string) {
    bodyRef.current = value;
    setBody(value);
    if (conversation) {
      onDraftChange(conversation.id, value);
    }
  }

  async function reeditMessage(message: Message): Promise<boolean> {
    if (
      !conversation ||
      message.conversationId !== conversation.id ||
      message.senderId !== user.id ||
      sending
    )
      return false;
    const sourceConversation = conversation.id;
    const editor = currentComposerEditor();
    const previous = editor ? serializeComposer(editor) : bodyRef.current;
    const attachment = mediaAttachmentRef.current;
    if (previous.trim() || attachment || pendingSuperEmoji || pendingQuote) {
      const replace = await useDialog
        .getState()
        .confirm('替换当前草稿？', '输入框已有内容，重新编辑将替换当前草稿。', {
          okLabel: '替换并编辑',
          cancelLabel: '保留草稿',
        });
      if (!replace) return false;
    }
    const unchanged = () => {
      const currentEditor = currentComposerEditor();
      return !(
        mentionConversation.current !== sourceConversation ||
        !composerTabActive.current ||
        !currentEditor?.isConnected ||
        serializeComposer(currentEditor) !== previous ||
        mediaAttachmentRef.current !== attachment ||
        composerSendRef.current !== null
      );
    };
    if (!unchanged()) return false;
    reeditAbortRef.current?.abort();
    const controller = new AbortController();
    reeditAbortRef.current = controller;
    let prepared: Awaited<ReturnType<typeof prepareReeditDraft>>;
    try {
      prepared = await prepareReeditDraft(message, messageElements(message), controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && unchanged())
        pushToast({
          tone: 'error',
          message: '重新编辑失败，当前草稿已保留',
          detail: error instanceof Error ? error.message : String(error),
        });
      return false;
    }
    if (controller.signal.aborted || !unchanged()) {
      for (const url of prepared.objectUrls) URL.revokeObjectURL(url);
      return false;
    }
    const text = prepared.body;
    if (!text) {
      for (const url of prepared.objectUrls) URL.revokeObjectURL(url);
      return false;
    }
    releaseInlineImages();
    setMediaAttachment((current) => {
      if (current) releaseAttachment(current);
      return null;
    });
    setPendingSuperEmoji(null);
    setPendingQuote(null);
    reeditLocalsRef.current = prepared.locals;
    reeditObjectUrlsRef.current = prepared.objectUrls;
    setComposerBody(text);
    for (const target of [composerEditorRef.current, expandedComposerEditorRef.current]) {
      if (target) restoreComposer(target, text);
    }
    composerSelectionRef.current = null;
    setMobileComposerExpanded(false);
    setEmojiOpen(false);
    setToolsOpen(false);
    setVoiceOpen(false);
    setAiVoiceOpen(false);
    setBounceOpen(false);
    setPokeOpen(false);
    scheduleMobileComposerMeasure();
    window.requestAnimationFrame(() => {
      if (mentionConversation.current === sourceConversation && composerTabActive.current)
        focusComposerEnd(composerEditorRef.current);
    });
    return true;
  }

  function scheduleMobileComposerMeasure(editor = composerEditorRef.current) {
    if (!editor) {
      return;
    }
    // 这套「最多 4 行自动增高」只有小屏在用（高度由 --mobile-composer-editor-height
    // 驱动）。桌面端的输入框高度是固定的 --composer-height，量了也不会被消费 ——
    // 之前每敲一个字都白跑一次 cloneNode + 强制 reflow，是输入卡顿的主要来源。
    if (!isMobileComposerViewport()) {
      return;
    }

    window.requestAnimationFrame(() => {
      const styles = window.getComputedStyle(editor);
      const lineHeight = Number.parseFloat(styles.lineHeight) || 22;
      const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
      const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
      const minHeight = Math.ceil(lineHeight + paddingTop + paddingBottom);
      const maxHeight = Math.ceil(lineHeight * mobileComposerMaxLines + paddingTop + paddingBottom);
      const contentHeight = serializeComposer(editor).trim()
        ? measureComposerContentHeight(editor)
        : minHeight;
      const nextHeight = Math.min(Math.max(contentHeight, minHeight), maxHeight);
      const nextLong = contentHeight >= maxHeight - 1;

      setMobileComposerEditorHeight((current) => (current === nextHeight ? current : nextHeight));
      setMobileComposerLong((current) => (current === nextLong ? current : nextLong));
    });
  }
  scheduleMobileComposerMeasureRef.current = scheduleMobileComposerMeasure;

  function measureComposerContentHeight(editor: HTMLDivElement) {
    const rect = editor.getBoundingClientRect();
    const clone = editor.cloneNode(true) as HTMLDivElement;

    clone.contentEditable = 'false';
    clone.removeAttribute('id');
    clone.style.position = 'fixed';
    clone.style.left = '-10000px';
    clone.style.top = '0';
    clone.style.zIndex = '-1';
    clone.style.visibility = 'hidden';
    clone.style.pointerEvents = 'none';
    clone.style.width = `${Math.max(1, rect.width)}px`;
    clone.style.height = 'auto';
    clone.style.minHeight = '0';
    clone.style.maxHeight = 'none';
    clone.style.overflow = 'visible';

    document.body.appendChild(clone);
    const height = Math.ceil(clone.scrollHeight);
    clone.remove();
    return height;
  }

  function resetMobileComposerHeight() {
    setMobileComposerEditorHeight(42);
    setMobileComposerLong(false);
  }

  function openMobileComposerExpanded() {
    setContextMenu(null);
    setToolsOpen(false);
    setEmojiOpen(false);
    setArkOpen(false);
    setAiVoiceOpen(false);
    setBounceOpen(false);
    setPokeOpen(false);
    setMobileComposerExpanded(true);
  }

  function toggleEmojiPanel() {
    setContextMenu(null);
    setToolsOpen(false);
    setVoiceOpen(false);
    setArkOpen(false);
    setAiVoiceOpen(false);
    setBounceOpen(false);
    setPokeOpen(false);
    setEmojiOpen((open) => (toolsOpen ? true : !open));
  }

  function toggleToolsPanel() {
    setContextMenu(null);
    setEmojiOpen(false);
    setVoiceOpen(false);
    setArkOpen(false);
    setAiVoiceOpen(false);
    setBounceOpen(false);
    setPokeOpen(false);
    setToolsOpen((open) => (emojiOpen ? true : !open));
  }

  function toggleVoicePanel() {
    setContextMenu(null);
    setEmojiOpen(false);
    setToolsOpen(false);
    setArkOpen(false);
    setAiVoiceOpen(false);
    setBounceOpen(false);
    setPokeOpen(false);
    setVoiceOpen((open) => !open);
  }

  function toggleArkPanel() {
    setContextMenu(null);
    setEmojiOpen(false);
    setToolsOpen(false);
    setVoiceOpen(false);
    setAiVoiceOpen(false);
    setBounceOpen(false);
    setPokeOpen(false);
    setFlashOpen(false);
    setArkOpen((open) => !open);
  }

  /**
   * 闪传文件框：与其余面板互斥，同一时刻只开一个。
   */
  function toggleFlashPanel() {
    setContextMenu(null);
    setEmojiOpen(false);
    setToolsOpen(false);
    setVoiceOpen(false);
    setArkOpen(false);
    setAiVoiceOpen(false);
    setBounceOpen(false);
    setPokeOpen(false);
    setFlashOpen((open) => !open);
  }

  /** AI 声聊面板（仅群聊）：和其余面板互斥，同一时刻只开一个。 */
  function toggleAiVoicePanel() {
    setContextMenu(null);
    setEmojiOpen(false);
    setToolsOpen(false);
    setVoiceOpen(false);
    setArkOpen(false);
    setBounceOpen(false);
    setPokeOpen(false);
    setAiVoiceOpen((open) => !open);
  }

  /** 弹射表情面板：和其余面板互斥；「只做面板」，发射走既有元素通路。 */
  function toggleBouncePanel() {
    setContextMenu(null);
    setEmojiOpen(false);
    setToolsOpen(false);
    setVoiceOpen(false);
    setArkOpen(false);
    setAiVoiceOpen(false);
    setPokeOpen(false);
    setBounceOpen((open) => !open);
  }

  /** 戳一戳面板：和其余面板互斥；「只做面板」，戳出去走既有元素通路。 */
  function togglePokePanel() {
    setContextMenu(null);
    setEmojiOpen(false);
    setToolsOpen(false);
    setVoiceOpen(false);
    setArkOpen(false);
    setAiVoiceOpen(false);
    setBounceOpen(false);
    setPokeOpen((open) => !open);
  }

  /** 红包面板：和其余面板互斥；下单出码在应用层，成功后弹二维码灯箱。 */
  function toggleRedPacketPanel() {
    setContextMenu(null);
    setEmojiOpen(false);
    setToolsOpen(false);
    setVoiceOpen(false);
    setArkOpen(false);
    setAiVoiceOpen(false);
    setBounceOpen(false);
    setPokeOpen(false);
    setRedPacketOpen((open) => !open);
  }

  const handleVoiceBusyChange = useCallback((busy: boolean) => {
    voiceBusyRef.current = busy;
  }, []);

  function closeMobileComposerExpanded() {
    const editor = expandedComposerEditorRef.current;
    const nextBody = editor ? serializeComposer(editor) : body;
    setComposerBody(nextBody);
    setMobileComposerExpanded(false);
    setEmojiOpen(false);

    window.requestAnimationFrame(() => {
      const compactEditor = composerEditorRef.current;
      if (!compactEditor) {
        return;
      }
      restoreComposer(compactEditor, nextBody);
      scheduleMobileComposerMeasure(compactEditor);
      focusComposerEnd(compactEditor);
    });
  }

  function scrollMessagesToBottom() {
    const scroll = messageScrollRef.current;
    if (!scroll) {
      return;
    }
    readGestureUntil.current = 0;
    scroll.scrollTop = scroll.scrollHeight;
    atBottomRef.current = true;
    setNewMessagePill(0);
  }
  scrollMessagesToBottomRef.current = scrollMessagesToBottom;

  async function jumpToBottomAndRead() {
    if (jumpingToLatest) return;
    if (!atLatest) {
      if (!onJumpToLatest) return;
      setJumpingToLatest(true);
      try {
        if (!(await onJumpToLatest())) return;
        // 等最新窗口提交后再定位；失败时保留提示，供用户重试。
        window.requestAnimationFrame(() => {
          const current = readContextRef.current;
          if (
            current.conversation?.id !== conversation?.id ||
            !current.atLatest ||
            !current.tabActive
          )
            return;
          scrollMessagesToBottomRef.current();
          requestReadAtBottom();
        });
      } finally {
        setJumpingToLatest(false);
      }
      return;
    }
    scrollMessagesToBottom();
    // 显式跳转后再按最新窗口/账号/可见性守卫发已读，不依赖后续滚动事件。
    requestReadAtBottom();
  }

  function isScrolledToBottom(tolerance = 48) {
    const scroll = messageScrollRef.current;
    if (!scroll) {
      return true;
    }
    // Tolerance covers sub-pixel rounding and short content.
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= tolerance;
  }

  function requestReadAtBottom() {
    const current = readContextRef.current;
    if (
      !current.onReadCurrentConversation ||
      !current.conversation ||
      current.conversation.id !== conversation?.id ||
      !current.tabActive ||
      !current.atLatest ||
      current.loading ||
      !messageScrollRef.current ||
      document.visibilityState === 'hidden' ||
      !isScrolledToBottom(2)
    )
      return;
    const key = `${current.conversation.id}:${current.conversation.updatedAt}:${current.conversation.unreadCount}:${current.lastId}`;
    const now = performance.now();
    if (lastReadSignal.current.key === key && now - lastReadSignal.current.at < 300) return;
    lastReadSignal.current = { key, at: now };
    current.onReadCurrentConversation(current.conversation);
  }

  function handleReadGesture(event: { target: EventTarget | null }) {
    if (event.target instanceof Element && event.target.closest('.message-scroll'))
      readGestureUntil.current = performance.now() + 1000;
    requestReadAtBottom();
  }

  function handleMessageScroll() {
    const bottom = isScrolledToBottom();
    atBottomRef.current = bottom;
    if (bottom && readGestureUntil.current > performance.now()) requestReadAtBottom();
    if (bottom && atLatest && newMessagePill > 0) {
      setNewMessagePill(0);
    }

    if (!unreadJump || unreadScrollFrameRef.current !== null) {
      return;
    }

    unreadScrollFrameRef.current = window.requestAnimationFrame(() => {
      unreadScrollFrameRef.current = null;
      updateUnreadJumpRemaining();
    });
  }

  function updateUnreadJumpRemaining() {
    const scroll = messageScrollRef.current;
    if (!scroll || !unreadJump) {
      return;
    }

    const firstUnread = unreadMessageElements(unreadJump)[0];
    if (!firstUnread) {
      setUnreadJump(null);
      return;
    }

    const scrollRect = scroll.getBoundingClientRect();
    const firstUnreadTop = firstUnread.getBoundingClientRect().top;
    const targetScrollTop =
      unreadJump.targetScrollTop ??
      Math.max(0, scroll.scrollTop + firstUnreadTop - scrollRect.top - 12);
    const startScrollTop = unreadJump.startScrollTop ?? scroll.scrollTop;

    if (targetScrollTop >= startScrollTop - 1 || scroll.scrollTop <= targetScrollTop + 1) {
      setUnreadJump(null);
      return;
    }

    const progress = (scroll.scrollTop - targetScrollTop) / (startScrollTop - targetScrollTop);
    const remaining = Math.max(1, Math.ceil(unreadJump.total * Math.min(1, progress)));

    setUnreadJump((current) => {
      if (!current || current.conversationId !== unreadJump.conversationId) {
        return current;
      }
      return current.remaining === remaining &&
        current.startScrollTop === startScrollTop &&
        current.targetScrollTop === targetScrollTop
        ? current
        : {
            ...current,
            remaining,
            startScrollTop,
            targetScrollTop,
          };
    });
  }
  updateUnreadJumpRemainingRef.current = updateUnreadJumpRemaining;

  function unreadMessageElements(state = unreadJump) {
    const scroll = messageScrollRef.current;
    if (!scroll || !state) {
      return [];
    }

    const ids = new Set(visibleMessages.slice(-state.total).map((message) => message.id));

    return Array.from(
      scroll.querySelectorAll<HTMLElement>('.message-line[data-message-id]'),
    ).filter((element) => ids.has(element.dataset.messageId ?? ''));
  }

  function jumpToFirstUnreadMessage() {
    const firstUnread = unreadMessageElements()[0];
    if (!firstUnread) {
      setUnreadJump(null);
      return;
    }

    firstUnread.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
    setUnreadJump(null);
  }

  // ── 未读跳转坞 ──────────────────────────────────────────────────────────
  // 打开会话时上层已经把未读/高亮读进内存并清了库，这里只负责按顺序引导：
  // 每点一下跳一个目标（高亮按 seq 从大到小，最后是「新的 N 条未读消息」），
  // 跳完自动消失。
  const dockStop = unreadDock?.stops[dockIndex] ?? null;
  const dockVisible = Boolean(dockStop);

  async function jumpDockStop(): Promise<void> {
    if (!dockStop || !unreadDock) return;
    const nextIndex = dockIndex + 1;
    // 先推进游标再跳：跳转要走「快慢路径」（可能要重建窗口、异步），期间用户
    // 再点应该是下一条，而不是重跳当前这条。
    setDockIndex(nextIndex);
    try {
      await jumpToSeq({ seq: dockStop.seq });
    } catch (err) {
      console.error('[unread-dock] jump failed', err);
    }
  }

  function toggleGroupInfoCollapsed() {
    setGroupInfoCollapsed((current) => {
      const next = !current;
      saveGroupInfoCollapsed(next);
      return next;
    });
  }

  /**
   * 收起 / 展开输入区。收起来时把挂在输入区上的浮层一并关掉（表情 / 语音 / 更多 /
   * @ 菜单）—— 它们都锚在输入区上，输入区没了就会悬在半空。
   */
  function toggleComposerCollapsed() {
    const next = !composerCollapsed;
    setComposerCollapsed(next);
    saveComposerCollapsed(next);
    if (next) {
      setEmojiOpen(false);
      setToolsOpen(false);
      setVoiceOpen(false);
      setMentionMenu(null);
    }
  }

  async function copyMessage(message: Message) {
    const selected = contextMenu?.clipboard;
    const image = contextMenu?.imageUrl;
    if (image && !selected) {
      setContextMenu(null);
      const result = await exportMedia({ url: image }, 'clipboard');
      if (!result.ok) pushToast({ tone: 'error', title: '复制图片失败', detail: result.error });
      return;
    }
    const body = message.body?.trim() ? message.body : `msgid=${message.msgId ?? message.id}`;
    const rich = selected ?? messageContentClipboard(message.qqElements, body);
    if (!(await writeMentionClipboard(rich))) await copyTextToClipboard(rich.text);
    setContextMenu(null);
  }

  // 失败占位只清理本机状态；原库消息仍沿用 QQ 式删除遮罩。
  async function deleteMessage(message: Message) {
    if (messageBatchBlockReason(message, 'delete')) return;
    if (!conversation) {
      return;
    }
    setContextMenu(null);
    setDecorationCard(null);
    const hidden = await confirmMessageDeletion(1);
    if (hidden === null || actionScopeRef.current !== actionScope) return;
    if (canDiscardFailedMessage(message) && selectedIds.has(message.id)) {
      const next = new Set(selectedIds);
      next.delete(message.id);
      setSelectedIds(next);
      if (!next.size) setSelectionMode(false);
      if (selectionAnchor.current === message.id) selectionAnchor.current = null;
    }
    try {
      await onDeleteMessage?.(message, conversation, hidden);
    } catch {
      /* 上层统一报告失败。 */
    }
  }

  function viewDecoration(message: Message) {
    setContextMenu(null);
    const decoration = (message as any).decoration;
    setDecorationCard({ decoration, anchor: { x: 0, y: 0 } });
  }

  function editMessageRaw(message: Message) {
    if (isLocalOutgoingMessage(message)) return;
    // Close the menu before the editor lightbox opens so it doesn't linger
    // on top of / behind the modal.
    setContextMenu(null);
    onEditRaw?.(message);
  }

  function _requestClearConversationMessages() {
    setContextMenu(null);
    setClearMessagesConfirmOpen(true);
  }

  function clearConversationMessagesLocally() {
    if (!conversation) {
      return;
    }

    const next = new Set(messages.map((message) => message.id));
    saveHiddenMessageIds(conversation.id, next);
    setHiddenMessageIds(next);
    setContextMenu(null);
    setUnreadJump(null);
    setClearMessagesConfirmOpen(false);
  }

  function downloadMessageImage(url: string, _message, intent, browser = false) {
    setContextMenu(null);
    void mediaSave.run({ kind: 'url', url, name: imageFilenameFromUrl(url) }, intent, browser);
  }

  if (!conversation) {
    return (
      <section className={cn('chat-empty')}>
        <img
          className={cn('chat-empty-logo')}
          src={resourceUrl('img', theme === 'dark' ? 'im_2.jpg' : 'im_1.png')}
          alt=""
          draggable={false}
        />
      </section>
    );
  }

  const showSenderNames = conversation.type !== 'direct';
  const currentPreference = {
    ...defaultConversationPreference,
    ...preference,
  };
  const composerActionRegistry = resolveComposerActionRegistry(composerActions);
  // 「只能单独发」的卡片：视频 / 文件，或者一枚超级表情 —— 它们共用一个槽位，
  // 挂上以后正文编辑区让给卡片、输入框里的文字不参与本次发送。
  const hasSingleSend = mediaAttachment !== null || pendingSuperEmoji !== null;
  const singleSendHint = pendingSuperEmoji ? '超级表情只能单独发送' : '视频 / 文件只能单独发送';
  // 引用是正文之外的第二种内容，而它**不占**「单独发」那个槽位（引用 + 正文一起发）。
  const hasQuote = pendingQuote !== null;
  // 内联图片的 token 就在正文里，所以只要正文非空（图算内容）就能发；卡片 / 引用
  // 挂着时发送键也算有内容。
  const sendDisabled =
    !sendAvailable ||
    currentPreference.blocked ||
    sending ||
    (body.trim().length === 0 && !hasSingleSend && !hasQuote);
  const sendTitle = sendAvailable ? '发送' : 'QQ 未在线或处于完全离线模式，暂不可发送';
  // 所有「发包类」操作（戳一戳 / 贴表情 / 撤回 / 群管理）与发送按钮共用同一套硬限制：
  // QQ 在线且未完全离线 + 会话未被屏蔽 + 当前没有消息正在发送。渲染层不再各自放一套
  // 宽松判断，避免「戳一戳能点、发送键却灰着」这类不一致。
  const sendGateReason = !sendAvailable
    ? 'QQ 未在线或处于完全离线模式'
    : currentPreference.blocked
      ? '当前会话已被屏蔽'
      : sending
        ? '消息发送中，请稍候'
        : null;
  const pokeBlockedReason = sendGateReason ? `${sendGateReason}，暂不可戳一戳` : null;
  const reactionBlockedReason =
    conversation.type !== 'group'
      ? '仅群消息支持贴表情'
      : sendGateReason
        ? `${sendGateReason}，暂不可贴表情`
        : null;
  const moderationBlockedReason = sendGateReason ? `${sendGateReason}，暂不可执行该操作` : null;
  // 头像菜单里群管理操作的可见性（按我的身份 vs 目标身份算），以及右键消息的撤回可用性。
  const avatarMenuFlags = avatarMenu ? avatarModerationFlags(avatarMenu.sender) : null;
  const contextRecallInfo = contextMenu ? recallAvailability(contextMenu.message) : null;
  // 语音条只在真的内联显示时才占位（移动端展开态仍然不显示它）。
  const voicePanelActive = voiceOpen && !mobileComposerExpanded && !hasSingleSend;
  // 闪传文件框同样是**内联**的：占掉正文编辑区那一行（小屏与「只能单独发」的卡片
  // 占着那一行时仍是浮层，见 flash-composer.css 里那条 media query）。
  const flashPanelActive = flashOpen && !mobileComposerExpanded;
  const flashPanelInline = flashPanelActive && !hasSingleSend;
  // 「AI 声聊」面板：群聊有「AI 声聊 + 文字转语音」两个页签，私聊只有「文字转语音」
  //（AI 声聊协议目标字段是群号，服务端不认私聊）。合成出来的语音只能单独发，所以
  // 面板开着时正文那一行让位。
  const canUseAiVoice = conversation.type === 'group' || conversation.type === 'direct';
  const aiVoicePanelActive = canUseAiVoice && aiVoiceOpen && !mobileComposerExpanded;
  // 窗口抖动**只支持私聊**（`commonElem serviceType=2`，服务端不认群聊场景），
  // 所以按钮只在 direct 会话渲染 —— 群聊（含群临时会话）下整枚不出现。
  const canUseWindowShake = conversation.type === 'direct' && Boolean(onSendWindowShake);
  // 弹射表情：私聊 / 群聊都能发（协议上 serviceType 23 不分场景）。面板跟链接卡片 /
  // AI 声聊一样是从输入框上沿弹出的浮层，不占正文那一行，选表情时还能照常打字。
  const bouncePanelActive = bounceOpen && !mobileComposerExpanded;
  // 戳一戳：群聊 / 私聊都能发（协议上 serviceType 2 的互动表情不分场景）。
  const pokePanelActive = pokeOpen && !mobileComposerExpanded;
  // 红包面板：群聊 / 私聊都能发，浮层形态（不占正文那一行）。
  const redPacketPanelActive = redPacketOpen && !mobileComposerExpanded;
  const mediaSendDisabled = Boolean(sendGateReason);
  const repeatMessage = repeatTarget(messages, atLatest);
  function messageCanRepeat(message: Message) {
    return (
      (conversation.type === 'group' || conversation.type === 'direct') &&
      !grayTipOf(message) &&
      !deletedKeys.has(deletionIdentity(message.id)) &&
      canRepeatMessage(message)
    );
  }
  async function repeatMessageFor(message: Message) {
    if (
      !messageCanRepeat(message) ||
      !onRepeatMessage ||
      repeatBusy.current ||
      sendGateReason ||
      sending
    )
      return;
    setContextMenu(null);
    repeatBusy.current = true;
    setRepeating(true);
    try {
      await onRepeatMessage(message, conversation);
    } catch (error) {
      pushToast({
        tone: 'error',
        message: '重发失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      repeatBusy.current = false;
      setRepeating(false);
    }
  }
  const composerActionContext: ComposerActionContext = {
    conversation,
    blocked: currentPreference.blocked,
    sending,
    closePanels: () => {
      setContextMenu(null);
      setEmojiOpen(false);
      setToolsOpen(false);
      setVoiceOpen(false);
      setArkOpen(false);
      setAiVoiceOpen(false);
      setBounceOpen(false);
      setPokeOpen(false);
      setRedPacketOpen(false);
    },
  };
  // 输入区高度固定：语音条内联时就装在正文那一行里，不再临时抬高（避免开录音时
  // 整个聊天区往下跳）。面板内容装不下时它自己在内部滚动。
  //
  // 收起时置 0：网格那一行、把手的 bottom、右下角「N 条新消息」气泡的 bottom 都
  // 吃这个变量，于是整条输入区从布局里消失、气泡自动落回底边，不用各处单独判断。
  // 多选时输入区让位给操作条 —— 只留一条矮栏（即使输入区本来是收起的也要露出来）。
  const effectiveComposerHeight = selectionMode ? 64 : composerCollapsed ? 0 : composerHeight;
  const paneStyle = {
    '--composer-height': `${effectiveComposerHeight}px`,
    '--desktop-composer-height': `${effectiveComposerHeight}px`,
    '--mobile-composer-editor-height': `${mobileComposerEditorHeight}px`,
  } as CSSProperties;
  const hasPlusActions = composerActionRegistry.plusPanel.length > 0;

  function runComposerAction(action: ComposerButtonAction) {
    if (isComposerActionDisabled(action, composerActionContext)) {
      return;
    }

    setContextMenu(null);
    void action.onClick?.(composerActionContext);
  }

  return (
    <section
      {...multi.rootProps}
      className={cn(
        'chat-pane',
        conversation.type === 'group' ? 'with-group-info' : '',
        conversation.type === 'group' && (groupInfoCollapsed || sidecarOpen)
          ? 'group-info-collapsed'
          : '',
        mobileGroupInfoOpen && 'is-mobile-group-info-open',
        composerCollapsed && !selectionMode ? 'composer-collapsed' : '',
        selectionMode ? 'selection-mode' : '',
        mobileComposerLong ? 'mobile-composer-long' : '',
        mobileComposerExpanded ? 'mobile-composer-expanded-open' : '',
      )}
      style={paneStyle}
      onPointerDownCapture={(event) => {
        multi.rootProps.onPointerDownCapture();
        handleReadGesture(event);
      }}
      onClickCapture={handleReadGesture}
      onWheelCapture={handleReadGesture}
      onTouchMoveCapture={handleReadGesture}
      onKeyUpCapture={handleReadGesture}
      onCopyCapture={(event) => {
        const rich = selectedMessageClipboard(event.currentTarget);
        if (!rich) return;
        event.clipboardData.setData('text/plain', rich.text);
        event.clipboardData.setData('text/html', rich.html);
        event.preventDefault();
      }}
    >
      <ChatBackdrop
        imageUrl={backdrop.imageUrl}
        videoUrl={backdrop.videoUrl}
        widgetId={backdrop.widgetId}
        opacity={backdrop.opacity}
      />
      <header className={cn('chat-header')}>
        <button className={cn('icon-button back-button')} onClick={onBack} title="返回">
          <ChevronLeft size={22} />
        </button>
        <div className={cn('chat-title')}>
          <strong>
            {conversation.type === 'group' ||
            (conversation.type === 'direct' && onOpenGroupMember) ? (
              <button
                className={cn('chat-title-text', 'weq-conversation-title-profile')}
                type="button"
                title={conversation.type === 'group' ? '查看群名片' : '查看好友名片'}
                onClick={(event) => {
                  if (conversation.type === 'group') {
                    setTitleProfileGroupId(conversation.id);
                  } else if (conversation.type === 'direct') {
                    const rect = event.currentTarget.getBoundingClientRect();
                    onOpenGroupMember?.(conversation.otherUser, {
                      x: rect.left,
                      y: rect.bottom,
                    });
                  }
                }}
              >
                {chatHeaderTitle(conversation)}
              </button>
            ) : (
              <span className={cn('chat-title-text')}>{chatHeaderTitle(conversation)}</span>
            )}
            {isBotConversation(conversation) ? (
              <small className={cn('bot-badge')} aria-label="机器人" title="机器人">
                <Bot size={12} strokeWidth={2.4} />
              </small>
            ) : null}
            {conversation.type === 'group' && conversation.group.luckyChar ? (
              <img
                className={cn('lucky-char-badge')}
                src={`https://tianquan.gtimg.cn/groupluckyword/item/${conversation.group.luckyChar.id}/pic-${conversation.group.luckyChar.litCount}.png`}
                alt=""
                title={`幸运字符 · 已点亮 ${conversation.group.luckyChar.litCount} 人`}
                referrerPolicy="no-referrer"
              />
            ) : null}
          </strong>
          {conversation.type === 'direct' ? <OnlineStatus uid={conversation.otherUser.id} /> : null}
        </div>
        <div className={cn('chat-actions')} role="toolbar" aria-label="会话工具栏">
          {intentSupported &&
          conversation.type === 'direct' &&
          conversation.otherUser &&
          !isBotConversation(conversation) ? (
            <AffinityPill
              peerUid={conversation.otherUser.id}
              peerName={displayUserName(conversation.otherUser)}
            />
          ) : null}
          {onSearchChatRecords &&
          (conversation.type === 'group' || conversation.type === 'direct') ? (
            <button
              className={cn('icon-button', 'group-header-info-action', 'chat-header-search-action')}
              type="button"
              title="搜索聊天记录"
              onClick={() => onSearchChatRecords(conversation)}
            >
              <Search size={18} />
            </button>
          ) : null}
          {conversation.type === 'group' || conversation.type === 'direct' ? (
            <ConversationMessageActions
              conversation={conversation}
              onRoaming={onOpenRoamingBackfill}
              onAdd={onAddMessage}
              onDeleted={onViewDeleted}
              onRecalled={onViewRecalled}
            />
          ) : null}
          {conversation.type === 'group' ? (
            <>
              {!sidecarOpen ? (
                <button
                  className="icon-button group-header-info-action weq-mobile-group-info-trigger"
                  type="button"
                  title="群资料"
                  aria-label="群资料"
                  aria-expanded={mobileGroupInfoOpen}
                  onClick={() => setMobileGroupInfoOpen((previous) => !previous)}
                >
                  <UsersRound size={18} />
                </button>
              ) : null}
              {onOpenGroupBug && PROJECT_GROUP_IDS.includes(conversation.id) ? (
                <button
                  className={cn(
                    'icon-button',
                    'group-header-info-action',
                    'group-header-bug-action',
                  )}
                  type="button"
                  title={groupBugOnline ? '反馈 Bug' : 'QQ 未在线，暂不可反馈'}
                  disabled={!groupBugOnline}
                  onClick={() => onOpenGroupBug(conversation)}
                >
                  <Bug size={18} />
                </button>
              ) : null}
            </>
          ) : null}
          {onOpenConversationSettings &&
          (conversation.type === 'group' || conversation.type === 'direct') ? (
            <button
              className={cn('icon-button', 'group-header-info-action')}
              type="button"
              title="会话设置"
              onClick={(event) => onOpenConversationSettings?.(conversation, event.currentTarget)}
            >
              <Settings2 size={18} />
            </button>
          ) : null}
        </div>
      </header>
      {conversation.type === 'group' && titleProfileGroupId === conversation.id ? (
        <GroupProfileDialog
          conversation={conversation}
          onClose={() => setTitleProfileGroupId(null)}
        />
      ) : null}

      <IntentSenseProvider
        kind={intentKind}
        conv={intentConv}
        latestPeerMsgId={latestPeerMsgId}
        latestMessageId={latestMessageId}
      >
        <div
          className={cn('message-scroll', marquee.dragging && 'is-marquee-selecting')}
          ref={messageScrollRef}
          onScroll={handleMessageScroll}
          {...marquee.handlers}
        >
          {marquee.box ? (
            <div className="weq-message-marquee" aria-hidden style={marquee.box} />
          ) : null}
          {loading ? (
            <ChatMessagesSkeleton />
          ) : visibleMessages.length === 0 ? (
            <EmptyState title="还没有消息" body="发出第一条消息。" icon={<MessageSquareText />} />
          ) : (
            (() => {
              // 灰条分流 + 气泡组装统一走 messageRow 的 MessageRow —— 转发窗口与合成转发
              // 预览用的是同一份实现，所以三处的画法不会再各写一套。
              const out = [];
              let previousForGap: Message | undefined;
              visibleMessages.forEach((message, index) => {
                // A hole in the seq run means QQ has messages here that were
                // never synced locally. Checked for every row (gray tips
                // included — they occupy a seq too) and emitted before the row
                // that follows the hole.
                const previous = visibleMessages[index - 1];
                const gapPrevious = previousForGap;
                const deletedGap =
                  gapPrevious && hasHiddenDeletionBetween(gapPrevious.msgSeq, message.msgSeq);
                const gap = messageGapCount(
                  gapPrevious,
                  message,
                  selectionMode || Boolean(deletedGap),
                );
                if (!isUnpositionedFailure(message)) previousForGap = message;
                // 跳转落空的目标落在 previous 与 message 之间、且恰好只缺这 1 条时，
                // 默认的缺口条（只在跳空 >1 时出现）不会渲染。补一条，保证「跳到空消息」
                // 永远有可点击的拉取入口。跳空 >1 时交给上面的自然缺口条，不重复。
                if (
                  gap === 0 &&
                  missingJumpSeq &&
                  gapPrevious &&
                  conversation &&
                  onOpenGapMessages &&
                  isSeqBetween(missingJumpSeq, gapPrevious.msgSeq, message.msgSeq)
                ) {
                  out.push(
                    <MessageGapDivider
                      key={`missing-jump-${message.id}`}
                      id={selectionGapId({
                        previousSeq: String(gapPrevious.msgSeq),
                        currentSeq: String(message.msgSeq),
                      })}
                      selectionMode={selectionMode}
                      selected={displayedGapSelected({
                        previousSeq: String(gapPrevious.msgSeq),
                        currentSeq: String(message.msgSeq),
                        count: 1,
                      })}
                      selectionProps={multi.itemProps(
                        selectionGapId({
                          previousSeq: String(gapPrevious.msgSeq),
                          currentSeq: String(message.msgSeq),
                        }),
                      )}
                      count={1}
                      onOpen={() =>
                        onOpenGapMessages({
                          conversation,
                          previousSeq: String(gapPrevious.msgSeq ?? ''),
                          currentSeq: String(message.msgSeq ?? ''),
                          count: 1,
                        })
                      }
                    />,
                  );
                }
                if (gap > 0) {
                  out.push(
                    <MessageGapDivider
                      key={`gap-${message.id}`}
                      id={
                        gapPrevious
                          ? selectionGapId({
                              previousSeq: String(gapPrevious.msgSeq),
                              currentSeq: String(message.msgSeq),
                            })
                          : undefined
                      }
                      selectionMode={selectionMode}
                      selected={
                        gapPrevious
                          ? displayedGapSelected({
                              previousSeq: String(gapPrevious.msgSeq),
                              currentSeq: String(message.msgSeq),
                              count: gap,
                            })
                          : false
                      }
                      selectionProps={
                        gapPrevious
                          ? multi.itemProps(
                              selectionGapId({
                                previousSeq: String(gapPrevious.msgSeq),
                                currentSeq: String(message.msgSeq),
                              }),
                            )
                          : undefined
                      }
                      count={gap}
                      onOpen={
                        conversation && onOpenGapMessages && gapPrevious
                          ? () =>
                              onOpenGapMessages({
                                conversation,
                                previousSeq: String(gapPrevious.msgSeq ?? ''),
                                currentSeq: String(message.msgSeq ?? ''),
                                count: gap,
                              })
                          : undefined
                      }
                    />,
                  );
                }
                const sender = resolveMessageSender(message, conversation, user);
                out.push(
                  <Fragment key={message.id}>
                    {shouldShowMessageTime(previous, message) ? (
                      <MessageTimeDivider value={message.createdAt} />
                    ) : null}
                    <MessageRow
                      message={message}
                      conversation={conversation}
                      user={user}
                      sender={sender}
                      renderers={messageRenderers}
                      showSenderName={showSenderNames}
                      active={contextMenu?.message.id === message.id}
                      deleted={deletedKeys.has(deletionIdentity(message.id))}
                      deletedKind={message.deletedKind}
                      recallRevokerName={message.recallRevokerName}
                      onRestore={onRestoreMessage}
                      onContextMenu={openMessageMenu}
                      onLongPress={openMobileMessageMenu}
                      onAction={onMessageAction}
                      onReedit={reeditMessage}
                      repeatAction={
                        !selectionMode &&
                        onRepeatMessage &&
                        repeatMessage?.id === message.id &&
                        messageCanRepeat(message) ? (
                          <button
                            type="button"
                            className="weq-message-repeat"
                            title={sendGateReason || '发送一条相同的消息'}
                            aria-label="+1，发送相同消息"
                            disabled={Boolean(sendGateReason) || sending || repeating}
                            aria-busy={repeating}
                            onClick={(event) => {
                              event.stopPropagation();
                              void repeatMessageFor(message);
                            }}
                          >
                            {repeating ? <Loader2 size={15} className="spin" /> : '+1'}
                          </button>
                        ) : undefined
                      }
                      selectionMode={selectionMode}
                      selected={
                        (selectionMode || Boolean(marquee.previewIds)) &&
                        displayedSelectedIds.has(message.id)
                      }
                      onToggleSelect={toggleSelectMessage}
                      reactionRemoval={{
                        onRemove: (code) => changeMessageReaction(message, code, false),
                        blockedReason: messageReactionBlockedReason(message),
                        busy: setMessageReaction.isLoading,
                      }}
                      pendingAction={
                        pendingActions[message.id] ? (
                          <span
                            className="weq-message-sending"
                            role="status"
                            aria-label={pendingActions[message.id]}
                            title={pendingActions[message.id]}
                          >
                            <Loader2 size={15} />
                          </span>
                        ) : undefined
                      }
                      onAvatarClick={
                        !selectionMode &&
                        (conversation.type === 'group' || conversation.type === 'direct') &&
                        onOpenGroupMember
                          ? onOpenGroupMember
                          : undefined
                      }
                      onAvatarContextMenu={!selectionMode ? openAvatarMenu : undefined}
                    />
                  </Fragment>,
                );
              });
              return out;
            })()
          )}
          {pendingActions['timeline:poke'] ? (
            <div className="weq-inline-interaction-pending" role="status" aria-label="正在戳一戳">
              <span className="weq-message-sending">
                <Loader2 size={15} />
              </span>
            </div>
          ) : null}
          <div ref={endRef} />
        </div>
      </IntentSenseProvider>

      {newMessagePill > 0 ? (
        <div className="new-message-pill" role="group" aria-label="新消息">
          {onPreviewLatest ? (
            <button
              className="new-message-preview"
              type="button"
              title="预览新消息"
              aria-label="预览新消息"
              onClick={() => onPreviewLatest(conversation)}
            >
              <Eye size={15} />
            </button>
          ) : null}
          <button
            className="new-message-bottom"
            type="button"
            title="定位到底部"
            aria-label="定位到底部"
            disabled={jumpingToLatest}
            onClick={() => void jumpToBottomAndRead()}
          >
            {jumpingToLatest ? <Loader2 size={14} /> : <ChevronDown size={14} strokeWidth={2.8} />}
            <span>{formatUnreadJumpCount(newMessagePill)}条新消息</span>
          </button>
        </div>
      ) : null}

      {/* biome-ignore lint/correctness/noConstantCondition: 暂时禁用的「跳转首条未读」按钮,保留待恢复 */}
      {false && unreadJump && unreadJump.remaining > 0 ? (
        <button
          className={cn('unread-jump-button')}
          type="button"
          onClick={jumpToFirstUnreadMessage}
        >
          <ChevronsUp size={21} strokeWidth={2.8} />
          <span>{formatUnreadJumpCount(unreadJump.remaining)}条新消息</span>
        </button>
      ) : null}

      {/* 未读跳转坞：打开会话时按内存快照逐个引导跳转，跳完自动收起。
          高亮用告警/内容/红包三色区分，兜底的「新的 N 条未读消息」是中性蓝。 */}
      {dockVisible && dockStop && unreadDock ? (
        <button
          key={`${conversation.id}:${dockStop.kind}:${dockStop.seq}`}
          className={cn('unread-dock-button', `tone-${dockStopTone(dockStop)}`)}
          type="button"
          title={`跳转到${dockStopLabel(dockStop, unreadDock.unread)}`}
          onClick={() => {
            void jumpDockStop();
          }}
        >
          {dockStop.kind === 'unread' ? (
            <ChevronsUp size={13} strokeWidth={2.4} aria-hidden />
          ) : (
            <Sparkles size={13} strokeWidth={2.4} aria-hidden />
          )}
          <span className={cn('unread-dock-label')}>
            {dockStopLabel(dockStop, unreadDock.unread)}
          </span>
          {unreadDock.stops.length > 1 ? (
            <span className={cn('unread-dock-count')}>
              {dockIndex + 1}/{unreadDock.stops.length}
            </span>
          ) : null}
        </button>
      ) : null}

      {conversation.type === 'group' ? (
        <>
          {!sidecarOpen ? (
            <button
              className={cn('group-info-toggle')}
              type="button"
              title={groupInfoCollapsed ? '展开群资料' : '收起群资料'}
              aria-label={groupInfoCollapsed ? '展开群资料' : '收起群资料'}
              aria-expanded={!groupInfoCollapsed}
              onClick={toggleGroupInfoCollapsed}
            >
              {groupInfoCollapsed ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
            </button>
          ) : null}
          {!groupInfoCollapsed || mobileGroupInfoOpen ? (
            <GroupInfoPanel
              hidden={sidecarOpen}
              conversation={conversation}
              onOpenDetail={handleOpenGroupInfoDetail}
              onOpenAnnouncements={
                onOpenGroupAnnouncements ? () => onOpenGroupAnnouncements(conversation) : undefined
              }
              groupTodos={groupTodos}
              onOpenSign={onOpenGroupSign ? () => onOpenGroupSign(conversation) : undefined}
              onOpenEssence={
                onOpenGroupEssence ? () => onOpenGroupEssence(conversation) : undefined
              }
              onOpenAlbums={onOpenGroupAlbums ? () => onOpenGroupAlbums(conversation) : undefined}
              onOpenFiles={onOpenGroupFiles ? () => onOpenGroupFiles(conversation) : undefined}
              onClose={mobileGroupInfoOpen ? () => setMobileGroupInfoOpen(false) : undefined}
              onOpenMember={onOpenGroupMember}
              onMemberContextMenu={!selectionMode ? openAvatarMenu : undefined}
              onLoadMoreMembers={onLoadMoreGroupMembers}
              loadingMoreMembers={groupMembersLoading}
              loadingError={groupMembersError}
              memberSearch={groupMemberSearch}
              onMemberSearchChange={onGroupMemberSearchChange}
              onLoadMoreSearch={onLoadMoreGroupMemberSearch}
              profileLoading={profileLoading}
              onOpenLeftMembers={
                onOpenGroupLeftMembers ? () => onOpenGroupLeftMembers(conversation) : undefined
              }
            />
          ) : null}
        </>
      ) : null}

      {/* 收纳输入区的把手 —— 与群资料栏同一个交互：贴在两个区域的交界线上，
          平时隐形，压上去（或键盘聚焦）才浮出来；收起来以后整条输入区从布局里
          消失，只剩它在底边，负责把输入框再请回来。 */}
      <button
        className={cn('composer-toggle')}
        type="button"
        title={composerCollapsed ? '展开输入框' : '收起输入框'}
        aria-label={composerCollapsed ? '展开输入框' : '收起输入框'}
        aria-expanded={!composerCollapsed}
        onClick={toggleComposerCollapsed}
      >
        {composerCollapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </button>

      {/* 意图感知的回复建议：开启时出现在输入框上方，点击填入编辑器草稿。 */}
      {intentSupported &&
      !composerCollapsed &&
      !selectionMode &&
      conversation?.type !== undefined ? (
        <IntentSuggestionBar
          kind={intentKind}
          conv={intentConv}
          replyTargetId={latestPeerMsgId}
          latestMessageId={latestSuggestionId}
          onInsert={(text) => {
            const prefix = body.trim().length > 0 ? ' ' : '';
            insertComposerText(`${prefix}${text}`);
            window.requestAnimationFrame(() => focusComposerEnd(currentComposerEditor()));
          }}
        />
      ) : null}

      <div
        className={cn(
          'composer',
          hasSingleSend && 'has-single-send',
          hasQuote && 'has-quote',
          voicePanelActive && 'voice-open',
          flashPanelInline && 'flash-open',
          dropActive && 'is-dropping',
          selectionMode && 'selection-mode',
        )}
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={handleComposerDrop}
      >
        {selectionMode ? (
          <div className={cn('selection-bar')}>
            <div
              className={cn('selection-bar-info')}
              aria-label={`已选 ${selectionFlow.selectedCount} 条消息`}
              aria-live="polite"
            >
              <span className={cn('selection-bar-count')}>{selectionFlow.selectedCount}</span>
              <span className={cn('selection-bar-label')}>条已选</span>
              {selectionFlow.gaps.length ? <span>{selectionFlow.gaps.length} 处缺口</span> : null}
            </div>
            <div className={cn('selection-bar-actions')}>
              {requestAnalysis && conversationAnalysisTarget(conversation) ? (
                <button
                  type="button"
                  className="selection-action"
                  aria-label="分析所选消息"
                  title={selectionBlockedReason || '分析所选消息'}
                  disabled={Boolean(selectionBlockedReason) || !selectedIds.size}
                  onClick={() => requestBatchAction('analysis')}
                >
                  <BarChart3 size={17} />
                </button>
              ) : null}
              {requestExport && conversationExportSelection(conversation) ? (
                <button
                  type="button"
                  className="selection-action"
                  aria-label="导出所选消息"
                  title={selectionBlockedReason || '导出所选消息'}
                  disabled={Boolean(selectionBlockedReason) || !selectedIds.size}
                  onClick={() => requestBatchAction('export')}
                >
                  <Download size={17} />
                </button>
              ) : null}
              {onAddToComposition ? (
                <button
                  type="button"
                  className="selection-action"
                  aria-label="添加到素材库"
                  title={selectionBlockedReason || '添加到素材库'}
                  disabled={Boolean(selectionBlockedReason) || !selectedIds.size}
                  onClick={() => void addSelectedToComposition()}
                >
                  <ListPlus size={17} />
                </button>
              ) : null}
              <button
                type="button"
                className={cn('selection-action')}
                aria-label="转发"
                title={
                  selectionBlockedReason ||
                  (sendGateReason ? `${sendGateReason}，暂不可发送` : '转发')
                }
                aria-haspopup="menu"
                aria-expanded={selectionMenu?.kind === 'forward'}
                disabled={
                  Boolean(selectionBlockedReason) || Boolean(sendGateReason) || !selectedIds.size
                }
                onClick={(event) => openSelectionMenu('forward', event.currentTarget)}
              >
                <Share2 size={17} />
              </button>
              <button
                type="button"
                className="selection-action"
                aria-label="复制"
                title={selectionBlockedReason || '复制'}
                aria-haspopup="menu"
                aria-expanded={selectionMenu?.kind === 'copy'}
                disabled={Boolean(selectionBlockedReason) || !selectedIds.size}
                onClick={(event) => openSelectionMenu('copy', event.currentTarget)}
              >
                <Copy size={17} />
              </button>
              <button
                type="button"
                className={cn('selection-action')}
                aria-label="删除"
                disabled={deletionBusy || Boolean(selectionBlockedReason) || !selectedIds.size}
                title={selectionBlockedReason || '删除所选消息；失败占位仅从本机移除'}
                onClick={deleteSelectedMessages}
              >
                <Trash2 size={17} />
              </button>
              {onRestoreMessage && restorableSelection.length > 0 ? (
                <button
                  type="button"
                  className="selection-action"
                  aria-label="恢复所选已删除消息"
                  title="恢复所选已删除消息"
                  disabled={deletionBusy || Boolean(selectionBlockedReason)}
                  onClick={() => void restoreSelectedMessages()}
                >
                  <RotateCcw size={17} />
                </button>
              ) : null}
              <button
                type="button"
                className={cn('selection-action')}
                onClick={exitSelection}
                title="退出多选"
                aria-label="退出多选"
              >
                <X size={17} />
              </button>
            </div>
          </div>
        ) : null}
        {selectionMode && selectionMenu ? (
          <ConversationActionsMenu
            label={selectionMenu.kind === 'copy' ? '复制格式' : '转发方式'}
            x={selectionMenu.x}
            y={selectionMenu.y}
            onClose={closeSelectionMenu}
            actions={
              selectionMenu.kind === 'copy'
                ? [
                    {
                      label: '纯文本',
                      icon: <FileText size={16} />,
                      action: () => void copySelectedMessagesText(),
                    },
                    {
                      label: '富文本',
                      icon: <Copy size={16} />,
                      action: () => void copySelectedMessagesRich(),
                    },
                    {
                      label: 'JSON',
                      icon: <ClipboardCopy size={16} />,
                      action: copySelectedMessagesJson,
                    },
                  ]
                : [
                    { label: '合并转发', icon: <Share2 size={16} />, action: mergeForwardSelected },
                    {
                      label: '逐条转发',
                      icon: <Forward size={16} />,
                      disabled: !onForwardMessages,
                      action: () => void forwardSelected(),
                    },
                  ]
            }
          />
        ) : null}
        {batchAction ? (
          <MessageBatchActionDialog
            {...batchAction}
            conversation={conversation}
            user={user}
            renderers={messageRenderers}
            onClose={() => setBatchAction(null)}
            onContinue={(messages) => performBatchAction(batchAction.action, messages)}
          />
        ) : null}
        <ComposerResizeHandle
          height={composerHeight}
          minHeight={composerHeightMin}
          maxHeight={composerHeightMax}
          onHeightChange={updateComposerHeight}
        />
        <ComposerDropVeil visible={dropActive} />
        <div className={cn('composer-tools')}>
          {composerActionRegistry.mobileToolbar.map((action) => (
            <ComposerToolbarActionButton
              key={action.id}
              action={action}
              className={cn('composer-tool', 'composer-mobile-tool')}
              context={composerActionContext}
              iconSize={27}
              onClick={runComposerAction}
            />
          ))}
          <button
            ref={emojiButtonRef}
            type="button"
            className={cn('composer-tool', emojiOpen && 'active')}
            title={hasSingleSend ? singleSendHint : '表情'}
            disabled={currentPreference.blocked || hasSingleSend}
            onClick={toggleEmojiPanel}
          >
            <Smile size={21} strokeWidth={1.5} />
          </button>
          {/* 弹射表情：选一枚系统表情 + 个数，发射成一条独立消息。 */}
          <button
            ref={bounceButtonRef}
            type="button"
            className={cn('composer-tool', bounceOpen && 'active')}
            title={hasSingleSend ? singleSendHint : '弹射表情'}
            disabled={currentPreference.blocked || hasSingleSend}
            onClick={toggleBouncePanel}
          >
            <Rocket size={21} strokeWidth={1.5} />
          </button>
          {/* 戳一戳互动表情：选一枚 + 连击次数，戳成一条独立消息（群聊 / 私聊都可）。 */}
          <button
            ref={pokeButtonRef}
            type="button"
            className={cn('composer-tool', pokeOpen && 'active')}
            title={hasSingleSend ? singleSendHint : '互动表情'}
            disabled={currentPreference.blocked || hasSingleSend}
            onClick={togglePokePanel}
          >
            <Hand size={21} strokeWidth={1.5} />
          </button>
          {/* 红包：群聊三档类型 / 私聊两档，下单后弹二维码灯箱。 */}
          <button
            ref={redPacketButtonRef}
            type="button"
            className={cn('composer-tool', redPacketOpen && 'active')}
            title={hasSingleSend ? singleSendHint : '发红包'}
            disabled={currentPreference.blocked}
            onClick={toggleRedPacketPanel}
          >
            <AiOutlineRedEnvelope size={21} />
          </button>
          {/* 窗口抖动仅私聊可见 —— 群聊（含群临时会话）下这枚按钮整个不渲染。 */}
          {canUseWindowShake ? (
            <button
              type="button"
              className={cn('composer-tool')}
              title="窗口抖动"
              disabled={!sendAvailable || currentPreference.blocked || sending}
              onClick={() => void sendWindowShake()}
            >
              <Vibrate size={21} strokeWidth={1.5} />
            </button>
          ) : null}
          <button
            ref={voiceButtonRef}
            type="button"
            className={cn('composer-tool', 'composer-desktop-tool', voiceOpen && 'active')}
            title={hasSingleSend ? singleSendHint : '语音'}
            disabled={currentPreference.blocked || hasSingleSend}
            onClick={toggleVoicePanel}
          >
            <Mic size={21} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className={cn('composer-tool', 'composer-desktop-tool')}
            title={hasSingleSend ? singleSendHint : '发送图片'}
            disabled={currentPreference.blocked || sending || hasSingleSend}
            onClick={() => openMediaPicker('image')}
          >
            <ImageIcon size={21} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className={cn('composer-tool', 'composer-desktop-tool')}
            title="发送文件或视频"
            disabled={currentPreference.blocked || sending}
            onClick={() => openMediaPicker('file')}
          >
            <FolderOpen size={21} strokeWidth={1.5} />
          </button>
          <button
            ref={arkButtonRef}
            type="button"
            className={cn('composer-tool', 'composer-desktop-tool', arkOpen && 'active')}
            title={hasSingleSend ? singleSendHint : '发送 Ark 卡片'}
            disabled={currentPreference.blocked || sending || hasSingleSend}
            onClick={toggleArkPanel}
          >
            <Link2 size={21} strokeWidth={1.5} />
          </button>
          <button
            ref={flashButtonRef}
            type="button"
            className={cn('composer-tool', 'composer-desktop-tool', flashOpen && 'active')}
            title="QQ闪传"
            disabled={currentPreference.blocked || sending}
            onClick={toggleFlashPanel}
          >
            <Zap size={21} strokeWidth={1.5} />
          </button>
          {/* AI 声聊 / 文字转语音：私聊与群聊都显示这枚按钮。 */}
          {canUseAiVoice ? (
            <button
              ref={aiVoiceButtonRef}
              type="button"
              className={cn('composer-tool', 'composer-desktop-tool', aiVoiceOpen && 'active')}
              title={hasSingleSend ? singleSendHint : 'AI 声聊 / 文字转语音（单独发送）'}
              disabled={currentPreference.blocked || sending || hasSingleSend}
              onClick={toggleAiVoicePanel}
            >
              <AudioLines size={21} strokeWidth={1.5} />
            </button>
          ) : null}
          {composerActionRegistry.desktopToolbar.map((action) => (
            <ComposerToolbarActionButton
              key={action.id}
              action={action}
              className={cn('composer-tool', 'composer-desktop-tool')}
              context={composerActionContext}
              iconSize={27}
              onClick={runComposerAction}
            />
          ))}
          <span />
          {hasPlusActions ? (
            <button
              ref={toolsButtonRef}
              type="button"
              className={cn('composer-tool', 'composer-mobile-tool', toolsOpen && 'active')}
              title="更多功能"
              disabled={currentPreference.blocked}
              onClick={toggleToolsPanel}
            >
              <CirclePlus size={28} />
            </button>
          ) : null}
          {conversation.type === 'direct' && (
            <TypingStatus
              key={conversation.id}
              uid={conversation.otherUser.id}
              editors={[composerEditorRef, expandedComposerEditorRef]}
            />
          )}
        </div>
        {mediaAttachment ? (
          <ComposerMediaStage attachment={mediaAttachment} onRemove={removeMediaAttachment} />
        ) : pendingSuperEmoji ? (
          <ComposerSuperEmojiStage item={pendingSuperEmoji} onRemove={removePendingSuperEmoji} />
        ) : null}
        {pendingQuote ? <ComposerQuoteBar quote={pendingQuote} onRemove={removeQuote} /> : null}
        {emojiOpen && !mobileComposerExpanded ? (
          <EmojiPanel
            panelRef={emojiPanelRef}
            onSelect={insertEmoji}
            onSelectSuper={stageSuperEmoji}
          />
        ) : null}
        {voicePanelActive ? (
          <VoicePanel
            panelRef={voicePanelRef}
            canSend={!mediaSendDisabled}
            sendHint={sendTitle}
            transcribeEnabled={transcribeEnabled}
            onSendVoice={(clip) => void sendVoiceClip(clip)}
            onSendTranscript={(text) => void sendTranscriptText(text)}
            onSendAudioFile={(bytes, fileName) => void sendAudioFile(bytes, fileName)}
            onBusyChange={handleVoiceBusyChange}
          />
        ) : null}
        {flashPanelActive ? (
          <FlashComposer
            panelRef={flashPanelRef}
            canSend={!mediaSendDisabled}
            sendHint={sendTitle}
            onSend={sendFlashTransfer}
            onClose={() => setFlashOpen(false)}
          />
        ) : null}
        {arkOpen && !mobileComposerExpanded ? (
          <ArkPanel
            panelRef={arkPanelRef}
            disabled={mediaSendDisabled}
            disabledHint={sendTitle}
            location={arkLocation}
            contacts={arkContacts}
            defaultSignupGroupCode={defaultSignupGroupCode}
            onSend={sendArkCard}
            onClose={() => setArkOpen(false)}
          />
        ) : null}
        {aiVoicePanelActive ? (
          <AiVoicePanel
            panelRef={aiVoicePanelRef}
            disabled={mediaSendDisabled}
            disabledHint={sendTitle}
            allowAiVoice={conversation.type === 'group'}
            canSend={!mediaSendDisabled}
            sendHint={sendTitle}
            ttsProviders={ttsProviders.map((item) => ({
              id: item.id,
              name: item.name,
              ...(item.voice ? { voice: item.voice } : {}),
            }))}
            onSendAudioFile={(bytes, fileName) => void sendAudioFile(bytes, fileName)}
            onSynthesizeSpeech={synthesizeSpeech}
            onSend={(draft) => void sendAiVoice(draft)}
            onClose={() => setAiVoiceOpen(false)}
          />
        ) : null}
        {bouncePanelActive ? (
          <BounceEmojiPanel
            panelRef={bouncePanelRef}
            disabled={mediaSendDisabled}
            disabledHint={sendTitle}
            onSend={(draft) => void sendBounceEmoji(draft)}
            onClose={() => setBounceOpen(false)}
          />
        ) : null}
        {pokePanelActive ? (
          <PokeEmojiPanel
            panelRef={pokePanelRef}
            disabled={mediaSendDisabled}
            disabledHint={sendTitle}
            onSend={(draft) => void sendPokeEmoji(draft)}
            randomFaces={randomFacesQuery.data?.items ?? []}
            onSendRandom={(draft) => void sendRandomFace(draft)}
            onClose={() => setPokeOpen(false)}
          />
        ) : null}
        {redPacketPanelActive ? (
          <RedPacketPanel
            panelRef={redPacketPanelRef}
            group={conversation.type === 'group'}
            disabled={mediaSendDisabled}
            disabledHint={sendTitle}
            passwords={redbagPasswordsQuery.data ?? []}
            passwordsLoading={redbagPasswordsQuery.isFetching}
            onReloadPasswords={() => void redbagPasswordsQuery.refetch()}
            onSend={(draft) => sendRedPacket(draft)}
            onClose={() => setRedPacketOpen(false)}
          />
        ) : null}
        <input
          ref={imageInputRef}
          type="file"
          multiple
          hidden
          accept="image/*"
          onChange={handleMediaPickerChange}
        />
        {/* 视频 / 文件只能单独发，不带 multiple —— 选了也只会留第一个。 */}
        <input ref={fileInputRef} type="file" hidden onChange={handleMediaPickerChange} />
        {toolsOpen && hasPlusActions ? (
          <ComposerPlusPanel
            panelRef={toolsPanelRef}
            actions={composerActionRegistry.plusPanel}
            context={composerActionContext}
            onAction={runComposerAction}
          />
        ) : null}
        {mentionMenu && !mobileComposerExpanded ? (
          <MentionMenu
            atAll={atAllMention}
            menu={mentionMenu}
            menuRef={mentionMenuRef}
            onLoadMore={!mentionMenu.query ? onLoadMoreGroupMembers : undefined}
            onActiveIndexChange={(activeIndex) =>
              setMentionMenu((current) => (current ? { ...current, activeIndex } : current))
            }
            onSelect={insertMention}
          />
        ) : null}
        <div
          ref={composerEditorRef}
          className={cn(
            'composer-editor',
            (hasSingleSend || voicePanelActive || flashPanelInline) && 'composer-row-hidden',
          )}
          role="textbox"
          aria-multiline="true"
          aria-disabled={currentPreference.blocked}
          contentEditable={!currentPreference.blocked}
          suppressContentEditableWarning
          onInput={() => syncComposerBody(composerEditorRef.current)}
          onMouseDown={prepareComposerImagePreview}
          onClick={previewComposerImage}
          onKeyDown={handleComposerKeyDown}
          onKeyUp={rescanMentionOnKeyUp}
          onMouseUp={() => {
            saveComposerSelection(composerEditorRef.current);
            updateMentionMenu(composerEditorRef.current);
          }}
          onFocus={() => {
            saveComposerSelection(composerEditorRef.current);
            updateMentionMenu(composerEditorRef.current);
          }}
          onBlur={() => saveComposerSelection(composerEditorRef.current)}
          onPaste={handleComposerPaste}
        />
        <button
          type="button"
          className={cn('composer-send', 'composer-desktop-tool')}
          title={sendTitle}
          aria-label={sendTitle}
          disabled={sendDisabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void submitMessage()}
        >
          <SendHorizontal size={17} />
          <strong>发送</strong>
        </button>
        {attachmentError ? (
          <span className={cn('composer-attachment-error')} role="status">
            {attachmentError}
          </span>
        ) : null}
        <button
          className={cn('mobile-composer-expand-button')}
          type="button"
          title="展开输入"
          aria-label="展开输入"
          onClick={openMobileComposerExpanded}
        >
          <ChevronDown size={22} />
        </button>
      </div>
      {mobileComposerExpanded ? (
        <div className={cn('mobile-composer-expanded')}>
          <section className={cn('mobile-composer-expanded-sheet')}>
            <button
              className={cn('mobile-composer-expanded-close')}
              type="button"
              title="收起输入"
              aria-label="收起输入"
              onClick={closeMobileComposerExpanded}
            >
              <ChevronDown size={27} />
            </button>
            <div
              ref={expandedComposerEditorRef}
              className={cn('composer-editor mobile-composer-expanded-editor')}
              role="textbox"
              aria-multiline="true"
              aria-disabled={currentPreference.blocked}
              contentEditable={!currentPreference.blocked}
              suppressContentEditableWarning
              onInput={() => syncComposerBody(expandedComposerEditorRef.current)}
              onMouseDown={prepareComposerImagePreview}
              onClick={previewComposerImage}
              onKeyDown={handleComposerKeyDown}
              onKeyUp={rescanMentionOnKeyUp}
              onMouseUp={() => {
                saveComposerSelection(expandedComposerEditorRef.current);
                updateMentionMenu(expandedComposerEditorRef.current);
              }}
              onFocus={() => {
                saveComposerSelection(expandedComposerEditorRef.current);
                updateMentionMenu(expandedComposerEditorRef.current);
              }}
              onBlur={() => saveComposerSelection(expandedComposerEditorRef.current)}
              onPaste={handleComposerPaste}
            />
            {mentionMenu ? (
              <MentionMenu
                atAll={atAllMention}
                menu={mentionMenu}
                menuRef={mentionMenuRef}
                onLoadMore={!mentionMenu.query ? onLoadMoreGroupMembers : undefined}
                onActiveIndexChange={(activeIndex) =>
                  setMentionMenu((current) => (current ? { ...current, activeIndex } : current))
                }
                onSelect={insertMention}
              />
            ) : null}
            <div className={cn('mobile-composer-expanded-tools')}>
              {composerActionRegistry.mobileExpandedToolbar.map((action) => (
                <ComposerToolbarActionButton
                  key={action.id}
                  action={action}
                  context={composerActionContext}
                  iconSize={29}
                  onClick={runComposerAction}
                />
              ))}
              <button
                ref={expandedEmojiButtonRef}
                type="button"
                title="表情"
                className={cn(emojiOpen && 'active')}
                disabled={currentPreference.blocked}
                onClick={toggleEmojiPanel}
              >
                <Smile size={22} strokeWidth={1.5} />
              </button>
              <button
                type="button"
                title="弹射表情"
                className={cn(bounceOpen && 'active')}
                disabled={currentPreference.blocked}
                onClick={toggleBouncePanel}
              >
                <Rocket size={22} strokeWidth={1.5} />
              </button>
              <button
                type="button"
                title="互动表情"
                className={cn(pokeOpen && 'active')}
                disabled={currentPreference.blocked}
                onClick={togglePokePanel}
              >
                <Hand size={22} strokeWidth={1.5} />
              </button>
              <button
                type="button"
                title="发红包"
                className={cn(redPacketOpen && 'active')}
                disabled={currentPreference.blocked}
                onClick={toggleRedPacketPanel}
              >
                <AiOutlineRedEnvelope size={22} />
              </button>
              {canUseWindowShake ? (
                <button
                  type="button"
                  title="窗口抖动"
                  disabled={!sendAvailable || currentPreference.blocked || sending}
                  onClick={() => void sendWindowShake()}
                >
                  <Vibrate size={22} strokeWidth={1.5} />
                </button>
              ) : null}
              <span />
              <button
                type="button"
                className={cn('composer-send-expanded')}
                title={sendTitle}
                aria-label={sendTitle}
                disabled={sendDisabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void submitMessage()}
              >
                <SendHorizontal size={28} />
              </button>
            </div>
            {emojiOpen ? (
              <EmojiPanel
                panelRef={emojiPanelRef}
                onSelect={insertEmoji}
                onSelectSuper={stageSuperEmoji}
              />
            ) : null}
            {bounceOpen ? (
              <BounceEmojiPanel
                panelRef={bouncePanelRef}
                disabled={mediaSendDisabled}
                disabledHint={sendTitle}
                onSend={(draft) => void sendBounceEmoji(draft)}
                onClose={() => setBounceOpen(false)}
              />
            ) : null}
            {pokeOpen ? (
              <PokeEmojiPanel
                panelRef={pokePanelRef}
                disabled={mediaSendDisabled}
                disabledHint={sendTitle}
                onSend={(draft) => void sendPokeEmoji(draft)}
                randomFaces={randomFacesQuery.data?.items ?? []}
                onSendRandom={(draft) => void sendRandomFace(draft)}
                onClose={() => setPokeOpen(false)}
              />
            ) : null}
            {redPacketOpen ? (
              <RedPacketPanel
                panelRef={redPacketPanelRef}
                group={conversation.type === 'group'}
                disabled={mediaSendDisabled}
                disabledHint={sendTitle}
                passwords={redbagPasswordsQuery.data ?? []}
                passwordsLoading={redbagPasswordsQuery.isFetching}
                onReloadPasswords={() => void redbagPasswordsQuery.refetch()}
                onSend={(draft) => sendRedPacket(draft)}
                onClose={() => setRedPacketOpen(false)}
              />
            ) : null}
          </section>
        </div>
      ) : null}
      {clearMessagesConfirmOpen ? (
        <ConfirmDialog
          title="确定删除本地聊天记录？"
          onCancel={() => setClearMessagesConfirmOpen(false)}
          onConfirm={clearConversationMessagesLocally}
        />
      ) : null}
      {mediaSave.prompt}
      {contextMenu ? (
        <MessageContextMenu
          onClose={() => setContextMenu(null)}
          extraActions={
            conversation.type === 'group' && !grayTipOf(contextMenu.message) ? (
              <>
                <QQMessageEssenceAction
                  key={contextMenu.message.id}
                  conversation={conversation}
                  message={contextMenu.message}
                  onClose={() => setContextMenu(null)}
                />
                <MessageTodoAction
                  conversation={conversation}
                  message={contextMenu.message}
                  onClose={() => setContextMenu(null)}
                />
              </>
            ) : undefined
          }
          onAddToComposition={
            onAddToComposition
              ? (message) => {
                  setContextMenu(null);
                  onAddToComposition([message]);
                }
              : undefined
          }
          state={contextMenu}
          onExport={
            requestExport &&
            conversationExportSelection(conversation) &&
            ((selectionMode && selectedIds.has(contextMenu.message.id)) ||
              !messageBatchBlockReason(contextMenu.message, 'export'))
              ? (message) =>
                  selectionMode && selectedIds.has(message.id)
                    ? requestBatchAction('export')
                    : exportMessageIds([message.id])
              : undefined
          }
          exportLabel={
            selectionMode && selectedIds.has(contextMenu.message.id) && selectedIds.size > 1
              ? '导出所选消息'
              : '导出'
          }
          exportBlockedReason={
            (selectionMode && selectedIds.has(contextMenu.message.id) && selectionBlockedReason) ||
            undefined
          }
          onCopy={copyMessage}
          onRepeat={
            onRepeatMessage && messageCanRepeat(contextMenu.message)
              ? (message) => void repeatMessageFor(message)
              : undefined
          }
          repeatBlockedReason={
            sendGateReason || (sending || repeating ? '正在发送消息，请稍候' : null)
          }
          onForward={
            onForwardMessages
              ? (message) => {
                  setContextMenu(null);
                  onForwardMessages([message], conversation);
                }
              : undefined
          }
          onDownloadImage={downloadMessageImage}
          downloadDisabled={mediaSave.disabled}
          onDelete={
            messageBatchBlockReason(contextMenu.message, 'delete') ? undefined : deleteMessage
          }
          deleteLabel={canDiscardFailedMessage(contextMenu.message) ? '移除失败消息' : '删除'}
          onEditRaw={
            onEditRaw &&
            contextMenu.message.source !== 'roaming' &&
            !isLocalOutgoingMessage(contextMenu.message)
              ? editMessageRaw
              : undefined
          }
          onViewDecoration={viewDecoration}
          onReply={startQuote}
          // 系统消息 / 缺少会话内序号不给引：菜单里那枚「引用」直接置灰并说明原因。
          replyBlockedReason={
            outgoingActionBlockReason(contextMenu.message) ?? quoteBlockReason(contextMenu.message)
          }
          onMultiSelect={enterSelection}
          onReact={openReactionPicker}
          // 贴表情仅群聊且需在线已注入的 QQ —— 不满足就置灰并说明原因。
          reactBlockedReason={messageReactionBlockedReason(contextMenu.message)}
          onRemoveReaction={
            grayTipOf(contextMenu.message)
              ? undefined
              : (message, code) => {
                  setContextMenu(null);
                  changeMessageReaction(message, code, false);
                }
          }
          removeReactionBlockedReason={messageReactionBlockedReason(contextMenu.message)}
          // 撤回：不是自己的消息且无群管理权限时整项不出现；否则受 2 分钟 / 越级规则。
          onRecall={contextRecallInfo?.show ? recallMessageFor : undefined}
          recallBlockedReason={contextRecallInfo?.show ? contextRecallInfo.reason : undefined}
        />
      ) : null}
      {avatarMenu ? (
        <AvatarContextMenu
          onClose={() => setAvatarMenu(null)}
          state={avatarMenu}
          onAnalyze={
            conversation?.type === 'group' && directory?.onAnalyzeMember
              ? (member) => {
                  setAvatarMenu(null);
                  directory.onAnalyzeMember(conversation, member);
                }
              : undefined
          }
          onMention={mentionAvatar}
          onPoke={pokeAvatar}
          pokeBlockedReason={pokeBlockedReason}
          onChangeCard={startCardEdit}
          onChangeTitle={startTitleEdit}
          onKick={startKick}
          onMute={muteAvatar}
          onToggleAdmin={toggleAvatarAdmin}
          showChangeCard={avatarMenuFlags?.showChangeCard ?? false}
          showChangeTitle={
            Boolean(avatarMenuFlags?.showChangeTitle) && Boolean(onChangeGroupMemberTitle)
          }
          showKick={avatarMenuFlags?.showKick ?? false}
          showMute={avatarMenuFlags?.showMute ?? false}
          showSetAdmin={avatarMenuFlags?.showSetAdmin ?? false}
          showUnsetAdmin={avatarMenuFlags?.showUnsetAdmin ?? false}
          moderationBlockedReason={moderationBlockedReason}
        />
      ) : null}
      {reactionPicker ? (
        <ReactionPicker
          anchor={{ x: reactionPicker.x, y: reactionPicker.y }}
          onSelect={chooseReaction}
          onClose={() => setReactionPicker(null)}
        />
      ) : null}
      {decorationCard ? (
        <MessageDecorationCard
          decoration={decorationCard.decoration}
          onClose={() => setDecorationCard(null)}
        />
      ) : null}
    </section>
  );
}

function ConfirmDialog({
  title,
  onCancel,
  onConfirm,
}: {
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className={cn('confirm-dialog-scrim')} role="presentation">
      <section
        className={cn('confirm-dialog')}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <strong>{title}</strong>
        <div className={cn('confirm-dialog-actions')}>
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" onClick={onConfirm}>
            确定
          </button>
        </div>
      </section>
    </div>
  );
}

function ComposerPlusPanel({
  panelRef,
  actions,
  context,
  onAction,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  actions: ComposerButtonAction[];
  context: ComposerActionContext;
  onAction: (action: ComposerButtonAction) => void;
}) {
  const pageSize = 8;
  const pageCount = Math.ceil(actions.length / pageSize);

  return (
    <div className={cn('composer-plus-panel', pageCount <= 1 && 'single-page')} ref={panelRef}>
      <div className={cn('composer-plus-grid')}>
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.id}
              type="button"
              title={action.label}
              disabled={isComposerActionDisabled(action, context)}
              onClick={() => onAction(action)}
            >
              <span>
                <Icon size={28} />
              </span>
              <strong>{action.label}</strong>
            </button>
          );
        })}
      </div>
      {pageCount > 1 ? (
        <div className={cn('composer-plus-dots')} aria-hidden="true">
          {Array.from({ length: pageCount }).map((_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
            <span className={cn(index === 0 && 'active')} key={index} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MentionMenu({
  atAll,
  menu,
  menuRef,
  onActiveIndexChange,
  onSelect,
  onLoadMore,
}: {
  atAll: AtAllMentionState;
  menu: MentionMenuState;
  menuRef: RefObject<HTMLDivElement | null>;
  onActiveIndexChange: (activeIndex: number) => void;
  onSelect: (member: GroupMember) => void;
  onLoadMore?: () => void;
}) {
  return (
    <div
      className={cn('mention-menu')}
      ref={menuRef}
      role="listbox"
      aria-label="提及群成员"
      onScroll={(event) => {
        const node = event.currentTarget;
        if (node.scrollHeight - node.scrollTop - node.clientHeight < 80) onLoadMore?.();
      }}
    >
      {menu.members.map((member, index) => (
        <button
          key={member.id}
          role="option"
          aria-selected={index === menu.activeIndex && (member.id !== 'all' || atAll.selectable)}
          aria-disabled={member.id === 'all' && !atAll.selectable}
          disabled={member.id === 'all' && !atAll.selectable}
          title={member.id === 'all' ? atAll.detail : undefined}
          type="button"
          className={cn(index === menu.activeIndex && 'active')}
          onMouseEnter={() => onActiveIndexChange(index)}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => onSelect(member)}
        >
          {member.id === 'all' ? (
            <span className="mention-all-icon" aria-hidden="true">
              <UsersRound size={20} />
            </span>
          ) : (
            <Avatar
              name={displayUserName(member)}
              avatarUrl={member.avatarUrl}
              seed={member.identityValue}
            />
          )}
          <span className={cn('mention-member-name')}>{displayUserName(member)}</span>
          {member.id === 'all' ? (
            <span className="mention-all-quota" aria-label={atAll.detail}>
              {atAll.summary}
            </span>
          ) : member.role !== 'member' || member.kind === 'bot' ? (
            <span className={cn('mention-member-trailing')}>
              {member.role !== 'member' ? (
                <small
                  className={cn('mention-role-badge', member.role === 'owner' ? 'owner' : 'admin')}
                >
                  {member.role === 'owner' ? '群主' : '管理'}
                </small>
              ) : null}
              {member.kind === 'bot' ? (
                <span
                  className={cn('bot-badge mention-bot-badge')}
                  aria-label="机器人"
                  title="机器人"
                >
                  <Bot size={12} strokeWidth={2.4} />
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
      ))}
      {!menu.members.length ? <span className="mention-member-empty">暂无匹配成员</span> : null}
    </div>
  );
}

function ComposerToolbarActionButton({
  action,
  className,
  context,
  iconSize,
  onClick,
}: {
  action: ComposerButtonAction;
  className?: string;
  context: ComposerActionContext;
  iconSize: number;
  onClick: (action: ComposerButtonAction) => void;
}) {
  const Icon = action.icon;

  return (
    <button
      className={className}
      type="button"
      title={action.label}
      disabled={isComposerActionDisabled(action, context)}
      onClick={() => onClick(action)}
    >
      <Icon size={iconSize} />
    </button>
  );
}
