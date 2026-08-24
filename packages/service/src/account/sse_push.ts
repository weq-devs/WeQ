/**
 * SsePushService —— 把 QQ 新消息通过 HTTP 推送到用户配置的「推送地址」。
 *
 * 实现参考 `tools/db_watch_listen.ts`：同一套 DbWatchService + createNtMsgDbHook
 * 实时监听 nt_msg.db，把新插入的 c2c / group 消息作为事件源。
 *
 * 事件整形（本文件做的事）：
 *   - 防抖：收到新消息后等待一段「空闲」再统一推送（trailing debounce），把 QQ
 *     启动 / 大流量写入时的一串文件变化合并成一次推送；
 *   - 阈值：某个会话的 seq 一次跳变超过 `massThreshold`（例如 2000 -> 4000）时，
 *     不再逐条推送（也不值得真去推 2000 条），而是合并成一条 `mass` 事件，
 *     给出 fromSeq / toSeq / count 并预览最新一条——这正是「QQ 刚启动正在写表」
 *     的典型场景；
 *   - 重试：推送失败保留待推队列，按指数退避重试（封顶 60s），不丢消息；
 *   - 鉴权：POST 时带 `Authorization: Bearer <access_token>`。
 *
 * 生命周期：随账号打开而 start()，账号关闭而 stop()。配置变化走 setTarget /
 * setTuning，无需重建实例。
 */

import type { AccountSession } from '@weq/account';
import type { Element } from '@weq/codec';
import type { C2cMsg, GroupMsg } from '@weq/db';
import { getLogger, logErrorContext } from '../common/logger';
import { DbWatchService, type DbWatchHandle } from './db_watch';
import { createNtMsgDbHook, type NewMessages } from './nt_msg_hook';

/** 推送目标：接收端地址 + access_token。 */
export interface SsePushTarget {
  pushUrl: string;
  accessToken: string;
}

export interface SsePushOptions {
  /** 防抖毫秒（默认 2000）。 */
  debounceMs?: number;
  /** 大量消息阈值：会话 seq 跳变超过该值时合并成一条 mass 事件（默认 50）。 */
  massThreshold?: number;
  /** 单次 HTTP 超时毫秒（默认 10_000）。 */
  timeoutMs?: number;
  /** 待推队列上限（默认 5000），超出时丢弃最旧的消息，避免内存无限增长。 */
  maxPending?: number;
}

/** 一条待推的单条消息事件。 */
export interface SseMessageEvent {
  type: 'message';
  chatType: 'c2c' | 'group';
  /** 会话 id：私聊为对方 uid，群聊为群号。 */
  convId: string;
  msgId: string;
  msgSeq: string;
  senderUid: string;
  senderUin: string;
  /** unix 秒。 */
  sendTime: string;
  /** 文本摘要：text/at 取正文，其余元素只给标签。 */
  text: string;
}

/** 大量消息合并事件：seq 跳变过大时替代逐条推送，只预览最新一条。 */
export interface SseMassEvent {
  type: 'mass';
  chatType: 'c2c' | 'group';
  convId: string;
  fromSeq: string;
  toSeq: string;
  count: number;
  preview: SseMessageEvent | null;
}

export type SsePushEvent = SseMessageEvent | SseMassEvent;

/** HTTP 推送的请求体形状（`{ events: [...] }`）。 */
export interface SsePushPayload {
  events: SsePushEvent[];
}

interface PendingRow {
  kind: 'c2c' | 'group';
  msg: C2cMsg | GroupMsg;
}

interface ConvGroup {
  kind: 'c2c' | 'group';
  rows: PendingRow[];
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

export class SsePushService {
  private readonly session: AccountSession;
  private readonly opts: Required<SsePushOptions>;
  private readonly watch = new DbWatchService({ intervalMs: 1_000 });
  private readonly logger = getLogger().child({ scope: 'sse-push' });

  private handle: DbWatchHandle | null = null;
  private target: SsePushTarget | null = null;
  private pending: PendingRow[] = [];
  /** convKey -> 最近一次已成功推送的 seq。 */
  private lastSeq = new Map<string, bigint>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private retryCount = 0;

