/**
 * 输入框里的「媒体素材」模型：图片 / 视频 / 文件附件，以及录好的语音片段。
 *
 * 这一层只描述**本地待发送的素材**，不碰任何协议：
 *   - 预览用 `URL.createObjectURL` 的 blob 地址，随时可释放；
 *   - 真正要跟着正文一起送出去的东西，编成 {@link elementToToken} 的元素 token
 *     （`kind: 'pic' | 'video' | 'file' | 'ptt'`），跟草稿里其它元素同一条通路 ——
 *     `serializeComposer` / `composerTextToElements` 都认识它。
 *
 * 之所以不把 `File` / `Blob` 塞进元素对象：元素 token 要 JSON 化，二进制进不去，
 * 所以元素里只留可序列化的元信息（文件名 / 大小 / 尺寸 / 时长）。
 */

import { elementToToken } from './draftElements';

export type ComposerAttachmentKind = 'image' | 'video' | 'file';

export type ComposerAttachment = {
  id: string;
  kind: ComposerAttachmentKind;
  name: string;
  /** 字节数。 */
  size: number;
  mime: string;
  /** 本地预览地址（object URL）；文件类没有。 */
  url: string | null;
  width?: number;
  height?: number;
  /** 秒；视频才有。 */
  duration?: number;
  /** 原始文件，留在内存里等接线的发送逻辑取用。 */
  file: File;
};

export type VoiceClip = {
  id: string;
  /** 录音来源：麦克风录制 / 文字合成。 */
  source: 'record' | 'tts';
  /** 可播放地址；`source: 'tts'` 且只有本机合成时可能为 null。 */
  url: string | null;
  blob: Blob | null;
  durationMs: number;
  /** 录音过程中采样的波形峰值（0..1），用于回顾时画静态声纹。 */
  levels: number[];
  /** 语音转录出的文字（没转录就是空串）。 */
  transcript: string;
  /** TTS 合成的原文；录音来源为空。 */
  text?: string;
};

/** 一次最多挂多少个附件（跟 QQ 的量级对齐，也防手滑拖进来一整个目录）。 */
export const MAX_COMPOSER_ATTACHMENTS = 20;

/** 单个附件大小上限（QQ 普通文件上限 100MB，这里只做前端提示）。 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const IMAGE_MIME = /^image\//;
const VIDEO_MIME = /^video\//;

export function createMediaId(prefix = 'media'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function classifyFile(file: File): ComposerAttachmentKind {
  if (IMAGE_MIME.test(file.type)) return 'image';
  if (VIDEO_MIME.test(file.type)) return 'video';
  return 'file';
}

/** 统一入口：有 MIME 就按 MIME，没有就按扩展名。 */
export function attachmentKindOf(file: File): ComposerAttachmentKind {
  return file.type ? classifyFile(file) : classifyByName(file.name);
}

/**
 * 这张图片要不要**内联进输入框**。图片走内联（跟表情一样），视频 / 文件走
 * 「单独发」的卡片 —— 两者在输入框里的存在形式不同，所以这里分得清楚点。
 */
export function isImageFile(file: File): boolean {
  return attachmentKindOf(file) === 'image';
}

