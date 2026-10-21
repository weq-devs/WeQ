import type { SendElement } from '@weq/protocol';
import { FaceSubType } from '@weq/codec';
import { cleanNtPath, codecElementToSeg, segToSendElement } from '../components/mergeForward/model';
import type { ComposerSendPlan, SuperStickerEntry } from '../im-template/template/composerSend';
import { localFileUrl, mediaUrl } from './resourceUrl';

/** 本地路径经账号代理验证；路径失效时回退消息图片代理，不直接读取路径字符串。 */
export async function repeatImageSources(
  elements: RepeatElement[],
  time: number,
  signal?: AbortSignal,
  resolvedUrls?: Map<RepeatElement, string>,
): Promise<Map<RepeatElement, Uint8Array>> {
  const result = new Map<RepeatElement, Uint8Array>();
  for (const element of elements) {
    if (element.type !== 'pic') continue;
    const data = element.data ?? {};
    const url = mediaUrl('pic', {
      t: time,
      name: text(data.fileName),
      token: text(data.fileToken),
      orig: text(data.originalUrl),
      md5: digest(data),
      recv: data.subType === 1 ? 1 : 0,
    });
    const path = cleanNtPath(text(data.localPath) || text(data.filePath));
    for (const candidate of [...(path ? [localFileUrl(path)] : []), url]) {
      let response: Response;
      try {
        response = signal ? await fetch(candidate, { signal }) : await fetch(candidate);
      } catch (cause) {
        if (signal?.aborted) throw cause;
        continue;
      }
      if (!response.ok) continue;
      if (Number(response.headers.get('content-length')) > 50 * 1024 * 1024)
        throw new Error('图片超过 50 MiB，未发送。');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 50 * 1024 * 1024) throw new Error('图片超过 50 MiB，未发送。');
      if (!bytes.length) continue;
      result.set(element, bytes);
      resolvedUrls?.set(element, candidate);
      break;
    }
    if (!result.has(element)) throw new Error('图片原文件不可用，未发送。');
  }
  return result;
}