  constructor(session: AccountSession, opts: SsePushOptions = {}) {
    this.session = session;
    this.opts = {
      debounceMs: opts.debounceMs ?? 2_000,
      massThreshold: opts.massThreshold ?? 50,
      timeoutMs: opts.timeoutMs ?? 10_000,
      maxPending: opts.maxPending ?? 5_000,
    };
  }

  /** 挂载 nt_msg.db 监听。幂等。 */
  start(): void {
    if (this.handle) return;
    this.logger.info('starting sse push watcher', {
      event: 'sse-push-start',
      accountUin: this.session.context.uin,
    });
    this.handle = this.watch.mount(
      createNtMsgDbHook(this.session, {
        onDbChanged: () => {
          /* 与 UI 刷新路径无关，忽略 */
        },
        onNewMessages: (change: NewMessages) => this.onNewMessages(change),
      }),
    );
  }

  /** 停止监听并清空待推队列。幂等。 */
  stop(): void {
    if (!this.handle) return;
    this.handle.unmount();
    this.handle = null;
    this.clearTimers();
    this.pending = [];
    this.lastSeq.clear();
    this.retryCount = 0;
    this.logger.info('stopped sse push watcher', { event: 'sse-push-stop' });
  }

  /** 更新推送目标（地址 / token）。传 null 表示停用（清空待推队列）。 */
  setTarget(target: SsePushTarget | null): void {
    const changed =
      target?.pushUrl !== this.target?.pushUrl ||
      target?.accessToken !== this.target?.accessToken;
    this.target = target;
    if (!target) {
      this.pending = [];
      this.clearTimers();
      return;
    }
    // 换目标后立刻按新目标重试/推送（不再沿用旧退避）。
    if (changed && this.retryTimer) {
      this.clearRetry();
      void this.flush();
    }
  }

  /** 更新防抖 / 阈值调优。 */
  setTuning(tuning: { debounceMs: number; massThreshold: number }): void {
    this.opts.debounceMs = tuning.debounceMs;
    this.opts.massThreshold = tuning.massThreshold;
  }

  // ---- internals ----

  private onNewMessages(change: NewMessages): void {
    for (const m of change.c2c) this.pending.push({ kind: 'c2c', msg: m });
    for (const m of change.group) this.pending.push({ kind: 'group', msg: m });
    if (this.pending.length > this.opts.maxPending) {
      // 队列爆了：丢最旧的（它们会被 mass 事件兜住），保最新的。
      const overflow = this.pending.length - this.opts.maxPending;
      this.pending.splice(0, overflow);
      this.logger.warn('sse push pending overflow, dropped oldest rows', {
        event: 'sse-push-overflow',
        dropped: overflow,
      });
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, this.opts.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    const target = this.target;
    if (!target || this.pending.length === 0) return;

    this.flushing = true;
    try {
      const { events, consumed, nextSeqs } = await this.buildEvents();
      if (events.length === 0) {
        // 全是已推送过的旧行，直接消费掉。
        this.pending.splice(0, consumed);
        return;
      }
      const res = await postSsePushEvents(target, events, this.opts.timeoutMs);
      if (!res.ok) {
        throw new Error(`推送地址返回 HTTP ${res.status}`);
      }
      // 推送成功才推进水位；失败时 lastSeq 保持原样，重试会重新生成同样的事件。
      for (const [key, seq] of nextSeqs) this.lastSeq.set(key, seq);
      this.retryCount = 0;
      this.pending.splice(0, consumed);
      this.logger.info('pushed sse events', {
        event: 'sse-push-ok',
        count: events.length,
        url: target.pushUrl,
      });
    } catch (error) {
      this.retryCount += 1;
      const delay = Math.min(
        RETRY_MAX_MS,
        RETRY_BASE_MS * 2 ** Math.min(this.retryCount - 1, 5),
      );
      this.logger.warn('sse push failed, will retry', {
        event: 'sse-push-failed',
        retry: this.retryCount,
        delayMs: delay,
        url: target.pushUrl,
        ...logErrorContext(error),
      });
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.flush();
      }, delay);
    } finally {
      this.flushing = false;
      // flush 期间又有新消息进来：等防抖窗口结束后再推一批。
      if (this.pending.length > 0 && this.retryTimer === null) this.scheduleFlush();
    }
  }

