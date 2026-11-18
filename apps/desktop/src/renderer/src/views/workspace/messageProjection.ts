import { findReplyPreview, type ReplyPreviewIndex } from '../../lib/replyPreview';
import { timelineRowKey } from '../../../../shared/roaming_timeline';
import { outgoingSequenceRejected } from '../../lib/outgoingAcknowledgment';
import { previewIdentityIds, groupTipText } from '../../lib/conversationPreview';
import { messageSender, type MemberUinLookup, type SenderProfile } from '../../lib/messageSender';
import { flashPreviewLabel } from '../../lib/flashShare';
import { isFlashPhotoPlaceholderText } from '../../lib/flashPhoto';
import { TipGroupElementType } from '@weq/codec';
import { seedMessageBubbles, messageBubble } from '../../lib/messageBubbles';
import type { Conversation, GroupMember, Message, User } from '../../im-template/template';
import type { SetEmojiItem } from '@weq/codec';
import { flashTransferTitle } from '../../components/QqFlashTransfer.shared';
import type {
  MessageWire,
  ChatMsgWire,
  RenderElementWire,
  OptimisticForward,
  OptimisticArk,
  OptimisticMessage,
} from './types';
import { toIsoTime } from './identity';

export function toMessageWire(w: ChatMsgWire): MessageWire {
  seedMessageBubbles(w.cachedBubbles);
  return {
    localSent: w.localSent,
    sourceFormat: w.sourceFormat,
    source: w.source,
    ntSeqVerified: w.ntSeqVerified,
    msgId: w.msgId,
    msgSeq: w.msgSeq,
    msgRandom: w.msgRandom ?? '',
    clientSeq: w.clientSeq,
    senderUid: w.senderUid,
    senderUin: w.senderUin,
    sendTime: w.sendTime,
    elements: w.elements,
    setEmojiList: w.setEmojiList,
    deletedKind: w.deletedKind,
    recall: w.recall,
    decoration: w.decoration
      ? { ...w.decoration, cachedBubble: messageBubble(w.decoration.bubbleId) }
      : undefined,
  };
}

/**
 * 乐观渲染的合并转发 → 模板层 Message。
 *
 * 渲染成一张同款「聊天记录」卡片（`multiMsg` 元素）——与真消息同步回来后的样子一致，
 * 因此同步到位后不会出现视觉跳变。`optimistic` 字段驱动旁侧发送圈圈与失败提示。
 */
export function optimisticToTemplate(
  item: OptimisticForward,
  conversation: Conversation,
  user: User,
): Message {
  return {
    id: item.id,
    conversationId: conversation.id,
    senderId: user.id,
    sender: user,
    body: item.title,
    createdAt: new Date(item.at).toISOString(),
    qqElements: [
      {
        type: 'multiMsg',
        data: {
          _label: item.preview.source,
          _news: item.preview.news,
          _summary: item.preview.summary,
          ...(item.resId ? { resId: item.resId } : {}),
        },
      },
    ],
    msgId: item.id,
    // 回执给的**真实会话内 seq**（群聊 = 库里 40003；私聊实测是「本地 max + 1」同一套）。
    // 带上它，乐观条目就能按 seq 混排进真实消息之间，而不是一律置底；seq 缺失
    //（静默丢弃 / 位置卡片那条 trpc 回包解析不出）时留在 '' —— 渲染层会把它排到末尾。
    msgSeq: item.seq ?? '',
    optimisticRejected: item.seqRejected && outgoingSequenceRejected(item),
    optimistic: item.state,
    outgoingToHost: !item.hostReceived,
    optimisticAfterSeq: item.afterSeq,
    optimisticError: item.error,
    msgRandom: item.cid,
  } as Message & {
    qqElements: unknown[];
    msgId: string;
    optimisticRejected?: boolean;
    optimistic: OptimisticForward['state'];
    optimisticError?: string;
  };
}

