// @ts-nocheck
import {
  BellOff,
  Bot,
  PenLine,
  Pin,
  EyeOff,
  MessageSquare,
  Users,
  UserRound,
  Circle,
  Smile,
  Clock,
  Minus,
  Ban,
  MinusCircle,
  ChevronRight,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from './classNames';
import { Avatar, EmptyState, ListSkeleton } from './primitives';
import { isBotConversation } from './conversationDisplay';
import { messageMentionsUser } from './mentions';
import { resourceUrl } from '../../lib/resourceUrl';
import { FaceEmoji } from '../../components/FaceEmoji';
import type { PreviewNode } from '../../lib/conversationPreview';
import type {
  Contact,
  Conversation,
  ConversationDrafts,
  ConversationPreferences,
  OnlineStatusInfo,
  User,
} from './types';
import { displayUserName } from './user';

export function ConversationList({
  conversations,
  activeConversationId,
  preferences,
  drafts,
  user,
  onSelect,
  loading,
}: {
  conversations: Conversation[];
  activeConversationId: string | null;
  preferences: ConversationPreferences;
  drafts: ConversationDrafts;
  user?: User;
  onSelect: (conversationId: string, event?: React.MouseEvent) => void;
  loading?: boolean;
}) {
  const filtered = useMemo(() => {
    // 置顶会话排最前。sort 是稳定的，所以 MainView 已排好的置顶时间（41103）
    // 次序在这里被保留。
    return [...conversations].sort(
      (first, second) =>
        Number(isPinned(second, preferences)) - Number(isPinned(first, preferences)),
    );
  }, [conversations, preferences]);

  if (loading) {
    return <ListSkeleton rows={9} />;
  }

  if (filtered.length === 0) {
    return <EmptyState title="暂无会话" body="从联系人开始一段聊天。" icon={<MessageSquare />} />;
  }

  return (
    <div className={cn('list-stack')}>
      {filtered.map((conversation) => {
        const active = conversation.id === activeConversationId;
        const unreadCount = conversation.unreadCount ?? 0;
        const hasDraft = !active && Boolean(drafts[conversation.id]?.trim());
        const preview = conversationLastMessage(conversation, user);
        // 提醒高亮：来自 48902 的权威标记（特别关心 / @我 …）。
        const highlightKinds = new Set((conversation.highlights ?? []).map((h) => h.kind));
        // @我：优先用 48902 权威标记，回退到本地对消息正文的启发式解析。
        const showMentionAlert =
          unreadCount > 0 && (highlightKinds.has('atMe') || preview.mentionsMe);
        // @全体成员：同属「找你」红色告警类。
        const showAtAll = unreadCount > 0 && highlightKinds.has('atAll');
        // 回复我：同属「找你」红色告警类。
        const showReplyMe = unreadCount > 0 && highlightKinds.has('replyMe');
        // 特别关心：会话存在特别关心好友未读时，行首挂红色标记。
        const showSpecialCare = unreadCount > 0 && highlightKinds.has('specialCare');
        // 新文件：内容类提示（非「找你」告警），行首挂蓝色标记。
        const showNewFile = unreadCount > 0 && highlightKinds.has('newFile');
        // QQ红包：内容类提示，行首挂金色标记。
        const showRedPacket = unreadCount > 0 && highlightKinds.has('redPacket');
        // 免打扰：会话自带的 DB 值（41220）打底，本地手动偏好覆盖 ——
        // 与 shellController.countVisibleUnreadConversations 的 merge 顺序保持一致。
        const muted = Boolean(
          {
            ...conversation.preference,
            ...preferences[conversation.id],
          }.muted,
        );
        const pinned = isPinned(conversation, preferences);

        return (
          <button
            key={conversation.id}
            className={cn(listRowClass(active, 'conversation-row'), pinned && 'pinned')}
            onClick={(e) => onSelect(conversation.id, e)}
          >
            {conversation.type === 'merged' ? (
              <span className={cn('avatar', 'has-default', 'merged-avatar')}>
                {conversation.mergedKind === 'hidden' ? (
                  <EyeOff size={20} strokeWidth={2} />
                ) : conversation.mergedKind === 'deleted' ? (
                  <Trash2 size={20} strokeWidth={2} />
                ) : conversation.mergedKind === 'service' ? (
                  <Users size={20} strokeWidth={2} />
                ) : (
                  <UserRound size={20} strokeWidth={2} />
                )}
              </span>
            ) : (
              <Avatar
                name={conversationTitle(conversation)}
                avatarUrl={conversationAvatarUrl(conversation)}
                seed={conversationSeed(conversation)}
              />
            )}
            <span className={cn('row-main')}>
              <strong>
                <span className={cn('row-title-text')}>{conversationTitle(conversation)}</span>
                {isBotConversation(conversation) ? (
                  <small className={cn('bot-badge')} aria-label="机器人" title="机器人">
                    <Bot size={12} strokeWidth={2.4} />
                  </small>
                ) : null}
              </strong>
              <span className={cn('row-preview-line')}>
                {hasDraft ? (
                  <span className={cn('row-draft')}>
                    <PenLine size={15} />
                    <span className={cn('row-draft-text')}>
                      {formatDraftPreview(drafts[conversation.id])}
                    </span>
                  </span>
                ) : (
                  <span className={cn('row-message-preview')}>
                    {showSpecialCare ? (
                      <span className={cn('row-specialcare-alert')}>[特别关心]</span>
                    ) : null}
                    {showMentionAlert ? (
                      <span className={cn('row-mention-alert')}>[有人@我]</span>
                    ) : null}
                    {showAtAll ? <span className={cn('row-mention-alert')}>[@全体]</span> : null}
                    {showReplyMe ? (
                      <span className={cn('row-mention-alert')}>[有人回复我]</span>
                    ) : null}
                    {showNewFile ? <span className={cn('row-newfile-alert')}>[新文件]</span> : null}
                    {showRedPacket ? (
                      <span className={cn('row-redpacket-alert')}>[红包]</span>
                    ) : null}
                    {preview.nodes.length ? <PreviewNodes nodes={preview.nodes} /> : null}
                  </span>
                )}
                {!unreadCount && muted ? <BellOff className={cn('row-muted')} size={15} /> : null}
              </span>
            </span>
            <span className={cn('row-meta')}>
              <span className={cn('row-time-line')}>
                {pinned ? (
                  <Pin className={cn('row-pinned')} size={12} aria-label="置顶" title="置顶会话" />
                ) : null}
                {conversation.hidden ? (
                  <EyeOff
                    className={cn('row-hidden')}
                    size={12}
                    aria-label="隐藏会话"
                    title="隐藏会话"
                  />
                ) : null}
                {formatConversationTime(conversation.updatedAt)}
              </span>
              {unreadCount ? (
                <span className={cn(unreadClass(muted))}>{formatBadgeCount(unreadCount)}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function GroupList({
  conversations,
  activeConversationId,
  onSelect,
  loading,
}: {
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelect: (conversationId: string, event?: React.MouseEvent) => void;
  loading?: boolean;
}) {
  const groups = useMemo(() => {
    return conversations.filter((conversation) => conversation.type === 'group');
  }, [conversations]);

  if (loading) {
    return <ListSkeleton rows={9} />;
  }

  if (groups.length === 0) {
    return <EmptyState title="暂无群聊" body="从左上角 + 创建一个群聊。" icon={<Users />} />;
  }

  return (
    <div className={cn('list-stack')}>
      {groups.map((conversation) => (
        <button
          key={conversation.id}
          className={cn(listRowClass(conversation.id === activeConversationId, 'contact-row'))}
          onClick={(e) => onSelect(conversation.id, e)}
        >
          <Avatar
            name={conversation.group.name}
            avatarUrl={conversation.group.avatarUrl}
            seed={conversation.id}
          />
          <span className={cn('row-main')}>
            <strong>
              <span className={cn('row-title-text')}>{conversation.group.name}</span>
            </strong>
            <span>{conversation.group.memberCount} 位成员</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function ContactList({
  contacts,
  activeContactId,
  onSelect,
  loading,
}: {
  contacts: Contact[];
  activeContactId: string | null;
  onSelect: (contact: Contact) => void;
  loading?: boolean;
}) {
  const filtered = useMemo(() => contacts, [contacts]);

  // 按好友分组归类，分组内保持原顺序；分组按 categoryId 升序（0「我的好友」在前）。
  const categories = useMemo(() => {
    const map = new Map<number, { id: number; name: string; items: Contact[] }>();
    for (const contact of filtered) {
      const id = contact.categoryId ?? 0;
      if (!map.has(id)) {
        map.set(id, {
          id,
          name: contact.categoryName || (id === 0 ? '我的好友' : '未命名分组'),
          items: [],
        });
      }
      map.get(id).items.push(contact);
    }
    return [...map.values()].sort((first, second) => first.id - second.id);
  }, [filtered]);

  // 默认全部折叠。
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  if (loading) {
    return <ListSkeleton rows={9} />;
  }

  if (filtered.length === 0) {
    return (
      <EmptyState
        title="暂无联系人"
        body="通过 ID 搜索或邀请链接添加联系人。"
        icon={<UserRound />}
      />
    );
  }

  return (
    <div className={cn('list-stack', 'contact-cat-list')}>
      {categories.map((category) => {
        const open = Boolean(expanded[category.id]);
        return (
          <div className={cn('contact-cat')} key={category.id}>
            <button
              type="button"
              className={cn('contact-cat-header')}
              aria-expanded={open}
              onClick={() =>
                setExpanded((current) => ({
                  ...current,
                  [category.id]: !current[category.id],
                }))
              }
            >
              <ChevronRight className={cn('contact-cat-caret', open && 'is-open')} size={15} />
              <span className={cn('contact-cat-name')}>{category.name}</span>
              <span className={cn('contact-cat-count')}>{category.items.length}</span>
            </button>
            {open
              ? category.items.map((contact) => (
                  <button
                    key={contact.id}
                    className={cn(
                      listRowClass(contact.id === activeContactId, 'contact-row'),
                      'contact-cat-row',
                    )}
                    onClick={() => onSelect(contact)}
                  >
                    <Avatar
                      name={displayUserName(contact)}
                      avatarUrl={contact.avatarUrl}
                      seed={contact.identityValue}
                    />
                    <span className={cn('row-main', 'contact-card-main')}>
                      <span className={cn('contact-card-nickname')}>
                        {displayUserName(contact)}
                        {contact.kind === 'bot' ? (
                          <small className={cn('bot-badge')} aria-label="机器人" title="机器人">
                            <Bot size={12} strokeWidth={2.4} />
                          </small>
                        ) : null}
                      </span>
                      <span className={cn('contact-card-bottom')}>
                        {contact.onlineStatusObj && contact.onlineStatusObj.typeName !== '未知' ? (
                          <span className={cn('contact-card-status')}>
                            <ContactOnlineStatusIcon status={contact.onlineStatusObj} />
                            <span>[{contact.onlineStatusObj.displayStatus}]</span>
                          </span>
                        ) : null}
                        <span className={cn('contact-card-signature')}>
                          {contact.signature || '这个人很懒，什么都没留下'}
                        </span>
                      </span>
                    </span>
                  </button>
                ))
              : null}
          </div>
        );
      })}
    </div>
  );
}

const SUB_ICONS: Record<number, string> = {
  1028: 'music@2x.png',
  1030: 'weather_3x.png',
  2003: 'chuqulang2.png',
  2015: 'gototravel.png',
  2014: 'tkong.png',
  1051: 'relationship_3x.png',
  1071: 'jinli@2x.png',
  1201: 'luck@2x.png',
  1056: 'happytofly@3x.png',
  1058: 'fullofyuanqi@3x.png',
  1063: 'hardtosay@3x.png',
  2001: 'nandehutu.png',
  1401: 'emonew@2x.png',
  1062: 'toohard@3x.png',
  2013: 'woxiangkaile.png',
  1052: 'imfine_3x.png',
  1061: 'bequiet@3x.png',
  1059: 'youzaizai@3x.png',
  1011: 'signal_3x.png',
  1016: 'sleeping_3x.png',
  2012: 'ganzuoye.png',
  1018: 'study_3x.png',
  2023: 'banzhuan.png',
  1300: 'fish@2x.png',
  1060: 'boring@3x.png',
  1027: 'timi_3x.png',
  2025: 'yiqiyuanmeng.png',
  2026: 'qiuxingdazi.png',
  1032: 'stayup_3x.png',
  1021: 'tv_3x.png',
  2019: 'crush.png',
  2006: 'aiziji@2x.png',
};

const TYPE_ICONS: Record<number, () => JSX.Element> = {
  10: () => <Circle size={10} fill="#52c41a" stroke="#52c41a" />,
  60: () => <Smile size={12} stroke="#faad14" />,
  30: () => <Clock size={12} stroke="#8c8c8c" />,
  50: () => <Minus size={12} stroke="#faad14" />,
  70: () => <Ban size={12} stroke="#ff4d4f" />,
  40: () => <MinusCircle size={12} stroke="#8c8c8c" />,
};

function ContactOnlineStatusIcon({ status }: { status: OnlineStatusInfo | undefined }) {
  if (!status) return null;
  const filename = status.type === 10 && SUB_ICONS[status.subType];
  if (filename) {
    return (
      <img src={resourceUrl('onlinestatus', filename)} alt="" style={{ width: 14, height: 14 }} />
    );
  }
  const TypeIcon = TYPE_ICONS[status.type];
  return TypeIcon ? <TypeIcon /> : null;
}

function conversationTitle(conversation: Conversation) {
  if (conversation.type === 'merged') return conversation.title;
  return conversation.type === 'group'
    ? conversation.group.name
    : displayUserName(conversation.otherUser);
}

function conversationAvatarUrl(conversation: Conversation) {
  if (conversation.type === 'merged') return conversation.avatarUrl;
  return conversation.type === 'group'
    ? conversation.group.avatarUrl
    : conversation.otherUser.avatarUrl;
}

function conversationSeed(conversation: Conversation) {
  if (conversation.type === 'merged') return conversation.id;
  return conversation.type === 'group' ? conversation.id : conversation.otherUser.identityValue;
}

function conversationLastMessage(conversation: Conversation, user?: User) {
  // When the last message has no text body (e.g. element-only messages like
  // pure image / sticker / file with no preview text), keep the row's
  // preview line empty rather than printing a placeholder — the timestamp
  // and unread-count next to it already convey "there is activity".
  if (!conversation.lastMessage?.body) {
    return {
      nodes: [],
      text: '',
      mentionsMe: false,
    };
  }

  const mentionsMe =
    conversation.type === 'group' &&
    conversation.lastMessage.senderId !== user?.id &&
    messageMentionsUser(conversation.lastMessage.body, user);

  // 富节点（文本 + 表情）优先；没有就把纯文本包成单个文本节点，渲染路径统一。
  const body: PreviewNode[] = conversation.lastMessage.previewNodes?.length
    ? conversation.lastMessage.previewNodes
    : [{ t: 'text', text: conversation.lastMessage.body }];

  const prefix =
    conversation.type === 'group' && conversation.lastMessage.senderDisplayName
      ? `${conversation.lastMessage.senderDisplayName}：`
      : '';

  return {
    nodes: prefix ? [{ t: 'text', text: prefix } as PreviewNode, ...body] : body,
    text: `${prefix}${conversation.lastMessage.body}`,
    mentionsMe,
  };
}

/** 预览节点 → React：文本原样输出，表情画成图（与聊天区同一个 FaceEmoji）。 */
function PreviewNodes({ nodes }: { nodes: PreviewNode[] }) {
  return nodes.map((node, index) =>
    node.t === 'face' ? (
      <FaceEmoji
        // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
        key={index}
        element={{ faceId: node.faceId, faceText: node.label }}
        size="1.15em"
        className={cn('row-preview-face')}
      />
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
      <span key={index}>{node.text}</span>
    ),
  );
}

/** 会话列表时间：今天显示时分，昨天显示"昨天"，一周内显示星期，更早显示年月日。 */
export function formatConversationTime(value: string | undefined) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  const now = new Date();
  const todayStart = startOfDay(now).getTime();
  const dateStart = startOfDay(date).getTime();
  const dayDiff = Math.floor((todayStart - dateStart) / 86400000);

  if (dayDiff <= 0) {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  if (dayDiff === 1) {
    return '昨天';
  }

  if (dayDiff < 7) {
    return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()];
  }

  return `${date.getFullYear()}/${padDatePart(date.getMonth() + 1)}/${padDatePart(date.getDate())}`;
}

function formatDraftPreview(value: string | undefined) {
  if (!value) {
    return '';
  }

  return value
    .replace(/\[\[chat:emoji:[^\]]+\]\]/g, '[表情]')
    .replace(/\[[^\]\n]{1,32}\]/g, '[表情]')
    .replace(/\s+/g, ' ')
    .trim();
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function padDatePart(value: number) {
  return value.toString().padStart(2, '0');
}

function formatBadgeCount(value: number) {
  return value > 99 ? '99+' : String(value);
}

function isPinned(conversation: Conversation, preferences: ConversationPreferences): boolean {
  return Boolean(
    {
      ...conversation.preference,
      ...preferences[conversation.id],
    }.pinned,
  );
}

function listRowClass(active: boolean, semanticClass: 'conversation-row' | 'contact-row') {
  return cn(semanticClass, active && 'active');
}

function unreadClass(muted: boolean) {
  return cn('row-unread', muted && 'muted');
}
