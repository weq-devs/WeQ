/**
 * 合并转发（合成聊天记录）前端数据模型 —— **分段（segment）模型**。
 *
 * 这是「核心组件 + 两个使用场景」共用的那一份模型：
 *   1. 聊天里多选消息 → 合并转发；
 *   2. 左栏「更多 → 合成聊天记录」→ 从空白卡片拼一份聊天记录。
 *
 * 为什么是「分段」而不是直接存元素？因为一条合并转发的消息要同时活在三处：
 *   - **编辑 / 预览**：需要分段（文本一段、表情一段、图片一张…）才能逐段编辑；
 *   - **发送**：协议要的是 `SendElement[]`（见 @weq/service 的 `SendElement`），
 *     媒体是 `source`（本机路径），发之前会真实上传 NTV2；
 *   - **渲染**：前端渲染层要的是渲染视图元素（`{type,data}`，见 QqMessageContent）。
 *
 * 所以这里把「分段」当唯一真源，另外提供两组纯函数做转换：
 *   {@link segsToRenderElements}  分段 → 渲染视图（预览用）
 *   {@link segsToSendElements}    分段 → 协议发送元素（发送用，媒体带本机路径）
 * 以及反向（导入已有消息时）：
 *   {@link codecElementsToSegs}   本库原始 wire 元素 → 分段（可再次上传发送）
 *
 * 传输结构：一份草稿 = 一串「预览消息（{@link MfNode}）」。合并转发的惯例是
 * **所有消息都在左侧显示**，发送者只作为「头像 + 昵称」展示，与真实会话无关。
 * 一个节点（{@link MfNode}）的内容是分段数组；**当分段全是 `node` 时，这个节点
 * 本身是一段嵌套的合并转发**（对齐协议里的 `ForwardNode.innerForward`，也即
 * SnowLuma 的 `node` 段套 `node` 段）。
 */

import type { SendElement, SendForwardNodeInput } from '@weq/service';

/** 渲染视图元素（`{type, data}`）—— 与 ForwardWindow / QqMessageContent 同形。 */
export type MfElement = { type?: string; data?: Record<string, unknown> };

/** 一条预览消息的发送者。合并转发里 uin 是头像来源；uid 可能为空（手工输入）。 */
export interface MfSender {
  uid: string;
  uin: string;
  name: string;
}

// ───────────────────────────── 分段（segment） ─────────────────────────────

/** 纯文本。 */
export interface MfTextSeg {
  t: 'text';
  id: string;
  text: string;
}

/** @ 某人 / @全体成员。`uid`（可能为 'all'）比 uin 可靠，优先带上。 */
export interface MfAtSeg {
  t: 'at';
  id: string;
  uid: string;
  uin: string;
  name: string;
  all?: boolean;
}

/**
 * 引用（回复）—— 指向同一条聊天记录里另一条消息。
 *
 * 合并转发里的引用只带**指针**（会话内序号 + 发送人 + 时间），所以它不需要
 * 「被引消息的元素」；`senderName` / `summary` 纯粹是编辑态和预览态给人看的。
 */
export interface MfReplySeg {
  t: 'reply';
  id: string;
  /** 被引用消息的会话内序号（群=群 seq，私聊=index）。0 = 还没填。 */
  origMsgSeq: number;
  origSenderUin?: number;
  origMsgTime?: number;
  /** 引用条上显示的发送人。 */
  senderName?: string;
  /** 引用条上显示的摘要文本。 */
  summary?: string;
}

/** 系统表情（小黄脸）。 */
export interface MfFaceSeg {
  t: 'face';
  id: string;
  faceId: number;
  faceText: string;
}

/** 商城表情（贴纸）。`marketEmoticonId` 是 32 位 hex。 */
export interface MfMfaceSeg {
  t: 'mface';
  id: string;
  marketEmoticonId: string;
  emojiPackId: number;
  faceName?: string;
  encryptKey?: string;
  previewWidth?: number;
  previewHeight?: number;
}

/** 图片：`path` 是本机绝对路径，发送时真实上传 NTV2。 */
export interface MfImageSeg {
  t: 'image';
  id: string;
  path: string;
  fileName?: string;
  size?: number;
  width?: number;
  height?: number;
  /** 0 普通图 / 1 动画表情；缺省 0。 */
  subType?: number;
}

/** 语音：`path` 是本机 SILK / 音频文件路径。 */
export interface MfRecordSeg {
  t: 'record';
  id: string;
  path: string;
  fileName?: string;
  size?: number;
  /** 时长（秒）。 */
  duration?: number;
}

/** 视频：`path` 是本机视频路径；`thumbPath` 可选封面。 */
export interface MfVideoSeg {
  t: 'video';
  id: string;
  path: string;
  fileName?: string;
  size?: number;
  thumbPath?: string;
  duration?: number;
  width?: number;
  height?: number;
}

/** 文件：`path` 是本机绝对路径，发送时走文件管线真实上传（群/私聊各有编码）。 */
export interface MfFileSeg {
  t: 'file';
  id: string;
  path: string;
  fileName?: string;
  size?: number;
}

/** JSON / Ark 卡片（一段 JSON 文本）。 */
export interface MfArkSeg {
  t: 'ark';
  id: string;
  arkData: string;
}

/** XML 卡片。 */
export interface MfXmlSeg {
  t: 'xml';
  id: string;
  xmlContent: string;
  subType?: number;
}

/** Markdown 卡片。 */
export interface MfMarkdownSeg {
  t: 'markdown';
  id: string;
  content: string;
  summary?: string;
}

/** 表情弹射。 */
export interface MfEmojiBounceSeg {
  t: 'emojiBounce';
  id: string;
  faceId: number;
  count?: number;
  name?: string;
}