/**
 * 乐观渲染的 Ark 卡片 → 模板层 Message。
 *
 * 走与真消息**同一条渲染通路**：一个 `ark` 元素交给 `QqArk`，所以同步到位后卡片
 * 不会变样。旁侧发送圈圈与失败提示通过额外的 `optimistic` 字段带到
 * 气泡上，由 MessageBubble 统一呈现。
 */
export function optimisticArkToTemplate(
  item: OptimisticArk,
  conversation: Conversation,
  user: User,
): Message {
  return {
    id: item.id,
    conversationId: conversation.id,
    senderId: user.id,
    sender: user,
    body: '',
    createdAt: new Date(item.at).toISOString(),
    qqElements: [{ type: 'ark', data: { arkData: item.arkData } }],
    msgId: item.id,
    // 同 {@link optimisticToTemplate}：有真实 seq 就参与排序与缺口判定。
    msgSeq: item.seq ?? '',
    optimisticRejected: item.seqRejected && outgoingSequenceRejected(item),
    optimistic: item.state,
    outgoingToHost: !item.hostReceived,
    optimisticAfterSeq: item.afterSeq,
    optimisticError: item.error,
    msgRandom: item.cid,
  } as Message & {
    qqElements: unknown[];
    msgId: string;
    optimisticRejected?: boolean;
    optimistic: OptimisticArk['state'];
    optimisticError?: string;
  };
}

/** 乐观普通消息 → 模板层 Message（走与真实消息**同一条渲染通路**）。 */
export function optimisticMessageToTemplate(
  item: OptimisticMessage,
  conversation: Conversation,
  user: User,
): Message {
  return {
    id: item.id,
    conversationId: conversation.id,
    senderId: user.id,
    sender: user,
    body: item.body,
    createdAt: new Date(item.at).toISOString(),
    qqElements: item.elements,
    msgId: item.id,
    // 有真实 seq 就参与排序与缺口判定（同 Ark / 合并转发）。
    msgSeq: item.seq ?? '',
    optimisticRejected: item.seqRejected && outgoingSequenceRejected(item),
    optimistic: item.state,
    outgoingToHost: !item.hostReceived,
    optimisticAfterSeq: item.afterSeq,
    optimisticError: item.error,
    composerDraft: item.composerDraft,
    decoration: item.decoration,
    msgRandom: item.cid,
  } as Message & {
    qqElements: unknown[];
    msgId: string;
    optimisticRejected?: boolean;
    optimistic: OptimisticMessage['state'];
    optimisticError?: string;
  };
}

