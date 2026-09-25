/**
 * MergeForwardDraftStore — 「合成聊天记录」（合并转发）草稿的本地存储。
 *
 * 合并转发**发送**需要 QQ 在线且已注入；不在线时用户编辑到一半的聊天记录不能丢，
 * 所以每个账号在 weq 缓存目录里留一份 JSON：一条草稿 = 一组「预览消息（node）」。
 *
 * 每个 node 携带：
 *   - sender（uid / uin / 昵称）—— 合并转发的惯例是**无论谁发的都显示在左侧**，
 *     所以发送者信息是逐条编辑出来的，不属于真实会话；
 *   - elements —— 渲染视图元素（`{type, data}`），原样保留，媒体 / 表情都不丢；
 *   - decoration —— 逐条消息装扮（40801 的 bubbleId / fontId / widgetId），
 *     接线发送时用得上，**绝不丢失**；
 *   - time / sourceMsgId —— 展示时间与来源消息（回读原始 wire 元素用）。
 *
 * 与其它 account/ 下的 store 一样：load-on-construct、变更即原子落盘、I/O 失败静默。
 */

import { JsonStore } from '../common/json_store';

/** 一条预览消息的发送者。uin 是头像来源；uid 可能为空（手工输入时只有 uin）。 */
export interface MergeForwardSender {
  uid: string;
  uin: string;
  name: string;
}

/** 一条预览消息。 */
export interface MergeForwardNode {
  /** 本地稳定 id（拖动排序 / React key）。 */
  id: string;
  sender: MergeForwardSender;
  /**
   * 内容**分段**（`{t, ...}`，见前端 mergeForward/model.ts）。服务层不认识分段
   * 内部结构，只保证是对象数组；编辑 / 预览 / 发送三处的语义由渲染层统一。
   */
  segs: unknown[];
  /** 该条消息的展示时间（unix 秒）。 */
  time: number;
  /** 逐条消息装扮（列 40801）。0 表示未设置 —— 求和时忽略。 */
  decoration?: { bubbleId: number; fontId: number; widgetId: number };
  /** 来源消息 msgId（从真实消息带入时存在）。 */
  sourceMsgId?: string;
}

/** 一份「合成聊天记录」草稿。 */
export interface MergeForwardDraft {
  id: string;
  /** 预览卡片标题（如「A和B的聊天记录」），空则前端补默认值。 */
  title: string;
  createdAt: number;
  updatedAt: number;
  nodes: MergeForwardNode[];
}

/** 保存时的载荷（id 由前端生成；updatedAt 由服务层盖章）。 */
export interface MergeForwardDraftInput {
  id: string;
  title?: string;
  createdAt?: number;
  nodes: MergeForwardNode[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 宽松归一化一个分段 —— 只保证是对象，具体字段交给渲染层。 */
function normalizeSeg(raw: unknown): unknown {
  return isObject(raw) ? raw : { t: 'text', textContent: asString(raw) };
}

function normalizeDecoration(raw: unknown): MergeForwardNode['decoration'] | undefined {
  if (!isObject(raw)) return undefined;
  const bubbleId = asNumber(raw.bubbleId);
  const fontId = asNumber(raw.fontId);
  const widgetId = asNumber(raw.widgetId);
  if (!bubbleId && !fontId && !widgetId) return undefined;
  return { bubbleId, fontId, widgetId };
}

function normalizeSender(raw: unknown): MergeForwardSender {
  const src = isObject(raw) ? raw : {};
  return {
    uid: asString(src.uid),
    uin: asString(src.uin),
    name: asString(src.name),
  };
}

function normalizeNode(raw: unknown, index: number): MergeForwardNode | null {
  if (!isObject(raw)) return null;
  // `segs` 是本版的新字段；旧草稿存的是渲染元素 `elements`，这里保留给前端做迁移。
  const source = Array.isArray(raw.segs)
    ? raw.segs
    : Array.isArray(raw.elements)
      ? raw.elements
      : [];
  const segs = source.map(normalizeSeg);
  return {
    id: asString(raw.id) || `node-${index}`,
    sender: normalizeSender(raw.sender),
    segs,
    time: asNumber(raw.time),
    ...(normalizeDecoration(raw.decoration)
      ? { decoration: normalizeDecoration(raw.decoration) }
      : {}),
    ...(asString(raw.sourceMsgId) ? { sourceMsgId: asString(raw.sourceMsgId) } : {}),
  };
}

function normalizeDraft(raw: unknown, fallbackId: string): MergeForwardDraft | null {
  if (!isObject(raw)) return null;
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes
        .map((node, index) => normalizeNode(node, index))
        .filter((n): n is MergeForwardNode => n !== null)
    : [];
  return {
    id: asString(raw.id) || fallbackId,
    title: asString(raw.title),
    createdAt: asNumber(raw.createdAt),
    updatedAt: asNumber(raw.updatedAt),
    nodes,
  };
}

export class MergeForwardDraftStore {
  private readonly store: JsonStore<Record<string, MergeForwardDraft>>;

  constructor(filePath: string) {
    this.store = new JsonStore(filePath, () => ({}), {
      pretty: true,
      normalize: (raw) => {
        if (!isObject(raw)) return {};
        const out: Record<string, MergeForwardDraft> = {};
        for (const [key, value] of Object.entries(raw)) {
          const draft = normalizeDraft(value, key);
          if (draft) out[draft.id] = draft;
        }
        return out;
      },
    });
  }

  /** 全部草稿，最近更新在前。 */
  list(): MergeForwardDraft[] {
    return Object.values(this.store.data).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): MergeForwardDraft | undefined {
    return this.store.data[id];
  }

  /** 新建或覆盖一份草稿，返回落盘后的副本。 */
  save(input: MergeForwardDraftInput): MergeForwardDraft {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.store.data[input.id];
    const nodes = input.nodes
      .map((node, index) => normalizeNode(node, index))
      .filter((node): node is MergeForwardNode => node !== null);
    const draft: MergeForwardDraft = {
      id: input.id,
      title: input.title ?? existing?.title ?? '',
      createdAt: input.createdAt ?? existing?.createdAt ?? now,
      updatedAt: now,
      nodes,
    };
    this.store.data[draft.id] = draft;
    this.store.save();
    return draft;
  }

  remove(id: string): boolean {
    if (this.store.data[id] === undefined) return false;
    delete this.store.data[id];
    this.store.save();
    return true;
  }
}
