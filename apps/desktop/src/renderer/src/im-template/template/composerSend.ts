/**
 * 输入框正文 → 一条可发送的「发送计划」。
 *
 * 输入框把内容序列化成「正文文本 + token」（见 `composer.tsx` / `draftElements.ts` /
 * `emojiPacks.ts`）。这里把这些 token 还原成 @weq/protocol 的 `SendElement`：
 *
 *   - 纯文本              → `{ kind: 'text' }`
 *   - `[[chat:elem:…]]`   → 原样还原的元素（@ / 引用 / 弹射表情 / 图片 / 语音 / 文件…）
 *   - `[[chat:face:<id>]]`      → `{ kind: 'face', faceId }`
 *   - `[[chat:face:<id>:big]]`  → `{ kind: 'face', superSticker: { packId, stickerId } }`
 *   - `[[chat:mface:…]]`        → `{ kind: 'mface' }`
 *   - 字符表情            → 文本
 *
 * 三类元素有各自的「独立发送」语义（composer 已经做好互斥）：
 *   - 文件：走独立管线（老 OIDB + highway），计划变成 `{ kind: 'file' }`；
 *   - AI 声聊：`0x929b_0` 合成即发送，计划变成 `{ kind: 'aiVoice' }`；
 *   - 其余（含图片 / 视频 / 语音 / 表情）合并成一条 `{ kind: 'elements' }`。
 *
 * **本地二进制不在 token 里**（token 只有元信息），所以调用方要把输入框里那些
 * `File` / `Blob` 通过 {@link LocalMediaRef} 一起交进来；这里按元素上可稳定复算出的
 * key 去取路径（优先）或字节（兜底）。
 */

import { parseMessageParts, type EmojiItem } from './emojiPacks';
import { tokenToElement } from './draftElements';

/**
 * 一个待发送的本地媒体句柄。
 *
 * `key` 必须能从元素 token 里**稳定复算**出来（见 {@link localKeyOf}），这样发送时
 * 不用往 token 里塞 id（避免污染写进 QQ 的草稿）。
 */
export type LocalMediaRef = {
  key: string;
  /** 本机绝对路径（优先；大文件 / 视频走它，不占内存）。 */
  path?: string;
  /** 无路径时的字节（剪贴板截图等）。 */
  bytes?: Uint8Array;
  name: string;
  /**
   * 本地预览地址（图片 / 视频的 blob: object URL，语音的录音 blob URL）——
   * **只给乐观渲染用**，发送时丢弃。真实消息同步回来后气泡改走服务端资源。
   */
  previewUrl?: string;
  /** 语音波形峰值（0..255），只用于乐观渲染；真实消息同步回来后用服务端那份。 */
  waveform?: number[];
};

/** 超级表情目录项（来自 `emojiPanel.overview` 的 `sticker/packId/stickerId`）。 */
export type SuperStickerEntry = {
  packId: string;
  stickerId: string;
  stickerType?: number;
};

export type ComposerSendPlan =
  | { kind: 'elements'; elements: unknown[] }
  | { kind: 'file'; path: string; fileName: string }
  | { kind: 'aiVoice'; text: string; voiceId: string }
  | { kind: 'voice'; recording: Uint8Array; durationSec: number; fileName: string };

/** 语音重采样目标：与 `encodeFileToSilk` / 收端一致（24 kHz 单声道）。 */
const VOICE_SAMPLE_RATE = 24000;

/** 元素里有没有「本地图片 / 视频 / 语音 / 文件」——没有就不必去取路径 / 字节。 */
export function planNeedsLocalMedia(body: string): boolean {
  for (const part of parseMessageParts(body)) {
    if (part.type !== 'element') continue;
    const kind = (tokenToElement(part.raw) as { kind?: string } | null)?.kind;
    if (kind === 'pic' || kind === 'video' || kind === 'ptt' || kind === 'file') return true;
  }
  return false;
}

/**
 * 从元素 token 复算它的本地媒体 key。与 `composerMedia` 生成 token 时的字段一致：
 *   - 图片 / 视频：`localPreviewUrl`（blob 地址，唯一）；
 *   - 语音：`fileName`（`voice-<clip.id>.silk`）；
 *   - 文件：`fileName:fileSize`（文件没有 blob 地址）。
 */