export function messageToTemplate(
  message: MessageWire,
  conversation: Conversation,
  user: User,
  memberMap?: Map<string, GroupMember>,
  botUids?: Set<string>,
  replySources?: MessageWire[] | ReplyPreviewIndex,
  profiles?: ReadonlyMap<string, SenderProfile>,
  lookupByUin?: MemberUinLookup,
): Message {
  const sender = messageSender(
    message,
    conversation,
    user,
    memberMap,
    botUids,
    profiles,
    lookupByUin,
  );
  // For any `reply` element in the message, resolve the ORIGINAL message
  // sender's display name (memberMap → self → otherUser → uin/uid fallbacks)
  // and stash it on the reply's data as `origSenderDisplayName` so
  // QqMessageContent's ReplyQuote can render it on the quote box's first line
  // without having to thread the renderer-side group lookup through React
  // context. Non-reply elements are passed through untouched.
  const elements = enrichReplyElements(
    message.elements,
    conversation,
    user,
    memberMap,
    replySources,
  );
  // Recall reviser's display name: only needed when an admin recalled someone
  // else's message (sameSender === false). Group → memberMap by uid; c2c → the
  // peer (the only other party). Falls back to a generic label in the bubble.
  const recallRevokerName = resolveRecallRevokerName(message, conversation, memberMap);
  return {
    id: timelineRowKey(message),
    sourceFormat: message.sourceFormat,
    localSent: message.localSent,
    conversationId: conversation.id,
    senderId: sender.id,
    sender,
    body: messageBody(message.elements) || (message.sourceFormat ? '[漫游空消息或未解析]' : ''),
    // 闪照：本地库只剩一句兜底文案（元素本体从没落库）。打上标记，让聊天窗按需走
    // 协议拉取把真正的元素补回来；拉不到就继续显示这句话。
    ...(isFlashPhotoPlaceholder(message.elements) ? { flashPhotoPlaceholder: true } : {}),
    createdAt: toIsoTime(message.sendTime),
    // Raw render-view elements for the QQ face renderer (qqFaceMessageRenderer).
    // `body` stays the text fallback for previews and non-face messages.
    qqElements: elements,
    // Sticker reactions (贴表情) rendered below the bubble by MessageBubble.
    setEmojiList: message.setEmojiList,
    // Deleted origin ('weq'/'qq'), carried to the bubble's veil renderer.
    deletedKind: message.deletedKind,
    // Recall marker + resolved reviser name, carried to the bubble's 撤回 tag.
    recall: message.recall,
    recallRevokerName,
    msgId: message.msgId,
    // Per-conversation sequence, carried through so chatPane can spot the gaps
    // where messages QQ never synced locally would have been.
    msgSeq: message.msgSeq,
    msgRandom: message.msgRandom,
    // Sender-local client sequence (column 40005); c2c-only, and what a private
    // chat reply has to quote (see composerQuote.composerQuoteElement).
    clientSeq: message.clientSeq,
    // Per-message decoration (bubble/font/widget itemIds from column 40801).
    source: message.source,
    ntSeqVerified: message.ntSeqVerified,
    decoration: message.decoration,
  } as Message & {
    qqElements: unknown[];
    setEmojiList?: SetEmojiItem[];
    deletedKind?: 'weq' | 'qq';
    recall?: { revokeUid: string; sameSender: boolean; recallTs: number };
    recallRevokerName?: string;
    msgId: string;
    msgSeq: string;
    clientSeq?: string;
    decoration?: {
      bubbleId: number;
      fontId: number;
      widgetId: number;
      fontId1Raw?: number;
      fontId2Raw?: number;
    };
  };
}

export function resolveRecallRevokerName(
  message: MessageWire,
  conversation: Conversation,
  memberMap?: ReadonlyMap<string, GroupMember>,
): string | undefined {
  if (!message.recall || message.recall.sameSender) return undefined;
  const uid = message.recall.revokeUid;
  if (!uid) return undefined;
  return (
    memberMap?.get(uid)?.displayName ??
    (conversation.type === 'direct' && conversation.otherUser.id === uid
      ? conversation.otherUser.displayName
      : undefined)
  );
}

/**
 * Resolve `origSenderUid` (or `origSenderUin`) on every reply element to a
 * human-readable nick. Mirrors `messageSender`'s preference order so the quote
 * box matches the bubble header: memberMap > self > otherUser > uin > uid.
 * Non-reply elements are returned by reference (no copy).
 */
export function enrichReplyElements(
  elements: unknown[],
  conversation: Conversation,
  user: User,
  memberMap?: Map<string, GroupMember>,
  replySources: MessageWire[] | ReplyPreviewIndex = [],
): unknown[] {
  if (!Array.isArray(elements) || elements.length === 0) return elements;
  let mutated = false;
  const out = elements.map((element) => {
    if (!element || typeof element !== 'object') return element;
    const el = element as RenderElementWire;
    if (el.type !== 'reply') return element;
    const data = (el.data ?? {}) as Record<string, unknown>;
    const nick = resolveOrigSenderNick(data, conversation, user, memberMap);
    let preview: unknown[] | undefined;
    if (!Array.isArray(data.origElements) || data.origElements.length === 0) {
      preview = findReplyPreview(
        conversation.type === 'group' ? 'group' : 'c2c',
        data,
        replySources,
      );
    }
    if (!nick && !preview?.length) return element;
    mutated = true;
    return {
      ...el,
      data: {
        ...data,
        ...(nick ? { origSenderDisplayName: nick } : {}),
        ...(preview?.length ? { origElements: preview } : {}),
      },
    };
  });
  return mutated ? out : elements;
}