/** 引用一个**已存在**的长消息（resId）—— 即「转发一张聊天记录卡片」。 */
export interface MfCardSeg {
  t: 'card';
  id: string;
  resId: string;
}

/**
 * 嵌套转发节点：内容是一串分段。**当 {@link MfNodeSeg.segs} 全是 `node` 段时，
 * 这个节点就是一段嵌套的合并转发**（对齐协议的 `ForwardNode.innerForward`）。
 */
export interface MfNodeSeg {
  t: 'node';
  id: string;
  userUin: string;
  nickname: string;
  time: number;
  segs: MfSeg[];
}

export type MfSeg =
  | MfTextSeg
  | MfAtSeg
  | MfReplySeg
  | MfFaceSeg
  | MfMfaceSeg
  | MfImageSeg
  | MfRecordSeg
  | MfVideoSeg
  | MfFileSeg
  | MfArkSeg
  | MfXmlSeg
  | MfMarkdownSeg
  | MfEmojiBounceSeg
  | MfCardSeg
  | MfNodeSeg;

/** 分段类型（用于「添加段」菜单 / 校验）。 */
export type MfSegKind = MfSeg['t'];

/** 一条预览消息。 */
export interface MfNode {
  /** 本地稳定 id（排序 / React key）。 */
  id: string;
  sender: MfSender;
  /** 内容分段，原样保留。 */
  segs: MfSeg[];
  /** 展示时间（unix 秒）。 */
  time: number;
  /** 逐条消息装扮（列 40801）。0 = 未设置。 */
  decoration?: { bubbleId: number; fontId: number; widgetId: number };
  /** 来源消息 msgId（从真实消息带入时存在）。 */
  sourceMsgId?: string;
}

/** 一份「合成聊天记录」草稿。 */
export interface MfDraft {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodes: MfNode[];
}

/** 转发目标（一个会话）。 */
export interface MfTarget {
  /** 会话稳定 id（模板层 Conversation.id）。 */
  id: string;
  kind: 'c2c' | 'group';
  /** c2c → 对方 uid；group → 群号。 */
  conv: string;
  name: string;
  avatarUrl: string | null;
}

let idSeq = 0;

/** 本地唯一 id。`crypto.randomUUID` 可用就用它，否则退化为递增序号。 */
export function mfId(prefix = 'mf'): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}-${crypto.randomUUID()}`;
    }
  } catch {
    /* fall through */
  }
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq}`;
}

/** unix 秒（缺省现在）。 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 一份空草稿。 */
export function createEmptyDraft(): MfDraft {
  const now = nowSeconds();
  return { id: mfId('draft'), title: '', createdAt: now, updatedAt: now, nodes: [] };
}

/** 由发送者信息造一条空消息。 */
export function createNode(sender: MfSender, segs: MfSeg[] = [], time = nowSeconds()): MfNode {
  return { id: mfId('node'), sender, segs, time };
}

/** 新建一个空白分段（带稳定 id）。 */
export function blankSeg(t: MfSegKind): MfSeg {
  const id = mfId('seg');
  switch (t) {
    case 'text':
      return { t, id, text: '' };
    case 'at':
      return { t, id, uid: '', uin: '', name: '' };
    case 'reply':
      return { t, id, origMsgSeq: 0 };
    case 'face':
      return { t, id, faceId: 0, faceText: '' };
    case 'mface':
      return { t, id, marketEmoticonId: '', emojiPackId: 0 };
    case 'image':
      return { t, id, path: '' };
    case 'record':
      return { t, id, path: '' };
    case 'video':
      return { t, id, path: '' };
    case 'file':
      return { t, id, path: '' };
    case 'ark':
      return { t, id, arkData: '' };
    case 'xml':
      return { t, id, xmlContent: '' };
    case 'markdown':
      return { t, id, content: '' };
    case 'emojiBounce':
      return { t, id, faceId: 182, count: 10, name: '' };
    case 'card':
      return { t, id, resId: '' };
    case 'node':
      return { t, id, userUin: '', nickname: '', time: nowSeconds(), segs: [] };
  }
}

/**
 * 一段空白「聊天记录」（嵌套转发）。发送者默认沿用所在消息的发送人，用户可在
 * 卡片里改 —— 这样「插入聊天记录」只要点一下就能得到一个可编辑的空壳。
 */
export function blankNestedRecordSeg(sender?: { uin?: string; name?: string }): MfNodeSeg {
  return {
    t: 'node',
    id: mfId('seg'),
    userUin: sender?.uin ?? '',
    nickname: sender?.name ?? '',
    time: nowSeconds(),
    segs: [],
  };
}

/** 头像：永远按 uin 拼（不依赖数据库里可能过期 / 裂图的外链）。 */
export function senderAvatarUrl(uin: string | undefined | null): string | null {
  return uin && uin !== '0' ? `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}` : null;
}

// ───────────────────────────── 展示 / 摘要 ─────────────────────────────

/** 单个分段的纯文本摘要（chip / 列表预览用）。 */
export function segLabel(seg: MfSeg): string {
  switch (seg.t) {
    case 'text':
      return seg.text;
    case 'at':
      return seg.all ? '@全体成员' : `@${seg.name || seg.uin || seg.uid}`;
    case 'reply':
      return `[引用${seg.summary ? `: ${seg.summary}` : ''}]`;
    case 'face':
      return seg.faceText ? `[${seg.faceText}]` : '[表情]';
    case 'mface':
      return '[商城表情]';
    case 'image':
      return '[图片]';
    case 'record':
      return seg.duration ? `[语音 ${Math.round(seg.duration)}"]` : '[语音]';
    case 'video':
      return '[视频]';
    case 'file':
      return `[文件${seg.fileName ? `: ${seg.fileName}` : ''}]`;
    case 'ark':
      return '[JSON卡片]';
    case 'xml':
      return '[XML卡片]';
    case 'markdown':
      return '[Markdown]';
    case 'emojiBounce':
      return '[表情弹射]';
    case 'card':
      return '[聊天记录]';
    case 'node':
      return '[聊天记录]';
  }
}

