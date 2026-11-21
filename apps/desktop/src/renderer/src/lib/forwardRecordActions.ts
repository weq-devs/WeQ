import { unixDate } from '@weq/time';
import { plainMessageText } from '@weq/service/message-plain-text';
import type { ForwardCardTarget, ForwardRecordTarget } from '@weq/service';
import type { ContentSelection } from '../../../shared/content_selection';
import type { Message } from '../im-template/template/types';
import type { ForwardRecordWire, ForwardWindowState } from '../state/forwardWindow';
import { messageContentText } from './messageClipboard';
import { shouldShowMessageTime } from '../im-template/template/messageTime.shared';
import {
  consecutiveMessageGroups,
  type MessageGroupPosition,
} from '../im-template/template/chatTimelineModel';
import { grayTipOf } from '../im-template/template/messageRow.shared';
import { isArkMultiMsg } from '../components/ForwardWindow.shared';

export type ForwardEntry = {
  id: string;
  index: number;
  record: ForwardRecordWire;
  sendTimeMs: number;
  showTime: boolean;
  groupPosition?: MessageGroupPosition;
};

export function forwardEntries(win: Pick<ForwardWindowState, 'id' | 'records'>): ForwardEntry[] {
  let previousTime: number | undefined;
  const entries: ForwardEntry[] = (win.records ?? []).map((record, index) => {
    const sendTimeMs = unixDate(record.sendTime)?.getTime() ?? 0;
    const showTime = sendTimeMs > 0 && shouldShowMessageTime(previousTime, sendTimeMs);
    if (sendTimeMs > 0) previousTime = sendTimeMs;
    return { id: `forward:${win.id}:${index}`, index, record, sendTimeMs, showTime };
  });
  const groups = consecutiveMessageGroups(
    entries,
    ({ record, sendTimeMs }) => {
      if (sendTimeMs <= 0 || grayTipOf(record)) return;
      const senderId = /^[1-9]\d*$/.test(record.senderUin ?? '') ? record.senderUin : undefined;
      const senderUid = record.senderUid && record.senderUid !== '0' ? record.senderUid : undefined;
      if (senderId || senderUid) return { senderId, senderUid, time: sendTimeMs };
    },
    (_previous, entry) => entry.showTime,
  );
  entries.forEach((entry, index) => {
    entry.groupPosition = groups[index];
  });
  return entries;
}

export function isForwardContinuation({ groupPosition }: ForwardEntry) {
  return groupPosition === 'middle' || groupPosition === 'last';
}

export function forwardSenderName(record: ForwardRecordWire) {
  return record.sendNick || record.senderUin || record.senderUid || '未知用户';
}

export function forwardSenderKey(entry: ForwardEntry) {
  const { senderUin, senderUid, sendNick } = entry.record;
  return (
    senderUid ||
    (/^[1-9]\d*$/.test(senderUin ?? '') ? `qq:${senderUin}` : '') ||
    (sendNick ? `name:${sendNick}` : entry.id)
  );
}

export function forwardMessage(win: ForwardWindowState, entry: ForwardEntry): Message {
  const { id, record, sendTimeMs } = entry;
  const uin = /^[1-9]\d*$/.test(record.senderUin ?? '') ? record.senderUin! : '';
  const senderId = record.senderUid || uin || forwardSenderKey(entry);
  return {
    id,
    msgId: record.msgId || undefined,
    conversationId: `forward:${win.id}`,
    senderId,
    sender: {
      id: senderId,
      uid: record.senderUid,
      identityLabel: uin ? 'QQ' : 'UID',
      identityValue: uin || record.senderUid || '',
      username: senderId,
      displayName: forwardSenderName(record),
      avatarUrl: uin ? `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}` : null,
    },
    body: messageContentText(record.elements),
    qqElements: record.elements,
    createdAt: sendTimeMs > 0 ? new Date(sendTimeMs).toISOString() : '',
    decoration: record.decoration,
    forwardSnapshot: { carrierId: win.rootMsgId, kind: win.kind, conv: win.conv },
  };
}