export function resolveOrigSenderNick(
  data: Record<string, unknown>,
  conversation: Conversation,
  user: User,
  memberMap?: Map<string, GroupMember>,
): string | null {
  const uid = typeof data.origSenderUid === 'string' ? data.origSenderUid : '';
  const uinRaw = data.origSenderUin;
  const uin =
    typeof uinRaw === 'number' ? String(uinRaw) : typeof uinRaw === 'string' ? uinRaw : '';

  // 1) Self — match by uin against the logged-in account's identityValue.
  // (`user.id` is `self:${uin}` so a uid-string comparison never matches.)
  if (uin && uin !== '0' && uin === user.identityValue) {
    return user.displayName || null;
  }

  // 2) Group member directory — uid-keyed; the same map messageSender uses.
  if (uid) {
    const member = memberMap?.get(uid);
    const memberName = member?.displayName;
    if (memberName && memberName !== uin) return memberName;
  }

  // 3) c2c — only two participants. If we already ruled out self in step 1,
  // by elimination the original sender of any quoted message in this direct
  // chat IS the peer. Skip the uid/uin equality dance (origSender* fields
  // are unreliable on c2c: QQ NT often leaves origSenderUid empty and the
  // uin can land as 0 for older quotes).
  if (conversation.type === 'direct') {
    return conversation.otherUser.displayName || null;
  }

  // 4) Fall back to uin (numeric QQ) — readable in the UI even if no profile
  // has been resolved yet. Last resort: the uid string itself.
  if (uin && uin !== '0') return uin;
  if (uid) return uid;
  return null;
}

export function messageBody(elements: unknown[]): string {
  const parts = elements.map(elementText).filter(Boolean);
  return parts.length > 0 ? parts.join('') : '';
}

/**
 * 这条消息的正文是不是**只有**闪照的兜底文案。
 *
 * QQ 在本地库里把闪照存成一条纯文本 `[闪照]请使用新版手机QQ查看闪照。`（元素本体
 * `commonElem(serviceType=3)` 从来没落过库），所以离线看只能显示这句话。识别出来
 * 之后由聊天窗按需走协议拉取补回真正的元素（见 `flashPhotoPlaceholder`）。
 *
 * 只认「整条消息就这一句话」：正常聊天里有人手打这句字面量时也不会误判成闪照，
 * 因为那种消息同样是纯文本 —— 这条判据的代价只是多拉一次协议，拉不到就原样显示。
 */
export function isFlashPhotoPlaceholder(elements: unknown[]): boolean {
  if (!Array.isArray(elements) || elements.length !== 1) return false;
  const element = elements[0] as { type?: string; data?: Record<string, unknown> } | null;
  if (element?.type !== 'text') return false;
  const text = element.data?.textContent;
  return typeof text === 'string' && isFlashPhotoPlaceholderText(text);
}

/**
 * All element kinds defined in @weq/codec's element/spec.ts EXCEPT `unknown`.
 * Keep this list in sync with codec when new element kinds are added — a
 * message carrying any of these is considered renderable (dedicated component,
 * qqMessageRenderer claim, or body text fallback), so it must NOT be filtered
 * out by isRenderableMessage. `unknown` is intentionally excluded: it is the
 * codec's "we didn't recognize this" tag, and a message that contains only
 * `unknown` elements is exactly what we want to drop + log.
 */