/** 一个分段「有内容」吗（空文本 / 空卡片不算）。 */
export function segHasContent(seg: MfSeg): boolean {
  switch (seg.t) {
    case 'text':
      return seg.text.trim().length > 0;
    case 'at':
      return Boolean(seg.uid || seg.uin);
    case 'reply':
      return seg.origMsgSeq > 0;
    case 'face':
      return seg.faceId > 0 || seg.faceText.length > 0;
    case 'mface':
      return seg.marketEmoticonId.length > 0;
    case 'image':
    case 'record':
    case 'video':
    case 'file':
      return seg.path.trim().length > 0;
    case 'ark':
      return seg.arkData.trim().length > 0;
    case 'xml':
      return seg.xmlContent.trim().length > 0;
    case 'markdown':
      return seg.content.trim().length > 0;
    case 'emojiBounce':
      return seg.faceId > 0;
    case 'card':
      return seg.resId.trim().length > 0;
    case 'node':
      return seg.segs.some(segHasContent);
  }
}

/** 一条预览消息的纯文本摘要（列表 / 卡片预览用）。 */
export function summarizeNode(node: MfNode): string {
  for (const seg of node.segs) {
    if (seg.t === 'text' && seg.text.trim()) return truncate(seg.text.trim(), 40);
    if (seg.t === 'at') return segLabel(seg);
    if (seg.t !== 'text') {
      const label = segLabel(seg);
      if (label) return label;
    }
  }
  return '[消息]';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 由一组预览消息生成卡片标题（QQ 同款：「A和B的聊天记录」）。
 * 取前 4 个不同的昵称，去重；没有昵称时退化为「聊天记录」。
 */
export function draftTitle(nodes: MfNode[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const name = node.sender?.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= 4) break;
  }
  if (names.length === 0) return '聊天记录';
  return `${names.join('和')}的聊天记录`;
}

/** 一条消息内容里是否「只有嵌套节点」（= 它本身就是一段嵌套转发）。 */
export function isNestedContent(segs: MfSeg[]): boolean {
  return segs.length > 0 && segs.every((seg) => seg.t === 'node');
}

// ──────────────────── 外层卡片预览（乐观渲染用） ────────────────────

/** 外层「聊天记录」卡片的预览（标题 / 摘要 / 前 4 行）。 */
export interface MfCardPreview {
  /** `A和B的聊天记录`。 */
  source: string;
  /** `查看N条转发消息`。 */
  summary: string;
  /** 前 4 行 `昵称: 内容摘要`。 */
  news: string[];
  /** 总条数。 */
  tSum: number;
}

/**
 * 一条消息的**卡片预览行文本** —— 与协议层 `previewFromElements` 同口径。
 *
 * 只处理收端卡片摘要认识的那几类（文本 / 图片 / 语音 / 视频 / 文件 / 聊天记录 /
 * Markdown / 卡片 / 表情），其余返回 ''（这一行退回只显示昵称）。刻意与
 * `@weq/protocol` 的实现对齐，乐观卡片和同步回来的真卡片才不会看出差异。
 */
function previewTextOfSegs(segs: MfSeg[]): string {
  for (const seg of segs) {
    switch (seg.t) {
      case 'text':
        if (seg.text.trim()) return seg.text.slice(0, 30);
        break;
      case 'image':
        return '[图片]';
      case 'record':
        return '[语音]';
      case 'video':
        return '[视频]';
      case 'file':
        return '[文件]';
      case 'card':
      case 'node':
        return '[聊天记录]';
      case 'markdown':
        return '[Markdown]';
      case 'ark':
      case 'xml':
        return '[卡片]';
      case 'emojiBounce':
        return '[表情弹射]';
      case 'face':
      case 'mface':
        return '[表情]';
      default:
        break;
    }
  }
  return '';
}

/**
 * 草稿 → 外层卡片预览（乐观渲染用）。
 *
 * 发送成功后服务端会自己生成同口径的 `forwardSource` / `forwardNews`（见
 * `@weq/protocol` 的 buildForwardCardMeta），所以这里算出来的预览行和真卡片一致，
 * 同步到位时不会出现视觉跳变。
 */
export function draftCardPreview(draft: MfDraft): MfCardPreview {
  const nodes = draft.nodes.filter((node) => node.segs.some(segHasContent));
  return {
    source: draftTitle(nodes),
    summary: `查看${nodes.length}条转发消息`,
    tSum: nodes.length,
    news: nodes.slice(0, 4).map((node) => {
      const name = node.sender?.name?.trim() || node.sender?.uin?.trim() || 'QQ用户';
      const preview = previewTextOfSegs(node.segs);
      return preview ? `${name}: ${preview}` : name;
    }),
  };
}

// ───────────────────────── 分段 → 渲染视图（预览） ─────────────────────────

const MEDIA_LABEL: Record<string, string> = {
  pic: '[图片]',
  video: '[视频]',
  ptt: '[语音]',
  file: '[文件]',
  mface: '[商城表情]',
  ark: '[卡片]',
  multiMsg: '[聊天记录]',
  markdown: '[Markdown]',
  call: '[通话]',
  wallet: '[红包/转账]',
  qqDynamic: '[动态]',
  onlineFile: '[在线文件]',
  onlineFolder: '[在线文件夹]',
  grayTipRevoke: '[撤回]',
  grayTipPoke: '[戳一戳]',
  grayTipGroup: '[群提示]',
  grayTipXml: '[提示]',
  grayTipFileRecv: '[文件传输完成]',
  grayTipTempSession: '[临时会话]',
  shareLocation: '[位置共享]',
  emojiBounce: '[表情弹射]',
  unknown: '[消息]',
};