export function localKeyOf(element: Record<string, unknown>): string | null {
  const kind = element.kind;
  if (kind === 'pic' || kind === 'video') {
    const url = typeof element.localPreviewUrl === 'string' ? element.localPreviewUrl : '';
    return url || null;
  }
  if (kind === 'ptt') {
    const name = typeof element.fileName === 'string' ? element.fileName : '';
    return name || null;
  }
  if (kind === 'file') {
    return `${String(element.fileName ?? '')}:${String(element.fileSize ?? '')}`;
  }
  return null;
}

/** `你弹射了3个[大笑]` → 3（取不到按 1）。 */
function parseBounceCount(summary: unknown): number {
  const text = typeof summary === 'string' ? summary : '';
  const match = /(\d+)/.exec(text);
  const value = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function mapEmoji(item: EmojiItem, superStickers: Map<string, SuperStickerEntry>): unknown {
  switch (item.kind) {
    case 'system': {
      const faceId = Number(item.id);
      if (!Number.isSafeInteger(faceId) || faceId < 0) {
        throw new Error(`系统表情 id 不合法：${item.id}`);
      }
      if (!item.large) return { kind: 'face', faceId };
      // 超级 / 动态表情必须走 svc 37（QFaceExtra），且需要目录里的 packId/stickerId ——
      // 走默认老 FaceElem 服务端会把 faceId 静默换成另一张脸。
      const entry = superStickers.get(item.id);
      if (!entry) {
        throw new Error(
          `找不到表情 ${item.id} 的贴纸目录信息，无法按超级表情发送（目录里这枚表情没有 packId/stickerId）。`,
        );
      }
      return {
        kind: 'face',
        faceId,
        superSticker: {
          packId: entry.packId,
          stickerId: entry.stickerId,
          ...(entry.stickerType !== undefined ? { stickerType: entry.stickerType } : {}),
        },
      };
    }
    case 'market': {
      // token id = `${packId}:${hash}`。
      const separator = item.id.indexOf(':');
      const packId = item.id.slice(0, separator);
      const hash = item.id.slice(separator + 1);
      if (!packId || !hash) throw new Error(`商城表情 token 不完整：${item.id}`);
      return { kind: 'mface', marketEmoticonId: hash, emojiPackId: Number(packId) };
    }
    case 'unicode':
      return { kind: 'text', textContent: item.glyph || item.name };
    case 'fav':
    case 'related':
      throw new Error('收藏表情 / 关联 GIF 的发送还没接线（拿不到本地文件字节）。');
    default:
      throw new Error(`不认识的输入框表情：${String((item as { kind?: unknown }).kind)}`);
  }
}

function mapWireElement(
  element: Record<string, unknown>,
  localByKey: Map<string, LocalMediaRef>,
): ComposerSendPlan | unknown {
  switch (element.kind) {
    case 'text':
    case 'at':
    case 'face':
    case 'mface':
    case 'reply':
    case 'ark':
    case 'xml':
    case 'markdown':
    case 'forward':
      // 这些元素收 / 发同形（协议层 `SendElement` 与 codec 元素字段一致），原样装箱。
      return element;
    case 'emojiBounce':
      return {
        kind: 'emojiBounce',
        faceId: Number(element.emojiBounceId) || 0,
        count: parseBounceCount(element.emojiBounceTextSummary),
        ...(typeof element.emojiBounceName === 'string' && element.emojiBounceName
          ? { name: element.emojiBounceName }
          : {}),
      };
    case 'pic':
    case 'video': {
      const source = mediaSourceOf(element, localByKey);
      if (element.kind === 'pic') {
        return {
          kind: 'image',
          source,
          ...(typeof element.fileName === 'string' ? { fileName: element.fileName } : {}),
          ...(element.width !== undefined ? { width: Number(element.width) } : {}),
          ...(element.height !== undefined ? { height: Number(element.height) } : {}),
        };
      }
      return {
        kind: 'video',
        source,
        ...(typeof element.fileName === 'string' ? { fileName: element.fileName } : {}),
        ...(element.width !== undefined ? { width: Number(element.width) } : {}),
        ...(element.height !== undefined ? { height: Number(element.height) } : {}),
        ...(element.duration !== undefined ? { duration: Number(element.duration) } : {}),
      };
    }
    case 'ptt': {
      // AI 声聊：合成即发送，独立成一条（不带正文 / 引用）。
      if (element.isAiVoice || element.source === 'ai-voice') {
        const text = typeof element.pttTranscript === 'string' ? element.pttTranscript : '';
        const voiceId = typeof element.pttVoiceId === 'string' ? element.pttVoiceId : '';
        if (!text.trim()) throw new Error('AI 声聊的合成文字丢了，无法发送。');
        if (!voiceId.trim()) throw new Error('AI 声聊的声线 id 丢了，无法发送。');
        return { kind: 'aiVoice', text, voiceId };
      }
      // 录制的语音条（麦克风 / 本机 TTS）：本地 blob 是 webm/opus，浏览器能解但它
      // 不是 SILK。这里把原始字节交给上层，由 {@link decodeRecordingToWav} 解成 WAV，
      // 再由主进程 `encodeFileToSilk` 转 SILK 后发送（`account.sendVoice`）。
      const key = localKeyOf(element);
      const local = key ? localByKey.get(key) : undefined;
      if (!local?.bytes) {
        throw new Error(
          `找不到语音「${String(element.fileName ?? '')}」的本地数据（录音 blob 没带上来），无法发送。`,
        );
      }
      return {
        kind: 'voice',
        recording: local.bytes,
        durationSec: element.duration !== undefined ? Number(element.duration) : 0,
        fileName:
          typeof element.fileName === 'string' && element.fileName ? element.fileName : local.name,
      };
    }
    case 'file': {
      const key = localKeyOf(element);
      const local = key ? localByKey.get(key) : undefined;
      if (!local?.path) {
        throw new Error(
          `发送文件「${String(element.fileName ?? '')}」需要本机绝对路径，但拿不到（剪贴板 / 网盘来源暂不支持）。`,
        );
      }
      const fileName =
        typeof element.fileName === 'string' && element.fileName ? element.fileName : local.name;
      return { kind: 'file', path: local.path, fileName };
    }
    default:
      throw new Error(`不支持的发送元素：${String(element.kind)}`);
  }
}

function mediaSourceOf(
  element: Record<string, unknown>,
  localByKey: Map<string, LocalMediaRef>,
): string | Uint8Array {
  const key = localKeyOf(element);
  const local = key ? localByKey.get(key) : undefined;
  if (local?.path) return local.path;
  if (local?.bytes) return local.bytes;
  throw new Error(
    `找不到本地媒体「${String(element.fileName ?? key ?? '')}」的路径或字节，无法上传发送。`,
  );
}

function isPlan(value: unknown): value is ComposerSendPlan {
  const kind = (value as { kind?: string } | null)?.kind;
  return kind === 'file' || kind === 'aiVoice' || kind === 'voice';
}

/**
 * 正文 + 本地媒体句柄 → 发送计划。
 *
 * 同一时刻只会有一种「独立发送」（composer 已保证文件 / AI 声聊 / 视频 / 超级表情互斥）。
 */
export function buildComposerSendPlan(input: {
  body: string;
  locals: LocalMediaRef[];
  /** faceId → 超级表情目录项；没有超级表情时传空 Map。 */
  superStickers: Map<string, SuperStickerEntry>;
}): ComposerSendPlan {
  const localByKey = new Map(input.locals.map((local) => [local.key, local]));
  const elements: unknown[] = [];

  for (const part of parseMessageParts(input.body)) {
    if (part.type === 'text') {
      if (part.value.length > 0) elements.push({ kind: 'text', textContent: part.value });
      continue;
    }
    if (part.type === 'emoji') {
      elements.push(mapEmoji(part.item, input.superStickers));
      continue;
    }
    const element = tokenToElement(part.raw) as Record<string, unknown> | null;
    if (!element) {
      // 解不出来的元素 token 当字面文本保留（与 composerTextToElements 一致）。
      elements.push({ kind: 'text', textContent: part.raw });
      continue;
    }
    const mapped = mapWireElement(element, localByKey);
    if (isPlan(mapped)) return mapped;
    elements.push(mapped);
  }

  if (elements.length === 0) throw new Error('消息内容为空。');
  return { kind: 'elements', elements };
}

/**
 * 录音字节（webm/opus 等浏览器可解码格式）→ 24 kHz 单声道 16-bit PCM WAV。
 *
 * 主进程的 `encodeFileToSilk` 只认 WAV / SILK，而 `MediaRecorder` 录出来是 webm/opus，
 * 仓库里又没有 ffmpeg，所以这一步必须在渲染层用 WebAudio 完成：
 *   1. `decodeAudioData` 把压缩音频解成 PCM；
 *   2. `OfflineAudioContext` 重采样到 24 kHz 单声道；
 *   3. 手写 WAV 头（silk-wasm 只吃标准 RIFF/WAVE）。
 *
 * 拿不到 WebAudio（非 Electron 环境 / 极老的运行时）时如实报错，不静默发一条空语音。
 */
export async function decodeRecordingToWav(
  recording: Uint8Array,
  sampleRate: number = VOICE_SAMPLE_RATE,
): Promise<Uint8Array> {
  if (recording.byteLength === 0) throw new Error('录音是空的，无法发送。');
  // 复制到独立的 ArrayBuffer：`recording` 可能是某个大 buffer 的视图，直接把视图的
  // buffer 交给 decodeAudioData 会把无关字节也算进去。
  const bytes = recording.slice();
  const audioBuffer = await decodeAudio(bytes.buffer as ArrayBuffer);
  const frames = Math.max(1, Math.ceil(audioBuffer.duration * sampleRate));
  const offline = createOfflineContext(1, frames, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return encodePcmWav(rendered.getChannelData(0), sampleRate);
}

/** 用 WebAudio 把一个 ArrayBuffer 解成 AudioBuffer。 */
async function decodeAudio(buffer: ArrayBuffer): Promise<AudioBuffer> {
  const Context = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Context) throw new Error('当前环境不支持音频解码（没有 AudioContext），无法发送录音。');
  const context = new Context();
  try {
    return await context.decodeAudioData(buffer);
  } finally {
    void context.close?.();
  }
}

function createOfflineContext(
  channels: number,
  length: number,
  sampleRate: number,
): OfflineAudioContext {
  const w = window as unknown as {
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const Context = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!Context) throw new Error('当前环境不支持音频重采样，无法发送录音。');
  return new Context(channels, length, sampleRate);
}

/** Float32 PCM（-1..1）→ 16-bit 单声道 WAV 字节。 */
function encodePcmWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }
  return new Uint8Array(buffer);
}