export const RENDERABLE_ELEMENT_TYPES = new Set<string>([
  // Basic text & mention.
  'text',
  'at',
  // Rich media (handled by qqMessageRenderer / dedicated media components).
  'pic',
  'file',
  'video',
  'bubbleVideo',
  'ptt',
  'face',
  'mface',
  // Reply quote.
  'reply',
  // Gray tips (dedicated components in chatPane.tsx).
  'grayTipRevoke',
  'grayTipPoke',
  'grayTipGroup',
  'grayTipXml',
  // Rich content (some already render as body text; markdown/ark to be wired up).
  'ark',
  'markdown',
  'multiMsg',
  'call',
  'wallet',
  // 机器人内联键盘（与 markdown 正文成对出现）。
  'inlineKeyboard',
  // Cloud storage links.
  'onlineFile',
  'onlineFolder',
  // Misc.
  'emojiBounce',
  'qqDynamic',
  'shareLocation',
  // Gray tips that carry no gray-tip fields: FILE (subType=10) reuses the FILE
  // tag block, AIO_OP (subType=15) only names the group a temp session came from.
  'grayTipFileRecv',
  'grayTipTempSession',
]);

/**
 * Drop messages that produce nothing on screen: no dedicated gray-tip
 * component, nothing for qqMessageRenderer, and no fallback body text. These
 * used to render as a "[Unsupported message]" bubble — we now log them and
 * skip the bubble entirely. (Note: messages with at least one renderable
 * element still pass even if other elements are unknown.)
 */
export function isRenderableMessage(message: MessageWire): boolean {
  if (message.sourceFormat) return true;
  const elements = message.elements ?? [];
  const hasRenderableElement = elements.some((el) => {
    const type = (el as RenderElementWire | null)?.type;
    return typeof type === 'string' && RENDERABLE_ELEMENT_TYPES.has(type);
  });
  if (hasRenderableElement) return true;
  if (messageBody(elements) !== '') return true;
  console.warn('[unsupported-message] dropping message with no renderable content', {
    msgId: message.msgId,
    msgSeq: message.msgSeq,
    senderUid: message.senderUid,
    elementTypes: elements.map((el) => (el as RenderElementWire | null)?.type ?? null),
  });
  return false;
}

export function findTimelineMessageById(
  messages: readonly MessageWire[],
  id: string,
  seq?: string,
): MessageWire | undefined {
  return (
    messages.find((row) => timelineRowKey(row) === id) ??
    messages.find((row) => row.msgId === id && (!seq || row.msgSeq === seq))
  );
}

/**
 * 按会话内 seq 找「离 targetSeq 最近的」那一条真实消息。
 *
 * 跳转目标可能落在一条 QQ 从未同步过来的「空消息」上（被撤回 / 删除 / 未同步），
 * 这时窗口里没有对应行。退而定位到最近的邻居：相邻两行之间的 seq 缺口会自动渲染
 * 出可点击的「此处有 N 条消息缺失 · 点击拉取」占位条，用户据此就能把消息拉下来，
 * 比直接被丢回最新一页有用得多。
 */
export function nearestBySeq(messages: MessageWire[], targetSeq: string): MessageWire | null {
  if (messages.length === 0) return null;
  let target: bigint;
  try {
    target = BigInt(targetSeq);
  } catch {
    return messages[messages.length - 1] ?? null;
  }
  let best: MessageWire | null = null;
  let bestDistance: bigint | null = null;
  for (const message of messages) {
    let seq: bigint;
    try {
      seq = BigInt(message.msgSeq);
    } catch {
      continue;
    }
    const distance = seq > target ? seq - target : target - seq;
    if (bestDistance === null || distance < bestDistance) {
      best = message;
      bestDistance = distance;
    }
  }
  return best ?? messages[messages.length - 1] ?? null;
}

/**
 * Collect group-member uids referenced INSIDE gray-tip element payloads (poke
 * XML / invite XML / mute info) so the member resolver can pre-fetch their
 * nicks the same way it does for message senders. Only `u_`-prefixed uids are
 * returned — numeric uins can't be resolved via getGroupMembersByUids and
 * would otherwise be re-fetched forever (never landing in the resolved cache).
 */