/** 图片渲染元素：带上 `localPath`，预览层据此直接从本机文件取图（见 QqImage）。 */
function imageRenderElement(seg: MfImageSeg): MfElement {
  return {
    type: 'pic',
    data: {
      fileName: seg.fileName ?? basename(seg.path),
      fileSize: seg.size ?? 0,
      imgWidth: seg.width ?? 0,
      imgHeight: seg.height ?? 0,
      // imgType / isOriginal 只为渲染层不取值错误，给合理默认。
      imgType: 1001,
      isOriginal: true,
      subType: seg.subType ?? 0,
      localPath: seg.path,
    },
  };
}

/**
 * 语音渲染元素：`ptt` 走 QqVoice。`localPath` 让预览从本机取音频（SILK 由主进程解码
 * 成 WAV，见 media_protocol 的 `localfilevoice`），`pttDuration` 决定时长文案与波形宽度。
 */
function recordRenderElement(seg: MfRecordSeg): MfElement {
  return {
    type: 'ptt',
    data: {
      fileName: seg.fileName ?? basename(seg.path),
      fileSize: seg.size ?? 0,
      pttDuration: seg.duration ?? 0,
      localPath: seg.path,
    },
  };
}

/** 视频渲染元素：`localPath` 让预览直接播本机文件（封面用 `thumbLocalPath`）。 */
function videoRenderElement(seg: MfVideoSeg): MfElement {
  return {
    type: 'video',
    data: {
      fileName: seg.fileName ?? basename(seg.path),
      fileSize: seg.size ?? 0,
      videoWidth: seg.width ?? 0,
      videoHeight: seg.height ?? 0,
      videoDuration: seg.duration ?? 0,
      localPath: seg.path,
      ...(seg.thumbPath ? { thumbLocalPath: seg.thumbPath } : {}),
    },
  };
}

/** 文件渲染元素：`file` 走 QqFile 卡片（图标按后缀 + 文件名 + 大小）。 */
function fileRenderElement(seg: MfFileSeg): MfElement {
  return {
    type: 'file',
    data: {
      fileName: seg.fileName ?? basename(seg.path),
      fileSize: seg.size ?? 0,
      localPath: seg.path,
    },
  };
}

/**
 * 分段 → 渲染视图元素（**预览**用）。
 *
 * 渲染层认识 text / at / face / pic / ptt / video / file / mface / ark / markdown /
 * multiMsg / emojiBounce —— 每个分段都映射成**和消息查看页面同一套**渲染元素
 * （媒体带 `localPath`，预览直接读本机文件），预览因此与真实消息渲染一致。
 *
 * 嵌套节点（`node` 段）不在这里处理：调用方应先看 {@link isNestedContent}，
 * 是嵌套内容就交给专门的预览组件。
 */
export function segsToRenderElements(segs: MfSeg[]): MfElement[] {
  const out: MfElement[] = [];
  for (const seg of segs) {
    // 空段（还没选文件的媒体、还没填序号的引用…）发送时会被过滤掉，预览也不画 ——
    // 否则会出现一个「未找到」占位，和发出去的样子对不上。
    if (!segHasContent(seg)) continue;
    switch (seg.t) {
      case 'text':
        out.push({ type: 'text', data: { textContent: seg.text } });
        break;
      case 'at':
        out.push({
          type: 'at',
          data: {
            textContent: seg.all ? '@全体成员 ' : `@${seg.name || seg.uin || seg.uid} `,
            atTargetUid: seg.all ? 'all' : seg.uid,
          },
        });
        break;
      case 'face':
        out.push({
          type: 'face',
          data: { faceId: seg.faceId, faceText: seg.faceText || '表情', subType: 1 },
        });
        break;
      case 'mface':
        out.push({
          type: 'mface',
          data: {
            marketEmoticonIdHex: seg.marketEmoticonId.toLowerCase(),
            emojiPackId: seg.emojiPackId,
            encryptKey: seg.encryptKey ?? '',
            previewWidth: seg.previewWidth ?? 300,
            previewHeight: seg.previewHeight ?? 300,
            isAnimated: true,
          },
        });
        break;
      case 'image':
        out.push(imageRenderElement(seg));
        break;
      case 'reply':
        out.push({
          type: 'reply',
          data: {
            origMsgSeq: seg.origMsgSeq,
            ...(seg.origSenderUin !== undefined ? { origSenderUin: seg.origSenderUin } : {}),
            ...(seg.origMsgTime !== undefined ? { origMsgTime: seg.origMsgTime } : {}),
            ...(seg.senderName ? { origSenderDisplayName: seg.senderName } : {}),
            origElements: seg.summary ? [{ type: 'text', data: { textContent: seg.summary } }] : [],
          },
        });
        break;
      case 'ark':
        out.push({ type: 'ark', data: { arkData: seg.arkData } });
        break;
      case 'xml':
        // XML 卡片发出去后收端是 richMsg(serviceId=35) → 解成 multiMsg，视图层靠
        // 同一段 XML 出卡片（标题 / 预览行 / 摘要），所以预览也走 multiMsg。
        out.push({
          type: 'multiMsg',
          data: { xmlContent: seg.xmlContent, resId: '', sessionId: '' },
        });
        break;
      case 'markdown':
        out.push({
          type: 'markdown',
          data: {
            markdownContent: seg.content,
            markdownTextSummary: seg.summary ?? '',
            markdownMeta: {},
          },
        });
        break;
      case 'card':
        out.push({ type: 'multiMsg', data: { resId: seg.resId, xmlContent: '', sessionId: '' } });
        break;
      case 'record':
        out.push(recordRenderElement(seg));
        break;
      case 'video':
        out.push(videoRenderElement(seg));
        break;
      case 'file':
        out.push(fileRenderElement(seg));
        break;
      case 'emojiBounce':
        out.push({
          type: 'emojiBounce',
          data: {
            emojiBounceId: seg.faceId,
            ...(seg.name ? { emojiBounceName: seg.name } : {}),
            emojiBounceTextSummary: seg.name ? `[${seg.name}]` : '[表情弹射]',
          },
        });
        break;
      case 'node':
        // 嵌套内容由调用方先判 isNestedContent 交给专门的卡片组件，走不到这里；
        // 万一是混排残渣也退化成标签，至少不静默丢内容。
        out.push({ type: 'text', data: { textContent: segLabel(seg) } });
        break;
    }
  }
  return out;
}