// ───────────────────────── 乐观渲染 ─────────────────────────
//
// 发出去的消息要立刻在会话里显示（等 QQ 同步回来太慢），所以发送时把同一条内容
// 编成**渲染元素**（与真实消息的 `qqElements` 同形 `{type,data}`）。这些元素与
// `buildComposerSendPlan` 的发送元素一一对应，只是面向渲染而非协议；本地媒体按
// 输入框的句柄补上 `localPath` / `localPreviewUrl`，让气泡直接显示本地预览。

/** 一条乐观消息的渲染内容：元素数组 + 纯文本预览。 */
export type OptimisticRender = { elements: unknown[]; body: string };

function previewOf(element: Record<string, unknown>, localByKey: Map<string, LocalMediaRef>) {
  const key = localKeyOf(element);
  return key ? localByKey.get(key) : undefined;
}

/** 把一条输入框正文编成乐观渲染元素（永不抛错：编不出的 token 回退成文本）。 */
export function buildOptimisticRender(input: {
  body: string;
  locals: LocalMediaRef[];
  superStickers: Map<string, SuperStickerEntry>;
}): OptimisticRender {
  const localByKey = new Map(input.locals.map((local) => [local.key, local]));
  const elements: unknown[] = [];
  const bodyParts: string[] = [];
  const pushText = (text: string): void => {
    if (!text) return;
    elements.push({ type: 'text', data: { textContent: text } });
    bodyParts.push(text);
  };

  for (const part of parseMessageParts(input.body)) {
    if (part.type === 'text') {
      pushText(part.value);
      continue;
    }
    if (part.type === 'emoji') {
      const item = part.item;
      switch (item.kind) {
        case 'system': {
          const faceId = Number(item.id);
          elements.push({
            type: 'face',
            data: {
              faceId,
              faceText: item.name,
              // 小黄脸内联（subType 1/2）；超级表情不带 subType，按大贴纸渲染。
              ...(item.large ? {} : { subType: 1 }),
            },
          });
          bodyParts.push(item.name || `[表情${item.id}]`);
          break;
        }
        case 'market': {
          const separator = item.id.indexOf(':');
          elements.push({
            type: 'mface',
            data: {
              emojiPackId: Number(item.id.slice(0, separator)),
              marketEmoticonIdHex: item.id.slice(separator + 1),
              previewWidth: 120,
              previewHeight: 120,
            },
          });
          bodyParts.push(item.name || '[表情]');
          break;
        }
        case 'unicode':
          pushText(item.glyph || item.name);
          break;
        default:
          // 收藏 / 关联 GIF 的乐观预览做不了（拿不到本地文件），退化成文本。
          pushText(item.name || '[表情]');
          break;
      }
      continue;
    }

    const element = tokenToElement(part.raw) as Record<string, unknown> | null;
    if (!element) {
      pushText(part.raw);
      continue;
    }
    const rendered = renderElementOf(element, localByKey);
    if (rendered) {
      // `text` 只是给会话列表用的预览字段，不能混进渲染元素（气泡渲染器只认 type/data）。
      const { text, ...renderElement } = rendered;
      elements.push(renderElement);
      bodyParts.push(String(text ?? ''));
    } else {
      pushText(part.raw);
    }
  }

  return { elements, body: bodyParts.join('') };
}