export function extractGrayTipUids(elements: unknown[]): string[] {
  const uids: string[] = [];
  const pushUid = (value: unknown) => {
    if (typeof value === 'string' && value.startsWith('u_')) uids.push(value);
  };

  for (const element of elements) {
    if (!element || typeof element !== 'object') continue;
    const { type, data = {} } = element as RenderElementWire;

    if (type === 'grayTipPoke' || type === 'grayTipXml') {
      for (const identity of previewIdentityIds({ ...data, kind: type })) pushUid(identity);
    } else if (type === 'grayTipGroup') {
      const mute = data.muteInfo as
        | { operator?: { uid?: unknown }; mutedUser?: { uid?: unknown } }
        | undefined;
      pushUid(mute?.operator?.uid);
      pushUid(mute?.mutedUser?.uid);
    } else if (type === 'grayTipRevoke') {
      // Placeholder / offline recall tips often arrive WITHOUT the sender's nick
      // baked in — only the uids. Pre-resolve them via the group-member resolver
      // so GrayTipRevokeMessage can show "{昵称} 撤回了一条消息" instead of a
      // bare placeholder. (Both are `u_`-prefixed; pushUid filters accordingly.)
      pushUid(data.recallSenderUid);
      pushUid(data.recallRevokeUid);
    }
  }

  return uids;
}

export function elementText(element: unknown): string {
  if (!element || typeof element !== 'object') return '';
  const { type, data = {} } = element as RenderElementWire;

  switch (type) {
    case 'text':
      // Linux / 鸿蒙端的闪传降级文本：别把整段「对方通过QQ闪传发送文件给你…」原样塞进
      // 会话列表预览 / 正文摘要，换成「[QQ闪传] <文件名>」（与真卡片 markdown 的写法一致）。
      return flashPreviewLabel(stringField(data, 'textContent'));
    case 'at':
      return stringField(data, 'textContent');
    case 'face':
      return stringField(data, 'faceText') || stringField(data, 'localPath') || '[Emoji]';
    case 'pic':
      return attachmentText('Image', data, 'fileName', 'summary');
    case 'file':
      return attachmentText('File', data, 'fileName');
    case 'onlineFile':
      return attachmentText('在线文件', data, 'fileName');
    case 'onlineFolder':
      return attachmentText('在线文件夹', data, 'fileName');
    case 'video':
      return attachmentText('Video', data, 'fileName', 'summary');
    case 'ptt':
      return attachmentText('Voice', data, 'fileName', 'summary');
    case 'reply':
      return quoteText('Reply', data, 'replyTextSummary');
    case 'grayTipRevoke':
      return stringField(data, 'recallDisplayText') || '[Message recalled]';
    case 'grayTipPoke':
      return stringField(data, 'grayTipXmlContent') || stringField(data, 'tipJson') || '[Poke]';
    case 'grayTipGroup': {
      if (data.groupTipType === TipGroupElementType.KGROUPNAMEMODIFIED) {
        return groupTipText(data) ?? '[Group notice]';
      }
      const muteDuration = data.muteDuration as number | undefined;
      const user1 =
        (data.user1GroupNick as string | undefined) || (data.user1Nick as string | undefined);
      const user2 =
        (data.user2GroupNick as string | undefined) || (data.user2Nick as string | undefined);
      const hasMutedUser = data.mutedUserInfo !== undefined;

      if (muteDuration !== undefined && user1) {
        if (hasMutedUser && user2) {
          return muteDuration > 0 ? `${user2} 被 ${user1} 禁言` : `${user1} 结束了 ${user2} 的禁言`;
        }
        return muteDuration > 0 ? `${user1} 开启了全员禁言` : `${user1} 关闭了全员禁言`;
      }
      if (data.groupTipType === 1 && user1) {
        return `${user1} 加入了群聊`;
      }
      if (data.groupTipType === 2) {
        return '该群已被群主解散';
      }
      if (data.groupTipType === 3 && user1) {
        return `${user1} 已将你移出群聊`;
      }
      return '[Group notice]';
    }
    case 'ark':
      return arkPreview(stringField(data, 'arkData'));
    case 'markdown': {
      // QQ 闪传 card → clean label instead of the raw `[闪传](mqqapi://…)` link.
      const flashInfo = data.flashTransferInfo;
      if (flashInfo && typeof flashInfo === 'object' && Object.keys(flashInfo).length > 0) {
        const title = flashTransferTitle(stringField(data, 'markdownContent'));
        return title ? `[QQ闪传] ${title}` : '[QQ闪传]';
      }
      return (
        stringField(data, 'markdownContent') ||
        stringField(data, 'markdownTextSummary') ||
        '[Markdown]'
      );
    }
    case 'multiMsg':
      return '[Merged messages]';
    case 'call':
      return arraySummary(data, 'callSummary') || '[Call]';
    case 'wallet': {
      const detail = (data.walletDetail ?? {}) as Record<string, unknown>;
      const type = Number(detail.redbagType ?? data.walletRedbagType);
      const title = typeof detail.redbagTitle === 'string' ? detail.redbagTitle : '';
      if (type === 1) return title ? `[转账] ${title}` : '[转账]';
      return title ? `[QQ红包] ${title}` : '[QQ红包]';
    }
    case 'mface':
      return '[Sticker]';
    case 'emojiBounce':
      return (
        stringField(data, 'emojiBounceTextSummary') ||
        stringField(data, 'emojiBouncePcText') ||
        '[Emoji interaction]'
      );
    case 'qqDynamic': {
      const desc = (data.dynamicDesc ?? {}) as Record<string, unknown>;
      const main = typeof desc.mainDesc === 'string' ? desc.mainDesc : '';
      return main ? `[QQ动态] ${main}` : '[QQ动态]';
    }
    case 'shareLocation':
      return stringField(data, 'shareLocationText') || '[位置共享]';
    case 'grayTipFileRecv': {
      const name = stringField(data, 'fileName');
      return name ? `[文件传输完成: ${name}]` : '[文件传输完成]';
    }
    case 'grayTipTempSession': {
      const code = stringField(data, 'tempSessionGroupCode');
      return code ? `[临时会话] 来自群 ${code}` : '[临时会话]';
    }
    case 'unknown':
      if ('nativeElement' in data) return '[未解析的原生消息]';
      console.warn('[unsupported-element] unknown element type encountered', data);
      return '';
    default:
      return '';
  }
}