// ─────────────────────── 分段 → 协议发送元素（发送） ───────────────────────

/**
 * 把一个普通分段转成协议发送元素（媒体给本机绝对路径 `source`，发送时真实上传）。
 * 嵌套节点 / 空分段不应该走到这里。
 */
export function segToSendElement(seg: MfSeg): SendElement {
  switch (seg.t) {
    case 'text':
      return { kind: 'text', textContent: seg.text };
    case 'at':
      return seg.all
        ? { kind: 'at', all: true, textContent: '@全体成员 ' }
        : {
            kind: 'at',
            ...(seg.uin ? { atTargetUin: Number(seg.uin) || undefined } : {}),
            ...(seg.uid ? { atTargetUid: seg.uid } : {}),
            ...(seg.name ? { textContent: `@${seg.name} ` } : {}),
          };
    case 'face':
      return {
        kind: 'face',
        faceId: seg.faceId,
        ...(seg.faceText ? { faceText: seg.faceText } : {}),
      };
    case 'mface':
      return {
        kind: 'mface',
        marketEmoticonId: seg.marketEmoticonId,
        emojiPackId: seg.emojiPackId,
        ...(seg.faceName ? { faceName: seg.faceName } : {}),
        ...(seg.encryptKey ? { encryptKey: seg.encryptKey } : {}),
        ...(seg.previewWidth ? { previewWidth: seg.previewWidth } : {}),
        ...(seg.previewHeight ? { previewHeight: seg.previewHeight } : {}),
      };
    case 'image':
      return {
        kind: 'image',
        source: seg.path,
        ...(seg.fileName ? { fileName: seg.fileName } : {}),
        ...(seg.subType !== undefined ? { subType: seg.subType } : {}),
        ...(seg.width ? { width: seg.width } : {}),
        ...(seg.height ? { height: seg.height } : {}),
      };
    case 'record':
      return {
        kind: 'record',
        source: seg.path,
        ...(seg.fileName ? { fileName: seg.fileName } : {}),
        ...(seg.duration !== undefined ? { duration: seg.duration } : {}),
      };
    case 'video':
      return {
        kind: 'video',
        source: seg.path,
        ...(seg.thumbPath ? { thumb: seg.thumbPath } : {}),
        ...(seg.fileName ? { fileName: seg.fileName } : {}),
        ...(seg.duration !== undefined ? { duration: seg.duration } : {}),
        ...(seg.width ? { width: seg.width } : {}),
        ...(seg.height ? { height: seg.height } : {}),
      };
    case 'file':
      return {
        kind: 'file',
        source: seg.path,
        ...(seg.fileName ? { fileName: seg.fileName } : {}),
      };
    case 'ark':
      return { kind: 'ark', arkData: seg.arkData };
    case 'xml':
      return {
        kind: 'xml',
        xmlContent: seg.xmlContent,
        ...(seg.subType ? { subType: seg.subType } : {}),
      };
    case 'markdown':
      return {
        kind: 'markdown',
        markdownContent: seg.content,
        ...(seg.summary ? { markdownTextSummary: seg.summary } : {}),
      };
    case 'emojiBounce':
      return {
        kind: 'emojiBounce',
        faceId: seg.faceId,
        ...(seg.count !== undefined ? { count: seg.count } : {}),
        ...(seg.name ? { name: seg.name } : {}),
      };
    case 'reply':
      return {
        kind: 'reply',
        origMsgSeq: seg.origMsgSeq,
        ...(seg.origSenderUin !== undefined ? { origSenderUin: seg.origSenderUin } : {}),
        ...(seg.origMsgTime !== undefined ? { origMsgTime: seg.origMsgTime } : {}),
      };
    case 'card':
      return { kind: 'forward', resId: seg.resId };
    case 'node':
      throw new Error('嵌套转发节点不能作为普通发送元素（应走 innerForward）');
  }
}

/** 分段数组 → 发送元素数组（要求全部是非 node 段、且都有内容）。 */
export function segsToSendElements(segs: MfSeg[]): SendElement[] {
  const usable = segs.filter(segHasContent);
  if (usable.length === 0) throw new Error('转发节点内容为空');
  if (usable.some((seg) => seg.t === 'node')) {
    throw new Error('一个节点里不能把嵌套转发和普通内容混在一起');
  }
  return usable.map(segToSendElement);
}

/** 一个普通预览消息 → 协议节点（内容为元素）。 */
export function nodeToSendNode(node: MfNode): SendForwardNodeInput {
  const uin = Number(node.sender?.uin) || 0;
  const inner = isNestedContent(node.segs) ? nestedSegsToSendNodes(node.segs) : undefined;
  return {
    ...(uin > 0 ? { userUin: uin } : {}),
    ...(node.sender?.name ? { nickname: node.sender.name } : {}),
    ...(node.time ? { time: node.time } : {}),
    elements: inner ? [] : segsToSendElements(node.segs),
    ...(inner ? { innerForward: inner } : {}),
  };
}

