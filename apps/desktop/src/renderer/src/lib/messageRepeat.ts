import type { SendElement } from '@weqbot/protocol';
import { FaceSubType } from '@weq/codec';
import { cleanNtPath, codecElementToSeg, segToSendElement } from '../components/mergeForward/model';
import type { ComposerSendPlan, SuperStickerEntry } from '../im-template/template/composerSend';
import { localFileUrl, mediaUrl } from './resourceUrl';
import { flashPicUrl } from './cdn';

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
    const url = isFlashPhoto(element)
      ? flashPicUrl(text(data.fileToken), 0)
      : mediaUrl('pic', {
          t: time,
          name: text(data.fileName),
          token: text(data.fileToken),
          orig: text(data.originalUrl),
          md5: digest(data),
          recv: data.subType === 1 ? 1 : 0,
        });
    const path = cleanNtPath(text(data.localPath) || text(data.filePath));
    for (const candidate of [...(path ? [localFileUrl(path)] : []), ...(url ? [url] : [])]) {
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
function isFlashPhoto(element: RepeatElement): boolean {
  return (
    element.type === 'pic' &&
    (element.data?.isFlash === true || text(element.data?.fileToken).startsWith('/'))
  );
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
      return digest(data) ? ['pic', digest(data), data.subType ?? 0, isFlashPhoto(element)] : null;
    case 'video':
    case 'bubbleVideo':
    case 'ptt':
      return digest(data)
        ? [element.type, digest(data), data.subType ?? 0, data.templateName ?? '']
        : null;
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
      return ['markdown', text(data.markdownContent), data.flashTransferInfo ?? null];
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

/** 手动 +1 按实际内容判断；保留来源不阻止重发，未知内容不能降级成摘要文字。 */
export function canRepeatMessage(message: RepeatMessage): boolean {
  return (
    !message.optimistic &&
    !message.optimisticRejected &&
    forwardUnsupportedReason(message.qqElements ?? []) === null
  );
}

/** 自动提示只判断最新两条，不越过灰条、撤回、删除和失败，也不把历史窗口当作最新。 */
export function repeatTarget<T extends RepeatMessage>(
  messages: readonly T[],
  atLatest: boolean,
): T | null {
  if (!atLatest || messages.length < 2) return null;
  const pair = messages.slice(-2);
  if (pair.some((message) => message.deletedKind || message.recall || !canRepeatMessage(message)))
    return null;
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
      ...(['ptt', 'video', 'bubbleVideo', 'file'].includes(element.type ?? '') &&
      text(data.localPath)
        ? { filePath: cleanNtPath(text(data.localPath)) }
        : {}),
      // 封面路径不能冒充视频原文件；圆形视频复用视频资源转换，但发送类型单独保留。
      ...(['video', 'bubbleVideo'].includes(element.type ?? '')
        ? { videoCoverLocalPath: undefined, fileThumbLocalPath: undefined }
        : {}),
      kind: element.type === 'bubbleVideo' ? 'video' : element.type,
      ...(element.type === 'mface' ? { marketEmoticonId: data.marketEmoticonIdHex } : {}),
    },
    element,
  );
}

/** 卡片等消息可携带空文本占位；只去掉空串，不改动实际空格与换行。 */
function withoutEmptyTextElements(elements: readonly RepeatElement[]): RepeatElement[] {
  return elements.filter(
    (element) => element.type !== 'text' || text(element.data?.textContent).length > 0,
  );
}

/** 逐条转发的静态预检；图片下载、表情目录与网络失败仍由真实发送结果处理。 */
export function forwardUnsupportedReason(elements: readonly RepeatElement[]): string | null {
  const content = withoutEmptyTextElements(elements).filter((element) => element.type !== 'reply');
  if (!content.length) return '消息没有可重发的内容';
  for (const element of content) {
    if (element.type === 'pic') continue;
    const data = element.data ?? {};
    if (element.type === 'markdown' && data.flashTransferInfo != null) {
      const info = data.flashTransferInfo;
      if (typeof info !== 'object' || !('fileSetId' in info) || !text(info.fileSetId).trim())
        return '闪传卡片缺少文件集身份';
    }
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
  if (
    content.length > 1 &&
    content.some(
      (element) => element.type === 'markdown' && element.data?.flashTransferInfo != null,
    )
  )
    return '闪传卡片不能与其他内容混合重发';
  return null;
}

function sendElement(
  element: RepeatElement,
  stickers: Map<string, SuperStickerEntry>,
  group: boolean,
  images: Map<RepeatElement, Uint8Array>,
): SendElement {
  const data = element.data ?? {};
  if (isFlashPhoto(element)) {
    const source = images.get(element);
    if (!source?.length) throw new Error('闪照原文件不可用，未发送。');
    return { kind: 'flashPhoto', source };
  }
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
        ? withoutEmptyTextElements(data.origElements).map((item) =>
            sendElement(item, stickers, group, images),
          )
        : [],
    };
  }
  const segment = repeatElementSegment(element);
  if (!segment || segment.t === 'opaque' || segment.t === 'node')
    throw new Error(`此类内容尚不能等价重发：${element.type ?? '未知元素'}`);
  if (segment.t === 'video' && text(data.thumbLocalPath))
    segment.thumbPath = cleanNtPath(text(data.thumbLocalPath));
  if (element.type === 'bubbleVideo' && segment.t === 'video') {
    const video = segToSendElement(segment);
    if (video.kind !== 'video') throw new Error('圆形视频转换失败');
    return {
      ...video,
      kind: 'bubbleVideo',
      ...(text(data.templateName) ? { templateName: text(data.templateName) } : {}),
    };
  }
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
  const content = withoutEmptyTextElements(elements);
  const reason = forwardUnsupportedReason(content);
  if (reason) throw new Error(reason);
  const flash = content.find(
    (element) => element.type === 'markdown' && element.data?.flashTransferInfo != null,
  );
  if (flash) {
    const info = flash.data!.flashTransferInfo as { fileSetId: string };
    // Android 转发只提交文件集身份，由专用分享接口生成卡片，不重发收到的 Markdown。
    return { kind: 'flashTransfer', fileSetId: info.fileSetId.trim() };
  }
  const outgoing = content.map((element) => sendElement(element, stickers, group, images));
  if (outgoing.length === 1 && outgoing[0]?.kind === 'file') {
    if (typeof outgoing[0].source !== 'string' || !outgoing[0].source)
      throw new Error('文件缺少本机路径。');
    return { kind: 'file', path: outgoing[0].source, fileName: outgoing[0].fileName ?? '' };
  }
  if (outgoing.some((element) => element.kind === 'file'))
    throw new Error('文件不能与其他元素混合重发。');
  return { kind: 'elements', elements: outgoing };
}