/** 单个元素 → 渲染元素（+ 文本预览）；认不出返回 null。 */
function renderElementOf(
  element: Record<string, unknown>,
  localByKey: Map<string, LocalMediaRef>,
): (Record<string, unknown> & { text?: string }) | null {
  switch (element.kind) {
    case 'text':
      return {
        type: 'text',
        data: { textContent: element.textContent },
        text: String(element.textContent ?? ''),
      };
    case 'at':
      return {
        type: 'at',
        data: {
          textContent: element.textContent,
          atTargetUid: element.atTargetUid,
          ...(element.atTargetUin !== undefined ? { atTargetUin: element.atTargetUin } : {}),
        },
        text: String(element.textContent ?? ''),
      };
    case 'face':
      return {
        type: 'face',
        data: {
          faceId: element.faceId,
          faceText: element.faceText,
          ...(element.superSticker ? {} : { subType: 1 }),
        },
        text: String(element.faceText ?? '[表情]'),
      };
    case 'mface':
      return {
        type: 'mface',
        data: {
          emojiPackId: element.emojiPackId,
          marketEmoticonIdHex: element.marketEmoticonId,
          previewWidth: 120,
          previewHeight: 120,
        },
        text: '[表情]',
      };
    case 'reply':
      return {
        type: 'reply',
        data: {
          origMsgSeq: element.origMsgSeq,
          origSenderUin: element.origSenderUin,
          origMsgTime: element.origMsgTime,
        },
        text: '[引用]',
      };
    case 'emojiBounce':
      return {
        type: 'emojiBounce',
        data: {
          emojiBounceId: Number(element.emojiBounceId) || 0,
          emojiBounceName: element.emojiBounceName,
          emojiBounceTextSummary: element.emojiBounceTextSummary,
        },
        text: String(element.emojiBounceTextSummary ?? '[表情弹射]'),
      };
    case 'pic': {
      const local = previewOf(element, localByKey);
      return {
        type: 'pic',
        data: {
          fileName: element.fileName,
          fileSize: element.fileSize,
          imgWidth: element.width,
          imgHeight: element.height,
          ...(local?.path ? { localPath: local.path } : {}),
          ...(local?.previewUrl ? { localPreviewUrl: local.previewUrl } : {}),
        },
        text: '[图片]',
      };
    }
    case 'video': {
      const local = previewOf(element, localByKey);
      return {
        type: 'video',
        data: {
          fileName: element.fileName,
          fileSize: element.fileSize,
          videoWidth: element.width,
          videoHeight: element.height,
          videoDuration: element.duration,
          ...(local?.path ? { localPath: local.path } : {}),
          ...(local?.previewUrl ? { localPreviewUrl: local.previewUrl } : {}),
        },
        text: '[视频]',
      };
    }
    case 'ptt': {
      const local = previewOf(element, localByKey);
      return {
        type: 'ptt',
        data: {
          fileName: element.fileName,
          fileSize: element.fileSize,
          pttDuration: element.duration,
          ...(element.isAiVoice ? { isAiVoice: true } : {}),
          ...(element.pttTranscript ? { pttTranscript: element.pttTranscript } : {}),
          ...(local?.waveform ? { waveform: local.waveform } : {}),
          ...(local?.path ? { localPath: local.path } : {}),
          ...(local?.previewUrl ? { localPreviewUrl: local.previewUrl } : {}),
        },
        text: '[语音]',
      };
    }
    case 'file': {
      const local = previewOf(element, localByKey);
      return {
        type: 'file',
        data: {
          fileName: element.fileName,
          fileSize: element.fileSize,
          ...(local?.path ? { localPath: local.path } : {}),
        },
        text: `[文件]${String(element.fileName ?? '')}`,
      };
    }
    default:
      return null;
  }
}