/** 嵌套转发内容（全是 node 段）→ 协议 `innerForward` 节点数组。 */
export function nestedSegsToSendNodes(segs: MfSeg[]): SendForwardNodeInput[] {
  const nodes: SendForwardNodeInput[] = [];
  for (const seg of segs) {
    if (seg.t !== 'node') continue;
    // 记录里还没写内容的消息不占位置（用户随手加了一条空消息也能发）。
    if (!seg.segs.some(segHasContent)) continue;
    const uin = Number(seg.userUin) || 0;
    const inner = isNestedContent(seg.segs) ? nestedSegsToSendNodes(seg.segs) : undefined;
    nodes.push({
      ...(uin > 0 ? { userUin: uin } : {}),
      ...(seg.nickname ? { nickname: seg.nickname } : {}),
      ...(seg.time ? { time: seg.time } : {}),
      elements: inner ? [] : segsToSendElements(seg.segs),
      ...(inner ? { innerForward: inner } : {}),
    });
  }
  if (nodes.length === 0) throw new Error('嵌套转发内容为空');
  return nodes;
}

/** 草稿 → 协议节点数组。发送前会先做 {@link validateDraft} 校验。 */
export function draftToSendNodes(draft: MfDraft): SendForwardNodeInput[] {
  if (draft.nodes.length === 0) throw new Error('合并转发至少需要一条预览消息');
  return draft.nodes.filter((node) => node.segs.some(segHasContent)).map(nodeToSendNode);
}

/** 「复制 JSON」用的可读载荷（协议发送形状；校验不过时给出原因而不是抛错）。 */
export function draftToJson(draft: MfDraft): string {
  try {
    return JSON.stringify(
      {
        title: draft.title || draftTitle(draft.nodes),
        nodes: draftToSendNodes(draft),
      },
      null,
      2,
    );
  } catch (error) {
    return JSON.stringify(
      { error: error instanceof Error ? error.message : String(error) },
      null,
      2,
    );
  }
}

// ─────────────────────── 本库原始 wire 元素 → 分段 ───────────────────────

/** `{type:'Buffer', data:[...]}` 盒子 → hex 字符串（其它原样返回）。 */
function boxedBytesToHex(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    return Array.from(value)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  if (value && typeof value === 'object') {
    const box = value as { type?: unknown; data?: unknown };
    if (box.type === 'Buffer' && Array.isArray(box.data)) {
      return (box.data as number[]).map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
    }
  }
  return '';
}

