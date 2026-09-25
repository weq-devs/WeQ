/**
 * 合并转发（合成聊天记录）前端数据模型。
 *
 * 这是**核心组件 + 两个使用场景**共用的那一份模型：
 *   1. 聊天里多选消息 → 合并转发；
 *   2. 左栏「更多 → 合成聊天记录」→ 从空白卡片拼一份聊天记录。
 *
 * 设计要点：
 *   - 每条预览消息（{@link MfNode}）自带发送者 —— 合并转发的惯例是**所有消息都在
 *     左侧显示**，发送者只作为「头像 + 昵称」展示，与真实会话无关。
 *   - `elements` 是渲染视图元素（`{type, data}`），原样保留，媒体 / 表情都不丢。
 *   - `decoration` 是逐条消息装扮（40801）；发送合并转发时要一并带上，**不丢**。
 *   - {@link draftToProtocolPayload} 只**产出参数**，真正发包由另一分支接入
 *     （SnowLuma 的 `ForwardApi.upload` → `UploadLongMsg`），这里不碰 protocol。
 */

/** 渲染视图元素（`{type, data}`）—— 与 ForwardWindow / QqMessageContent 同形。 */
export type MfElement = { type?: string; data?: Record<string, unknown> };

/** 一条预览消息的发送者。合并转发里 uin 是头像来源；uid 可能为空（手工输入）。 */
export interface MfSender {
  uid: string;
  uin: string;
  name: string;
}

/** 一条预览消息。 */
export interface MfNode {
  /** 本地稳定 id（排序 / React key）。 */
  id: string;
  sender: MfSender;
  /** 渲染视图元素，原样保留。 */
  elements: MfElement[];
  /** 展示时间（unix 秒）。 */
  time: number;
  /** 逐条消息装扮（列 40801）。0 = 未设置。 */
  decoration?: { bubbleId: number; fontId: number; widgetId: number };
  /** 来源消息 msgId（从真实消息带入时存在，接线时回读原始 wire 元素）。 */
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

/** 由发送者信息造一条空消息（`elements` 由调用方填）。 */
export function createNode(sender: MfSender, elements: MfElement[] = [], time = nowSeconds()): MfNode {
  return { id: mfId('node'), sender, elements, time };
}

/** 头像：永远按 uin 拼（不依赖数据库里可能过期 / 裂图的外链）。 */
export function senderAvatarUrl(uin: string | undefined | null): string | null {
  return uin && uin !== '0' ? `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}` : null;
}

/** 一条预览消息的纯文本摘要（列表 / 卡片预览用）。 */
export function summarizeNode(node: MfNode): string {
  for (const el of node.elements ?? []) {
    const data = el?.data ?? {};
    switch (el?.type) {
      case 'text':
      case 'at':
        if (typeof data.textContent === 'string' && data.textContent.trim()) {
          return truncate(data.textContent.trim(), 40);
        }
        break;
      case 'face':
        return '[表情]';
      case 'pic':
        return '[图片]';
      case 'video':
        return '[视频]';
      case 'file':
      case 'onlineFile':
        return '[文件]';
      case 'ptt':
        return '[语音]';
      case 'mface':
        return '[动画表情]';
      case 'multiMsg':
        return '[聊天记录]';
      case 'reply':
        break;
      default:
        if (typeof data.textContent === 'string' && data.textContent.trim()) {
          return truncate(data.textContent.trim(), 40);
        }
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

/**
 * 协议发送需要的参数（对齐 SnowLuma `ForwardNodePayload` / `UploadLongMsg` 的
 * `MultiMsg.msgBody`）。**这里只构造、不发送** —— 发送接缝由另一分支实现。
 */
export interface MfProtocolNode {
  /** 发送者 QQ 号（>0）。 */
  userUin: number;
  /** 发送者昵称 / 群名片。 */
  nickname: string;
  /** 消息段（渲染视图元素；接线时按 element-builder 需要的形状补 wire 字段）。 */
  elements: MfElement[];
  /** 展示时间（unix 秒）；0 表示用「现在」。 */
  time: number;
  /** 来源消息 id（方便接线时回读原始 40800 / 40900）。 */
  msgId?: string;
  /** 逐条消息装扮（不丢）。 */
  decoration?: { bubbleId: number; fontId: number; widgetId: number };
}

/** 一份待发送的合并转发载荷。 */
export interface MfProtocolPayload {
  nodes: MfProtocolNode[];
  target: { kind: 'c2c' | 'group'; conv: string };
  title: string;
}

/**
 * 草稿 → 协议载荷。`target` 只在「转发到某会话」时有意义；从「合成聊天记录」
 * 打开时先不带目标。
 */
export function draftToProtocolPayload(
  draft: MfDraft,
  target?: { kind: 'c2c' | 'group'; conv: string },
): MfProtocolPayload {
  const nodes: MfProtocolNode[] = draft.nodes.map((node) => ({
    userUin: Number(node.sender?.uin) || 0,
    nickname: node.sender?.name ?? '',
    elements: node.elements ?? [],
    time: node.time || 0,
    ...(node.sourceMsgId ? { msgId: node.sourceMsgId } : {}),
    ...(node.decoration ? { decoration: node.decoration } : {}),
  }));
  return {
    nodes,
    target: target ?? { kind: 'c2c', conv: '' },
    title: draft.title || draftTitle(draft.nodes),
  };
}

/**
 * 把服务端返回的草稿（`elements: unknown[]`）归一到前端类型。服务端已经做过归一化，
 * 这里只做类型层面的收口。
 */
export function coerceDraft(raw: {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodes: Array<{
    id: string;
    sender: MfSender;
    elements: unknown[];
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
    nodes: raw.nodes.map((node) => ({
      id: node.id,
      sender: node.sender,
      elements: node.elements as MfElement[],
      time: node.time,
      ...(node.decoration ? { decoration: node.decoration } : {}),
      ...(node.sourceMsgId ? { sourceMsgId: node.sourceMsgId } : {}),
    })),
  };
}

/** 「复制 JSON」用的可读载荷（不含需要异步回读的原始 wire 字段）。 */
export function draftToJson(draft: MfDraft): string {
  return JSON.stringify(draftToProtocolPayload(draft), null, 2);
}