export function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

export function arraySummary(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (!Array.isArray(value)) return '';
  return value.filter((item): item is string => typeof item === 'string').join(' ');
}

export function attachmentText(
  label: string,
  data: Record<string, unknown>,
  nameKey: string,
  summaryKey?: string,
): string {
  const summary = summaryKey ? arraySummary(data, summaryKey) : '';
  const name = stringField(data, nameKey);
  return summary || (name ? `[${label}] ${name}` : `[${label}]`);
}

export function quoteText(label: string, data: Record<string, unknown>, key: string): string {
  const text = stringField(data, key);
  return text ? `> ${text}` : `[${label}]`;
}

/**
 * Short, human-friendly preview text for an `ark` card (used by the
 * conversation-list last-message line). Prefers the share's `prompt`, then a
 * title-ish field off the first meta payload, falling back to a generic tag.
 */
export function arkPreview(raw: string): string {
  if (!raw) return '[卡片消息]';
  try {
    const ark = JSON.parse(raw) as {
      prompt?: string;
      meta?: Record<string, Record<string, unknown>>;
    };
    if (typeof ark.prompt === 'string' && ark.prompt.trim()) return ark.prompt.trim();
    const meta = ark.meta ? Object.values(ark.meta)[0] : undefined;
    if (meta) {
      const pick = (k: string): string => (typeof meta[k] === 'string' ? (meta[k] as string) : '');
      const t =
        pick('title') || pick('nickname') || pick('summary') || pick('desc') || pick('name');
      if (t) return t;
    }
    return '[卡片消息]';
  } catch {
    return '[卡片消息]';
  }
}