function str(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

function num(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 引用元素里「被引消息」的摘要（origElements 的文本部分；媒体取占位标签）。 */
function replySummary(element: Record<string, unknown>): string | undefined {
  const list = element.origElements;
  if (!Array.isArray(list)) return undefined;
  const text = list
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const box = item as Record<string, unknown>;
      const kind = typeof box.kind === 'string' ? box.kind : '';
      if (kind === 'text' || kind === 'at') return str(box, 'textContent');
      return MEDIA_LABEL[kind] ?? '';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

/**
 * 本库原始 wire 元素（`account.getRawElements` 的产物，bytes 已被 box 成
 * `{type:'Buffer',data}`）→ 分段。**能再次上传发送**是重点：图片 / 语音取
 * `localPath` / `filePath` 作为发送 `source`；取不到本机文件的媒体退化为文本标签，
 * 而不是构造一个发不出去的段。
 *
 * 返回 null 表示这条元素不进转发（引用 / 灰条之类没有转发意义）。
 */
export function codecElementToSeg(element: Record<string, unknown>): MfSeg | null {
  const kind = str(element, 'kind');
  switch (kind) {
    case 'text':
      return { t: 'text', id: mfId('seg'), text: str(element, 'textContent') };
    case 'at':
      return {
        t: 'at',
        id: mfId('seg'),
        uid: str(element, 'atTargetUid'),
        uin: '',
        name: str(element, 'textContent').replace(/^@/, '').trim(),
      };
    case 'reply': {
      const summary = replySummary(element);
      return {
        t: 'reply',
        id: mfId('seg'),
        origMsgSeq: num(element, 'origMsgSeq'),
        ...(num(element, 'origSenderUin') ? { origSenderUin: num(element, 'origSenderUin') } : {}),
        ...(num(element, 'origMsgTime') ? { origMsgTime: num(element, 'origMsgTime') } : {}),
        ...(summary ? { summary } : {}),
      };
    }
    case 'face':
      return {
        t: 'face',
        id: mfId('seg'),
        faceId: num(element, 'faceId'),
        faceText: str(element, 'faceText'),
      };
    case 'mface': {
      const hex = boxedBytesToHex(element.marketEmoticonId);
      if (!hex) return { t: 'text', id: mfId('seg'), text: '[商城表情]' };
      return {
        t: 'mface',
        id: mfId('seg'),
        marketEmoticonId: hex,
        emojiPackId: num(element, 'emojiPackId'),
        ...(str(element, 'faceName') ? { faceName: str(element, 'faceName') } : {}),
        ...(str(element, 'encryptKey') ? { encryptKey: str(element, 'encryptKey') } : {}),
        ...(num(element, 'previewWidth') ? { previewWidth: num(element, 'previewWidth') } : {}),
        ...(num(element, 'previewHeight') ? { previewHeight: num(element, 'previewHeight') } : {}),
      };
    }
    case 'pic': {
      const path = str(element, 'localPath') || str(element, 'filePath');
      if (!path) return { t: 'text', id: mfId('seg'), text: '[图片]' };
      return {
        t: 'image',
        id: mfId('seg'),
        path,
        fileName: str(element, 'fileName') || basename(path),
        size: num(element, 'fileSize'),
        width: num(element, 'imgWidth'),
        height: num(element, 'imgHeight'),
        subType: num(element, 'subType'),
      };
    }
    case 'ptt': {
      const path = str(element, 'filePath');
      if (!path) return { t: 'text', id: mfId('seg'), text: '[语音]' };
      return {
        t: 'record',
        id: mfId('seg'),
        path,
        fileName: str(element, 'fileName') || basename(path),
        size: num(element, 'fileSize'),
        duration: num(element, 'pttDuration'),
      };
    }
    case 'video': {
      const path =
        str(element, 'filePath') ||
        str(element, 'videoCoverLocalPath') ||
        str(element, 'fileThumbLocalPath');
      if (!path) return { t: 'text', id: mfId('seg'), text: '[视频]' };
      return {
        t: 'video',
        id: mfId('seg'),
        path,
        fileName: str(element, 'fileName') || basename(path),
        size: num(element, 'fileSize'),
        duration: num(element, 'videoDuration'),
        width: num(element, 'videoWidth'),
        height: num(element, 'videoHeight'),
      };
    }
    case 'file': {
      const path = str(element, 'filePath');
      if (!path) {
        const name = str(element, 'fileName');
        return { t: 'text', id: mfId('seg'), text: name ? `[文件: ${name}]` : '[文件]' };
      }
      return {
        t: 'file',
        id: mfId('seg'),
        path,
        fileName: str(element, 'fileName') || basename(path),
        size: num(element, 'fileSize'),
      };
    }
    case 'ark':
      return { t: 'ark', id: mfId('seg'), arkData: str(element, 'arkData') };
    case 'markdown':
      return {
        t: 'markdown',
        id: mfId('seg'),
        content: str(element, 'markdownContent'),
        ...(str(element, 'markdownTextSummary')
          ? { summary: str(element, 'markdownTextSummary') }
          : {}),
      };
    case 'multiMsg': {
      const resId = str(element, 'resId');
      if (resId) return { t: 'card', id: mfId('seg'), resId };
      return { t: 'text', id: mfId('seg'), text: '[聊天记录]' };
    }
    case 'emojiBounce':
      return {
        t: 'emojiBounce',
        id: mfId('seg'),
        faceId: num(element, 'emojiBounceId'),
        ...(str(element, 'emojiBounceName') ? { name: str(element, 'emojiBounceName') } : {}),
      };
    case 'grayTipRevoke':
    case 'grayTipPoke':
    case 'grayTipGroup':
    case 'grayTipXml':
    case 'grayTipFileRecv':
    case 'grayTipTempSession':
    case 'call':
      return null;
    default: {
      const label = MEDIA_LABEL[kind] ?? '';
      return label ? { t: 'text', id: mfId('seg'), text: label } : null;
    }
  }
}

/** 一条消息的原始 wire 元素数组 → 分段数组（过滤掉不转发的元素）。 */
export function codecElementsToSegs(elements: unknown[]): MfSeg[] {
  const segs: MfSeg[] = [];
  for (const element of elements) {
    if (!element || typeof element !== 'object') continue;
    const seg = codecElementToSeg(element as Record<string, unknown>);
    if (seg && segHasContent(seg)) segs.push(seg);
  }
  return segs;
}

/** 渲染视图元素 → 分段（旧草稿迁移用；媒体取不到本机路径时退化为文本标签）。 */
export function renderElementsToSegs(elements: MfElement[]): MfSeg[] {
  const segs: MfSeg[] = [];
  for (const element of elements ?? []) {
    const data = (element?.data ?? {}) as Record<string, unknown>;
    switch (element?.type) {
      case 'text':
        if (str(data, 'textContent'))
          segs.push({ t: 'text', id: mfId('seg'), text: str(data, 'textContent') });
        break;
      case 'at':
        segs.push({
          t: 'at',
          id: mfId('seg'),
          uid: str(data, 'atTargetUid'),
          uin: '',
          name: str(data, 'textContent').replace(/^@/, '').trim(),
        });
        break;
      case 'reply':
        segs.push({
          t: 'reply',
          id: mfId('seg'),
          origMsgSeq: num(data, 'origMsgSeq'),
          ...(num(data, 'origSenderUin') ? { origSenderUin: num(data, 'origSenderUin') } : {}),
          ...(num(data, 'origMsgTime') ? { origMsgTime: num(data, 'origMsgTime') } : {}),
        });
        break;
      case 'face':
        segs.push({
          t: 'face',
          id: mfId('seg'),
          faceId: num(data, 'faceId'),
          faceText: str(data, 'faceText'),
        });
        break;
      case 'pic': {
        const path = str(data, 'localPath') || str(data, 'filePath');
        if (path) {
          segs.push({
            t: 'image',
            id: mfId('seg'),
            path,
            fileName: str(data, 'fileName') || basename(path),
            size: num(data, 'fileSize'),
            width: num(data, 'imgWidth'),
            height: num(data, 'imgHeight'),
          });
        } else {
          segs.push({ t: 'text', id: mfId('seg'), text: '[图片]' });
        }
        break;
      }
      case 'ptt': {
        const path = str(data, 'localPath') || str(data, 'filePath');
        if (path) {
          segs.push({
            t: 'record',
            id: mfId('seg'),
            path,
            fileName: str(data, 'fileName') || basename(path),
            size: num(data, 'fileSize'),
            duration: num(data, 'pttDuration'),
          });
        } else {
          segs.push({ t: 'text', id: mfId('seg'), text: '[语音]' });
        }
        break;
      }
      case 'video': {
        const path =
          str(data, 'localPath') || str(data, 'filePath') || str(data, 'videoCoverLocalPath');
        if (path) {
          const thumb = str(data, 'thumbLocalPath') || str(data, 'fileThumbLocalPath');
          segs.push({
            t: 'video',
            id: mfId('seg'),
            path,
            fileName: str(data, 'fileName') || basename(path),
            size: num(data, 'fileSize'),
            duration: num(data, 'videoDuration'),
            width: num(data, 'videoWidth'),
            height: num(data, 'videoHeight'),
            ...(thumb ? { thumbPath: thumb } : {}),
          });
        } else {
          segs.push({ t: 'text', id: mfId('seg'), text: '[视频]' });
        }
        break;
      }
      case 'file': {
        const path = str(data, 'localPath') || str(data, 'filePath');
        if (path) {
          segs.push({
            t: 'file',
            id: mfId('seg'),
            path,
            fileName: str(data, 'fileName') || basename(path),
            size: num(data, 'fileSize'),
          });
        } else {
          const name = str(data, 'fileName');
          segs.push({ t: 'text', id: mfId('seg'), text: name ? `[文件: ${name}]` : '[文件]' });
        }
        break;
      }
      case 'emojiBounce': {
        segs.push({
          t: 'emojiBounce',
          id: mfId('seg'),
          faceId: num(data, 'emojiBounceId'),
          ...(str(data, 'emojiBounceName') ? { name: str(data, 'emojiBounceName') } : {}),
        });
        break;
      }
      case 'mface':
        segs.push({
          t: 'mface',
          id: mfId('seg'),
          marketEmoticonId: str(data, 'marketEmoticonIdHex'),
          emojiPackId: num(data, 'emojiPackId'),
        });
        break;
      case 'ark':
        segs.push({ t: 'ark', id: mfId('seg'), arkData: str(data, 'arkData') });
        break;
      case 'markdown':
        segs.push({
          t: 'markdown',
          id: mfId('seg'),
          content: str(data, 'markdownContent'),
          ...(str(data, 'markdownTextSummary')
            ? { summary: str(data, 'markdownTextSummary') }
            : {}),
        });
        break;
      case 'multiMsg':
        segs.push({ t: 'card', id: mfId('seg'), resId: str(data, 'resId') });
        break;
      default:
        if (element?.type) {
          segs.push({
            t: 'text',
            id: mfId('seg'),
            text: MEDIA_LABEL[element.type] ?? '[消息]',
          });
        }
    }
  }
  return segs;
}

function basename(path: string): string {
  if (!path) return '';
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

// ───────────────────────────── 草稿校验 ─────────────────────────────

/** 逐条消息 / 逐段检查，返回第一条问题；没问题返回 null。 */
export function validateDraft(draft: MfDraft): string | null {
  const usable = draft.nodes.filter((node) => node.segs.some(segHasContent));
  if (usable.length === 0) return '至少要有一条有内容的预览消息';
  for (const node of usable) {
    const problem = validateSegs(node.segs);
    if (problem) return `「${node.sender?.name || '未命名'}」的消息：${problem}`;
  }
  return null;
}

/** 校验一组分段（递归进嵌套节点）。 */
export function validateSegs(segs: MfSeg[]): string | null {
  const usable = segs.filter(segHasContent);
  if (usable.length === 0) {
    return segs.some((seg) => seg.t === 'node') ? '聊天记录里还没有内容' : '内容为空';
  }
  const hasNode = usable.some((seg) => seg.t === 'node');
  const hasPlain = usable.some((seg) => seg.t !== 'node');
  if (hasNode && hasPlain) return '嵌套转发不能和普通内容混在一条里';
  for (const seg of usable) {
    const problem = validateSeg(seg);
    if (problem) return problem;
  }
  return null;
}

function validateSeg(seg: MfSeg): string | null {
  switch (seg.t) {
    case 'at':
      if (!seg.all && !seg.uid && !seg.uin) return '@ 段没有选择对象';
      return null;
    case 'reply':
      if (!(seg.origMsgSeq > 0)) return '引用段还没有填被引用消息的序号';
      return null;
    case 'image':
    case 'record':
    case 'video':
      if (!seg.path.trim()) return `${segLabel(seg)}没有选择本机文件`;
      return null;
    case 'file':
      if (!seg.path.trim()) return '文件没有选择本机文件';
      return null;
    case 'mface':
      if (!/^[0-9a-fA-F]{32}$/.test(seg.marketEmoticonId)) return '商城表情的 id 不合法';
      return null;
    case 'card':
      if (!seg.resId.trim()) return '聊天记录卡片缺少 resId';
      return null;
    case 'node':
      // 发送者 QQ 允许为空（协议里可省略，卡片会退化成「QQ用户」）。
      return validateSegs(seg.segs);
    default:
      return null;
  }
}

// ───────────────────────────── 草稿持久化 ─────────────────────────────

/**
 * 把服务端返回的草稿归一到前端类型。服务端已经做过归一化；这里额外把**旧版草稿**
 * （节点只有 `elements` 渲染元素、没有 `segs`）迁移成分段。
 */
export function coerceDraft(raw: {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodes: Array<{
    id: string;
    sender: MfSender;
    segs?: unknown[];
    elements?: unknown[];
    time: number;
    decoration?: { bubbleId: number; fontId: number; widgetId: number };
    sourceMsgId?: string;
  }>;
}): MfDraft {
  return {
    id: raw.id,
    title: raw.title,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    nodes: raw.nodes.map((node) => {
      const fromSegs = Array.isArray(node.segs) ? (node.segs as MfSeg[]) : null;
      const segs = fromSegs ?? renderElementsToSegs((node.elements ?? []) as MfElement[]);
      return {
        id: node.id,
        sender: node.sender,
        segs,
        time: node.time,
        ...(node.decoration ? { decoration: node.decoration } : {}),
        ...(node.sourceMsgId ? { sourceMsgId: node.sourceMsgId } : {}),
      };
    }),
  };
}