/** 扩展名兜底：有些系统给出来的 `File.type` 是空的。 */
export function classifyByName(name: string): ComposerAttachmentKind {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'apng', 'svg'].includes(ext)) {
    return 'image';
  }
  if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'].includes(ext)) return 'video';
  return 'file';
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exp;
  const digits = exp === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[exp]}`;
}

/** 毫秒 → `0:07` / `1:02`（语音条上的时长展示）。 */
export function formatClipDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function readImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = url;
  });
}

function readVideoMeta(url: string): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    const finish = (meta: { width: number; height: number; duration: number }) => {
      video.removeAttribute('src');
      video.load();
      resolve(meta);
    };
    video.onloadedmetadata = () =>
      finish({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      });
    video.onerror = () => finish({ width: 0, height: 0, duration: 0 });
    video.src = url;
  });
}

/** 把一个本地文件包装成附件（图片 / 视频顺带读出尺寸、时长）。 */
export async function createAttachment(file: File): Promise<ComposerAttachment> {
  const kind = file.type ? classifyFile(file) : classifyByName(file.name);
  const url = kind === 'file' ? null : URL.createObjectURL(file);
  const attachment: ComposerAttachment = {
    id: createMediaId('att'),
    kind,
    name: file.name || '未命名文件',
    size: file.size,
    mime: file.type || 'application/octet-stream',
    url,
    file,
  };

  if (url && kind === 'image') {
    const { width, height } = await readImageSize(url);
    attachment.width = width;
    attachment.height = height;
  } else if (url && kind === 'video') {
    const meta = await readVideoMeta(url);
    attachment.width = meta.width;
    attachment.height = meta.height;
    attachment.duration = meta.duration;
  }

  return attachment;
}

export async function createAttachments(files: Iterable<File>): Promise<ComposerAttachment[]> {
  const list = Array.from(files).slice(0, MAX_COMPOSER_ATTACHMENTS);
  return Promise.all(list.map((file) => createAttachment(file)));
}

/** 释放一个附件的预览地址。 */
export function releaseAttachment(attachment: ComposerAttachment): void {
  if (attachment.url) URL.revokeObjectURL(attachment.url);
}

export function releaseVoiceClip(clip: VoiceClip | null): void {
  if (clip?.url?.startsWith('blob:')) URL.revokeObjectURL(clip.url);
}

/** `DataTransfer` 里有没有文件（拖拽高亮判断，别把普通文本拖拽也点亮）。 */
export function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types ?? []).includes('Files');
}

// ── 元素 token ───────────────────────────────────────────────────────────────
//
// 元素的 `kind` 跟着 wire 层来（pic / video / file / ptt），这样 elementLabel 与
// composerTextToElements 都能原样认出来；其余字段是本地元信息。

export function attachmentToElement(attachment: ComposerAttachment): Record<string, unknown> {
  const base = {
    fileName: attachment.name,
    fileSize: attachment.size,
    mimeType: attachment.mime,
  };
  if (attachment.kind === 'image') {
    return {
      ...base,
      kind: 'pic',
      width: attachment.width ?? 0,
      height: attachment.height ?? 0,
      localPreviewUrl: attachment.url,
    };
  }
  if (attachment.kind === 'video') {
    return {
      ...base,
      kind: 'video',
      width: attachment.width ?? 0,
      height: attachment.height ?? 0,
      duration: Math.round(attachment.duration ?? 0),
      localPreviewUrl: attachment.url,
    };
  }
  return { ...base, kind: 'file' };
}

export function attachmentToken(attachment: ComposerAttachment): string {
  return elementToToken(attachmentToElement(attachment));
}

export function voiceClipToElement(clip: VoiceClip): Record<string, unknown> {
  return {
    kind: 'ptt',
    fileName: `voice-${clip.id}.silk`,
    fileSize: clip.blob?.size ?? 0,
    mimeType: 'audio/silk',
    duration: Math.round(clip.durationMs / 1000),
    // 转录文本跟着元素走（wire 45923 就是干这个的），转录过就一起带上。
    pttTranscript: clip.transcript,
    source: clip.source,
  };
}

export function voiceClipToken(clip: VoiceClip): string {
  return elementToToken(voiceClipToElement(clip));
}

/** 附件在输入框 / 气泡上的展示名。 */
export function attachmentLabel(attachment: ComposerAttachment): string {
  if (attachment.kind === 'image') return '[图片]';
  if (attachment.kind === 'video') return '[视频]';
  return '[文件]';
}

/** 卡片上的类型名。 */
export function attachmentKindText(kind: ComposerAttachmentKind): string {
  if (kind === 'image') return '图片';
  if (kind === 'video') return '视频';
  return '文件';
}

/** 卡片副标题：类型 · 尺寸 / 时长 · 大小（图片只给大小前的几项）。 */
export function attachmentMetaText(attachment: ComposerAttachment): string {
  const parts = [attachmentKindText(attachment.kind)];
  if (attachment.kind === 'video' && attachment.duration) {
    parts.push(formatClipDuration(attachment.duration * 1000));
  }
  if (attachment.kind !== 'file' && attachment.width && attachment.height) {
    parts.push(`${attachment.width} × ${attachment.height}`);
  }
  parts.push(formatFileSize(attachment.size));
  return parts.join(' · ');
}

/**
 * 剪贴板 / 拖拽里的文件。
 *
 * `files` 是主路径（截图、复制的图片、从资源管理器拖进来的都能读到）；某些来源
 * 只把文件挂在 `items` 上（`kind: 'file'`），所以这里兜一层。
 */
export function clipboardFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  const direct = Array.from(dataTransfer.files ?? []).filter((file) => file.size >= 0);
  if (direct.length > 0) return direct;
  const items = dataTransfer.items;
  if (!items) return [];
  const out: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}