export interface RepeatElement {
  type?: string;
  data?: Record<string, unknown>;
}
export interface RepeatMessage {
  id: string;
  qqElements?: RepeatElement[];
  body?: string;
  optimistic?: string;
  optimisticRejected?: boolean;
  deletedKind?: string;
  recall?: unknown;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function digest(data: Record<string, unknown>): string {
  return text(data.md5 || data.md5Bytes || data.contentHash).toLowerCase();
}
function elementIdentity(element: RepeatElement): unknown[] | null {
  const data = element.data ?? {};
  switch (element.type) {
    case 'text':
      return ['text', text(data.textContent)];
    case 'at':
      return ['at', text(data.atTargetUid) || data.atTargetUin];
    case 'face':
      return [
        'face',
        data.faceId,
        data.subType ?? 1,
        data.innerId ?? '',
        data.interactiveFaceCombo ?? 0,
      ];
    case 'mface':
      return /^[0-9a-f]{32}$/i.test(text(data.marketEmoticonIdHex)) && Number(data.emojiPackId) > 0
        ? ['mface', data.emojiPackId, text(data.marketEmoticonIdHex).toLowerCase()]
        : null;
    case 'pic':
    case 'video':
    case 'ptt':
      return digest(data) ? [element.type, digest(data), data.subType ?? 0] : null;
    case 'reply':
      return [
        'reply',
        data.origSenderUid ?? data.origSenderUin,
        data.origMsgSeq,
        data.origMsgIndex,
        contentIdentity(Array.isArray(data.origElements) ? data.origElements : []),
      ];
    case 'ark':
      return ['ark', text(data.arkData)];
    case 'markdown':
      return ['markdown', text(data.markdownContent)];
    case 'multiMsg':
      return data.resId || data.multiMsgResId || data.xmlContent
        ? ['multiMsg', data.resId ?? data.multiMsgResId, data.xmlContent]
        : null;
    case 'file':
      return digest(data) ? ['file', digest(data), data.fileName] : null;
    default:
      return null;
  }
}
function contentIdentity(elements: RepeatElement[]): unknown[][] | null {
  const result: unknown[][] = [];
  for (const element of elements) {
    const identity = elementIdentity(element);
    if (!identity) return null;
    if (identity[0] === 'text') {
      if (!identity[1]) continue;
      const previous = result.at(-1);
      if (previous?.[0] === 'text') {
        previous[1] = String(previous[1]) + String(identity[1]);
        continue;
      }
    }
    result.push(identity);
  }
  return result.length ? result : null;
}

/** 与连续消息 +1 共用元素白名单，系统、交易和未知内容不能降级成文字重发。 */
export function canRepeatMessage(message: RepeatMessage): boolean {
  return (
    !message.optimistic &&
    !message.optimisticRejected &&
    !message.deletedKind &&
    !message.recall &&
    contentIdentity(message.qqElements ?? []) !== null
  );
}

/** 只判断最新的两条，不越过灰条、撤回、失败条目，也不把历史窗口末尾当作最新消息。 */
export function repeatTarget<T extends RepeatMessage>(
  messages: readonly T[],
  atLatest: boolean,
): T | null {
  if (!atLatest || messages.length < 2) return null;
  const pair = messages.slice(-2);
  if (pair.some((message) => !canRepeatMessage(message))) return null;
  const identities = pair.map((message) => contentIdentity(message.qqElements ?? []));
  return identities[0] &&
    identities[1] &&
    JSON.stringify(identities[0]) === JSON.stringify(identities[1])
    ? pair[1]!
    : null;
}

function repeatElementSegment(element: RepeatElement) {
  const data = element.data ?? {};
  return codecElementToSeg(
    {
      ...data,
      ...(['ptt', 'video', 'file'].includes(element.type ?? '') && text(data.localPath)
        ? { filePath: cleanNtPath(text(data.localPath)) }
        : {}),
      kind: element.type,
      ...(element.type === 'mface' ? { marketEmoticonId: data.marketEmoticonIdHex } : {}),
    },
    element,
  );
}

/** 逐条转发的静态预检；图片下载、表情目录与网络失败仍由真实发送结果处理。 */
export function forwardUnsupportedReason(elements: readonly RepeatElement[]): string | null {
  const content = elements.filter((element) => element.type !== 'reply');
  if (!content.length) return '消息没有可重发的内容';
  for (const element of content) {
    if (element.type === 'pic') continue;
    const data = element.data ?? {};
    if (element.type === 'at') {
      if (!data.atTargetUid && !data.atTargetUin) return '提及缺少目标身份';
      continue;
    }
    if (element.type === 'face') {
      if (
        data.subType == null ||
        [
          FaceSubType.QQ_BUILTIN_OLD,
          FaceSubType.QQ_BUILTIN_NEW,
          FaceSubType.SUPER_EMOJI,
          FaceSubType.INTERACTIVE,
        ].includes(Number(data.subType))
      )
        continue;
      return '此类表情尚不能等价重发';
    }
    const segment = repeatElementSegment(element);
    if (!segment || segment.t === 'opaque' || segment.t === 'node')
      return `此类内容尚不能等价重发：${element.type ?? '未知元素'}`;
  }
  if (content.some((element) => element.type === 'file') && content.length > 1)
    return '文件不能与其他元素混合重发';
  if (
    content.every((element) => element.type === 'text' && !text(element.data?.textContent).trim())
  )
    return '消息没有可重发的内容';
  return null;
}

function sendElement(
  element: RepeatElement,
  stickers: Map<string, SuperStickerEntry>,
  group: boolean,
  images: Map<RepeatElement, Uint8Array>,
): SendElement {
  const data = element.data ?? {};
  if (element.type === 'pic' && images.has(element))
    return {
      kind: 'image',
      source: images.get(element)!,
      fileName: text(data.fileName) || 'image',
      subType: Number(data.subType) || 0,
    };
  if (element.type === 'at') {
    if (!data.atTargetUid && !data.atTargetUin)
      throw new Error('提及缺少目标身份，不能作为普通文字重发。');
    return {
      kind: 'at',
      textContent: text(data.textContent),
      atTargetUid: text(data.atTargetUid),
      ...(typeof data.atTargetUin === 'number' ? { atTargetUin: data.atTargetUin } : {}),
      ...(data.atTargetUid === 'all' ? { all: true } : {}),
    };
  }
  if (element.type === 'face') {
    const faceId = Number(data.faceId);
    if (data.subType === FaceSubType.INTERACTIVE)
      return { kind: 'pokeEmoji', pokeId: faceId, combo: Number(data.interactiveFaceCombo) || 0 };
    if (data.subType === FaceSubType.SUPER_EMOJI) {
      const sticker = stickers.get(String(faceId));
      if (!sticker) throw new Error('找不到超级表情目录，不能以普通表情代替。');
      return {
        kind: 'face',
        faceId,
        faceText: text(data.faceText),
        superSticker: { ...sticker, ...(data.innerId ? { resultId: String(data.innerId) } : {}) },
      };
    }
    if (
      data.subType != null &&
      data.subType !== FaceSubType.QQ_BUILTIN_OLD &&
      data.subType !== FaceSubType.QQ_BUILTIN_NEW
    )
      throw new Error('此类表情尚不能等价重发。');
    return {
      kind: 'face',
      faceId,
      faceText: text(data.faceText),
      ...(data.subType === FaceSubType.QQ_BUILTIN_NEW || faceId >= 260 ? { smallFace: true } : {}),
    };
  }
  if (element.type === 'reply') {
    const seq = Number((group ? data.origMsgSeq : data.origMsgIndex) ?? data.origMsgSeq);
    if (!Number.isSafeInteger(seq) || seq <= 0) throw new Error('引用缺少有效原消息指针。');
    return {
      kind: 'reply',
      origMsgSeq: seq,
      ...(data.origSenderUin ? { origSenderUin: Number(data.origSenderUin) } : {}),
      ...(data.origMsgTime ? { origMsgTime: Number(data.origMsgTime) } : {}),
      origElements: Array.isArray(data.origElements)
        ? data.origElements.map((item) =>
            sendElement(item as RepeatElement, stickers, group, images),
          )
        : [],
    };
  }
  const segment = repeatElementSegment(element);
  if (!segment || segment.t === 'opaque' || segment.t === 'node')
    throw new Error(`此类内容尚不能等价重发：${element.type ?? '未知元素'}`);
  if (segment.t === 'video' && text(data.thumbLocalPath))
    segment.thumbPath = cleanNtPath(text(data.thumbLocalPath));
  return segToSendElement(segment);
}

export function repeatNeedsStickerCatalog(elements: RepeatElement[]): boolean {
  return elements.some(
    (element) =>
      (element.type === 'face' && element.data?.subType === FaceSubType.SUPER_EMOJI) ||
      (element.type === 'reply' &&
        Array.isArray(element.data?.origElements) &&
        repeatNeedsStickerCatalog(element.data.origElements)),
  );
}

/** 沿用合并转发的媒体/卡片转换器；只允许等价元素，绝不使用 opaque 的文字降级。 */
export function repeatSendPlan(
  elements: RepeatElement[],
  stickers: Map<string, SuperStickerEntry>,
  group: boolean,
  images = new Map<RepeatElement, Uint8Array>(),
): ComposerSendPlan {
  if (!elements.length) throw new Error('消息没有可重发的内容。');
  const outgoing = elements.map((element) => sendElement(element, stickers, group, images));
  if (outgoing.length === 1 && outgoing[0]?.kind === 'file') {
    if (typeof outgoing[0].source !== 'string' || !outgoing[0].source)
      throw new Error('文件缺少本机路径。');
    return { kind: 'file', path: outgoing[0].source, fileName: outgoing[0].fileName ?? '' };
  }
  if (outgoing.some((element) => element.kind === 'file'))
    throw new Error('文件不能与其他元素混合重发。');
  return { kind: 'elements', elements: outgoing };
}