export function forwardRecordTarget(entry: ForwardEntry): ForwardRecordTarget {
  return { index: entry.index, msgId: entry.record.msgId || '' };
}

export function forwardExportSelection(
  win: ForwardWindowState,
  selection: readonly ForwardEntry[] | { entry: ForwardEntry; card: ForwardCardTarget },
): ContentSelection | null {
  const source = win.exportSource;
  if (!source || source.carrierId.startsWith('optimistic-')) return null;
  const target =
    'entry' in selection
      ? {
          ...source.card,
          path: [
            ...(source.card.path ?? []),
            { ...selection.card, record: forwardRecordTarget(selection.entry) },
          ],
        }
      : { ...source.card, records: selection.map(forwardRecordTarget) };
  return {
    owner: { ...source.owner, forwardTarget: target },
    scope: { type: 'items', ids: [source.carrierId] },
  };
}

export function forwardTextClipboard(messages: readonly Message[]) {
  return messages
    .map((message) =>
      plainMessageText({
        name: message.sender?.displayName || '未知用户',
        uin: message.sender?.identityLabel === 'QQ' ? message.sender.identityValue : undefined,
        time: message.createdAt ? new Date(message.createdAt) : undefined,
        elements: message.qqElements,
        body: message.body || '[消息]',
      }),
    )
    .join('\n\n');
}

/** 面向剪贴板的阅读内容保留已加载的嵌套记录，不触发补拉。 */
export function forwardClipboardElements(
  record: ForwardRecordWire,
  depth = 0,
): ForwardRecordWire['elements'] {
  if (!record.subMsgs?.length || depth >= 8) return record.elements;
  return record.elements.map((element) => {
    if (
      element.type !== 'multiMsg' &&
      !(element.type === 'ark' && isArkMultiMsg(element.data?.arkData))
    )
      return element;
    return {
      type: 'multiMsg',
      data: {
        ...element.data,
        forwardMessages: record.subMsgs!.map((child) => ({
          senderName: forwardSenderName(child),
          senderUin: child.senderUin,
          sendTime: Number(child.sendTime) || 0,
          elements: forwardClipboardElements(child, depth + 1),
        })),
      },
    };
  });
}

export function forwardIntentText(entry: ForwardEntry, includeImages = true) {
  return entry.record.elements
    .flatMap((element) => {
      if (element.type === 'text' || element.type === 'at')
        return String(element.data?.textContent ?? '').trim();
      if (element.type === 'face') return String(element.data?.faceText ?? '').trim();
      if (includeImages && element.type === 'pic') return '[图片]';
      if (includeImages && element.type === 'mface') return '[表情包]';
      return [];
    })
    .join(' ')
    .trim();
}

export function forwardIntentInput(entry: ForwardEntry) {
  const images = entry.record.elements
    .filter(({ type }) => type === 'pic' || type === 'mface')
    .slice(0, 20)
    .map(({ type, data = {} }) =>
      type === 'pic'
        ? {
            kind: 'pic' as const,
            fileName: String(data.fileName ?? '').slice(0, 512),
            fileToken: String(data.fileToken ?? '').slice(0, 4096),
            imgWidth: Math.max(0, Number(data.imgWidth) || 0),
            imgHeight: Math.max(0, Number(data.imgHeight) || 0),
            md5: String(data.md5 ?? '').slice(0, 64),
            originalUrl: String(data.originalUrl ?? '').slice(0, 4096),
            subType: Number(data.subType) || 0,
          }
        : {
            kind: 'mface' as const,
            emojiPackId: String(data.emojiPackId ?? '').slice(0, 32),
            marketEmoticonIdHex: String(data.marketEmoticonIdHex ?? '').slice(0, 128),
          },
    );
  return {
    sender: forwardSenderKey(entry).slice(0, 512),
    sendTime: Math.floor(entry.sendTimeMs / 1000),
    text: forwardIntentText(entry, false).slice(0, 32768),
    ...(images.length ? { images } : {}),
  };
}