  /**
   * 把待推队列整理成事件。核心逻辑：
   *   - 每个会话按 seq 排序后，用 recent_contact 的当前 watermark 算出真实跳变量；
   *   - 跳变量 > massThreshold → 一条 mass 事件（预览最新一条）；
   *   - 否则逐条 message 事件（跳过已推送过的旧 seq）。
   */
  private async buildEvents(): Promise<{
    events: SsePushEvent[];
    consumed: number;
    /** 成功推送后才提交的会话水位（lastSeq）更新。 */
    nextSeqs: Map<string, bigint>;
  }> {
    const consumed = this.pending.length;
    const rows = this.pending.slice(0, consumed);

    const convs = new Map<string, ConvGroup>();
    for (const row of rows) {
      const key = convKey(row);
      let group = convs.get(key);
      if (!group) {
        group = { kind: row.kind, rows: [] };
        convs.set(key, group);
      }
      group.rows.push(row);
    }

    // 会话当前 watermark（40003），用于识别「seq 一次性跳很大」的场景。
    const watermarks = new Map<string, bigint>();
    try {
      const list = await this.session.recentContacts.listSeqWatermarks();
      for (const r of list) {
        if (!r.targetUid) continue;
        watermarks.set(`${kindOfChatType(r.chatType)}:${r.targetUid}`, r.msgSeq);
      }
    } catch (error) {
      this.logger.warn('read seq watermarks failed, falling back to batch gap', {
        event: 'sse-push-watermark-failed',
        ...logErrorContext(error),
      });
    }

    const events: SsePushEvent[] = [];
    const nextSeqs = new Map<string, bigint>();
    for (const [key, group] of convs) {
      group.rows.sort((a, b) => compareSeq(a.msg, b.msg));
      const first = group.rows[0]!.msg;
      const last = group.rows[group.rows.length - 1]!.msg;
      const prevSeq = this.lastSeq.get(key) ?? first.msgSeq - 1n;
      const safePrev = prevSeq < 0n ? 0n : prevSeq;

      const watermark = watermarks.get(key);
      const toSeq = watermark !== undefined && watermark > last.msgSeq ? watermark : last.msgSeq;
      const gap = toSeq > safePrev ? toSeq - safePrev : 0n;

      if (gap > BigInt(this.opts.massThreshold)) {
        const preview = await this.previewLatest(group.kind, key, last);
        events.push({
          type: 'mass',
          chatType: group.kind,
          convId: key,
          fromSeq: (safePrev + 1n).toString(),
          toSeq: toSeq.toString(),
          count: Number(gap),
          preview,
        });
        nextSeqs.set(key, toSeq);
        continue;
      }

      let maxSeq = safePrev;
      for (const row of group.rows) {
        if (row.msg.msgSeq <= safePrev) continue;
        events.push(toMessageEvent(group.kind, row.msg));
        if (row.msg.msgSeq > maxSeq) maxSeq = row.msg.msgSeq;
      }
      if (maxSeq > safePrev) nextSeqs.set(key, maxSeq);
    }

    return { events, consumed, nextSeqs };
  }

  /** mass 事件里「最新一条」的预览：优先拉会话最新几行，取最后一条。 */
  private async previewLatest(
    kind: 'c2c' | 'group',
    convId: string,
    fallback: C2cMsg | GroupMsg,
  ): Promise<SseMessageEvent | null> {
    try {
      // listLatest 返回 newest-first（DESC by seq），所以最新一条是 msgs[0]。
      if (kind === 'group') {
        const msgs = await this.session.groupMsgs.listLatest(convId, 5);
        if (msgs.length > 0) return toMessageEvent('group', msgs[0]!);
      } else {
        const part = c2cPartition(this.session, convId);
        const msgs = await this.session.c2cMsgs.listLatest(part, 5);
        if (msgs.length > 0) return toMessageEvent('c2c', msgs[0]!);
      }
    } catch (error) {
      this.logger.warn('fetch latest preview failed, using batch tail', {
        event: 'sse-push-preview-failed',
        ...logErrorContext(error),
      });
    }
    return toMessageEvent(kind, fallback);
  }

