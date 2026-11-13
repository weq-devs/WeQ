import { eventTimeFormatter } from '@weq/time';
import { arkClipboardText, cardClipboardText } from './cardClipboard';
import { UNICODE_FACE_MAP } from './unicodeFaceMap';

export interface PlainElement {
  type?: string;
  data?: object;
}
export interface PlainSender {
  name?: string;
  uin?: string | number | bigint;
}
export type PlainSenderLookup = (uid: string, uin: string) => PlainSender | undefined;
export interface PlainMessage extends PlainSender {
  time?: Date;
  elements?: readonly PlainElement[];
  body?: string;
  resolveSender?: PlainSenderLookup;
}
const timestamp = eventTimeFormatter;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const elementsOf = (value: unknown): PlainElement[] =>
  Array.isArray(value)
    ? value.filter((item): item is PlainElement => Boolean(item && typeof item === 'object'))
    : [];
const uinText = (value: unknown): string => {
  const result =
    typeof value === 'number' || typeof value === 'bigint' ? String(value) : text(value);
  return /^[1-9]\d*$/.test(result) ? result : '';
};
const bracket = (value: string): string =>
  value.startsWith('[') && value.endsWith(']') ? value : `[${value}]`;

export function plainSenderText(sender: PlainSender): string {
  const uin = uinText(sender.uin);
  const name = sender.name?.trim();
  return name && name !== uin ? `${name}${uin ? ` (${uin})` : ''}` : uin || '未知发送者';
}
export function plainMessageText(message: PlainMessage, depth = 0): string {
  const time =
    message.time && Number.isFinite(message.time.getTime())
      ? timestamp.format(message.time)
      : '时间未知';
  return `${plainSenderText(message)} · ${time}\n${plainContentText(message.elements, message.body, depth, message.resolveSender) || '[消息]'}`;
}

/** 引用、卡片与转发共用文本语义；只接受显式导出路径，不读取本机缓存路径。 */
export function plainElementText(
  element: PlainElement,
  depth = 0,
  resolveSender?: PlainSenderLookup,
): string {
  const data = record(element.data);
  const fileName = text(data.fileName);
  const media = (kind: string, name = fileName): string => {
    const path = text(data.exportPath);
    return `[${kind}${name ? `: ${name}` : ''}]${path ? `\n附件：${path}` : ''}`;
  };
  switch (element.type) {
    case 'text':
    case 'at':
      return text(data.textContent) || text(data.content);
    case 'face':
      return (
        UNICODE_FACE_MAP[Number(data.faceId)] ||
        bracket(text(data.faceText) || `表情${data.faceId ?? ''}`)
      );
    case 'mface':
      return media('表情包', text(data.faceName || data.faceText).replace(/^\[|\]$/g, ''));
    case 'pic':
      return media(data.subType === 1 ? '表情包' : '图片');
    case 'video':
    case 'bubbleVideo':
      return media('视频');
    case 'file':
    case 'onlineFile':
      return media('文件');
    case 'onlineFolder':
      return media('文件夹');
    case 'ptt': {
      const duration =
        typeof data.pttDuration === 'number' && data.pttDuration > 0 ? `${data.pttDuration}秒` : '';
      const transcript = text(data.pttTranscript);
      return `${media('语音', fileName || duration)}${transcript ? `\n[语音转写]\n${transcript}` : ''}`;
    }
    case 'ark':
      return arkClipboardText(data.arkData, data.summary);
    case 'markdown': {
      const flash = record(data.flashTransferInfo);
      if (Object.keys(flash).length)
        return cardClipboardText('QQ 闪传卡片', [
          flash.thumbnailName,
          typeof flash.fileBytes === 'number' ? `文件大小：${flash.fileBytes} 字节` : '',
          data.markdownTextSummary,
        ]);
      return cardClipboardText('Markdown 卡片', [
        data.markdownContent49099 || data.markdownContent || data.markdownTextSummary,
      ]);
    }
    case 'shareLocation':
      return cardClipboardText('位置卡片', [data.shareLocationText]);
    case 'qqDynamic':
      return cardClipboardText('QQ 动态卡片', [
        record(data.dynamicDesc).mainDesc,
        record(data.dynamicDesc).subDesc,
        record(data.dynamicDesc2).mainDesc,
        record(data.dynamicDesc2).subDesc,
      ]);
    case 'multiMsg':
    case 'forward': {
      if (depth >= 8 || !Array.isArray(data.forwardMessages) || !data.forwardMessages.length)
        return '[聊天记录]';
      const rows = data.forwardMessages.map((row) => {
        const message = record(row);
        return plainMessageText(
          {
            name: text(message.senderName),
            uin: uinText(message.senderUin),
            time:
              typeof message.sendTime === 'number' && message.sendTime > 0
                ? new Date(message.sendTime * 1000)
                : undefined,
            elements: elementsOf(message.elements),
            resolveSender,
          },
          depth + 1,
        )
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n');
      });
      return `[聊天记录]\n${rows.join('\n\n')}\n[/聊天记录]`;
    }
    case 'grayTipRevoke':
      return bracket(text(data.recallDisplayText) || '撤回了一条消息');
    case 'grayTipPoke':
      return '[戳一戳]';
    case 'grayTipGroup':
    case 'grayTipXml':
      return '[群提示]';
    case 'grayTipFileRecv':
      return bracket(`文件传输完成${fileName ? `: ${fileName}` : ''}`);
    case 'grayTipTempSession':
      return bracket(
        `临时会话${data.tempSessionGroupCode ? `: 来自群 ${data.tempSessionGroupCode}` : ''}`,
      );
    case 'emojiBounce':
      return text(data.emojiBounceTextSummary || data.emojiBouncePcText) || '[表情]';
    case 'call':
      return '[通话]';
    case 'wallet':
      return '[红包/转账]';
    default:
      return text(data.textContent || data.content || data.summary);
  }
}

export function plainBodyElements<T extends PlainElement>(elements: readonly T[]): readonly T[] {
  const card = elements.find((element) =>
    ['ark', 'qqDynamic', 'shareLocation'].includes(element.type ?? ''),
  );
  if (card) return [card];
  const markdown = elements.filter((element) => element.type === 'markdown');
  return markdown.length ? markdown : elements.filter((element) => element.type !== 'reply');
}

export function plainContentText(
  elements: readonly PlainElement[] = [],
  fallback = '',
  depth = 0,
  resolveSender?: PlainSenderLookup,
): string {
  if (depth > 8) return '[引用消息]';
  const quotes = elements
    .filter((element) => element.type === 'reply')
    .map((element) => {
      const data = record(element.data);
      const uin = uinText(data.origSenderUin);
      const sender = resolveSender?.(text(data.origSenderUid), uin);
      const name = sender?.name || text(data.origSenderName);
      const identity = name || uin ? plainSenderText({ name, uin: sender?.uin || uin }) : '';
      const body =
        plainContentText(
          elementsOf(data.origElements),
          text(data.origText || data.replyTextSummary),
          depth + 1,
          resolveSender,
        ) || '引用消息';
      return [identity, body]
        .filter(Boolean)
        .join('\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    });
  let body = '';
  let previousBlock = false;
  for (const element of plainBodyElements(elements)) {
    const value = plainElementText(element, depth, resolveSender);
    if (!value) continue;
    const block = !['text', 'at', 'face', 'emojiBounce'].includes(element.type ?? '');
    if (body && (block || previousBlock) && !body.endsWith('\n') && !value.startsWith('\n'))
      body += '\n';
    body += value;
    previousBlock = block;
  }
  return [...quotes, body || fallback].filter(Boolean).join('\n');
}