  private clearTimers(): void {
    this.clearDebounce();
    this.clearRetry();
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

// ---- helpers ----

function convKey(row: PendingRow): string {
  if (row.kind === 'c2c') return `c2c:${(row.msg as C2cMsg).targetUid}`;
  return `group:${(row.msg as GroupMsg).targetGroupCode}`;
}

/** recent_contact 的 chatType 数值 -> 事件里的会话类型。 */
function kindOfChatType(chatType: number): 'c2c' | 'group' {
  return chatType === 2 ? 'group' : 'c2c';
}

function compareSeq(a: C2cMsg | GroupMsg, b: C2cMsg | GroupMsg): number {
  if (a.msgSeq !== b.msgSeq) return a.msgSeq < b.msgSeq ? -1 : 1;
  if (a.msgId !== b.msgId) return a.msgId < b.msgId ? -1 : 1;
  return 0;
}

function toMessageEvent(kind: 'c2c' | 'group', msg: C2cMsg | GroupMsg): SseMessageEvent {
  return {
    type: 'message',
    chatType: kind,
    convId: kind === 'c2c' ? (msg as C2cMsg).targetUid : (msg as GroupMsg).targetGroupCode,
    msgId: msg.msgId.toString(),
    msgSeq: msg.msgSeq.toString(),
    senderUid: msg.senderUid,
    senderUin: msg.senderUin.toString(),
    sendTime: msg.sendTime.toString(),
    text: summarizeElements(msg.elements),
  };
}

/** 「text」/「at」元素带正文；其余只给标签，和 tools/db_watch_listen.ts 一致。 */
function summarizeElements(elements: Element[]): string {
  if (elements.length === 0) return '(no elements)';
  const parts = elements.map((el) => {
    if (el.kind === 'text' || el.kind === 'at') return el.textContent;
    return `[${el.kind}]`;
  });
  return parts.join(' ');
}

/** 优先走 c2c 表 (40027=sortNo) 分区索引；解析不到 sortNo 时退回 uid 扫描。 */
function c2cPartition(session: AccountSession, uid: string): { sortNo: bigint } | { uid: string } {
  const sortNo = session.uidMap.sortNoByUid(uid);
  return sortNo === undefined ? { uid } : { sortNo };
}

/** 规范化推送地址：补协议、去尾部斜杠。空 / 非法输入返回 ''。 */
export function normalizeSsePushUrl(input: string): string {
  let url = input.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** 把事件 POST 到推送地址（Bearer 鉴权）。非 2xx 不算成功，由调用方重试。 */
export async function postSsePushEvents(
  target: SsePushTarget,
  events: SsePushEvent[],
  timeoutMs: number,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = target.accessToken.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload: SsePushPayload = { events };
  return fetch(target.pushUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** 测试连通性：向目标发一条 ping 事件。失败抛 Error（带可读原因）。 */
export async function testSsePushTarget(
  target: SsePushTarget,
  timeoutMs = 8_000,
): Promise<{ ok: true; latencyMs: number }> {
  const url = normalizeSsePushUrl(target.pushUrl);
  if (!url) throw new Error('推送地址无效');
  const t0 = Date.now();
  const res = await postSsePushEvents(
    { pushUrl: url, accessToken: target.accessToken },
    [
      {
        type: 'message',
        chatType: 'group',
        convId: 'ping',
        msgId: '0',
        msgSeq: '0',
        senderUid: '',
        senderUin: '',
        sendTime: String(Math.floor(Date.now() / 1000)),
        text: 'WeQ 连接测试 ping',
      },
    ],
    timeoutMs,
  );
  if (!res.ok) {
    const detail = res.status === 401 || res.status === 403 ? '（token 校验失败）' : '';
    throw new Error(`推送地址返回 HTTP ${res.status}${detail}`);
  }
  return { ok: true, latencyMs: Date.now() - t0 };
}