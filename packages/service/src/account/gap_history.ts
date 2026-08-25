/**
 * GapHistoryService — 拉取聊天时间线中「缺失」的远端消息（按 seq 窗口）。
 *
 * 本地 DB 的 seq 一旦跳号（详见 renderer 的 messageGap.ts），说明 QQ 服务端
 * 还有这些消息但从未同步到本机。这里直接走 @weq/protocol 的原始 SSO 通道
 * （SsoGetGroupMsg / SsoGetC2cMsg）按窗口拉取，再用 decodeMessage 把每条消息
 * 解成 codec 风格元素，最后统一提升成渲染视图（{ type, data }），让前端可以
 * 像普通消息一样完整渲染（头像 / 昵称 / 装扮 / 消息体）。
 *
 * 注意：服务端单次请求最多返回约 30 条，所以按 30 个 seq 一段分页拉取：
 * 第一页从缺口末端（最新）往回拉一段，之后每次把上一页返回的 nextEndSeq
 * 作为新的 endSeq 继续向更旧的方向推，直到缺口拉完或漫游中断。
 *
 * 拉到的消息会全部写入本机漫游缓存（RoamMsgCacheDb，weq 缓存目录下按账号
 * 一个库），下次遇到同一个缺口先查缓存：窗口全部命中就直接返回、不联网，
 * 部分命中则把缓存与本次新拉的合并后返回。
 */

import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import {
  decodeMessage,
  extractPath,
  fetchC2cHistoryRaw,
  fetchGroupHistoryRaw,
  type PathStep,
} from '@weq/protocol';
import { toRenderElements, type RenderElement } from './msg_view';
import { RoamMsgCacheDb } from './roam_msg_cache';

/** 服务端单次最多返回约 30 条（见 packages/protocol/tools/scan_msg_history.ts）。 */
const SERVER_MAX_WINDOW = 30;

/** 一条拉取到的远端消息，形状与主时间线的 ChatMsgWire 对齐。 */
export interface GapFetchedMessage {
  kind: 'c2c' | 'group';
  msgId: string;
  msgSeq: string;
  /** 会话 key：私聊为对方 uid，群聊为群号。 */
  conv: string;
  senderUid: string;
  senderUin: string;
  sendTime: string;
  /** 已提升为渲染视图（{ type, data }）的元素列表。 */
  elements: RenderElement[];
  /** 装扮（bubble/font/widget itemId），全部为 0 时省略。 */
  decoration?: { bubbleId: number; fontId: number; widgetId: number };
}

export type GapFetchResult =
  | {
      ok: true;
      messages: GapFetchedMessage[];
      /** 下一段（更旧）30-seq 窗口的结束 seq（含）；null = 缺口已拉完 / 漫游中断。 */
      nextEndSeq: number | null;
      /** 本次窗口实际拉到的条数。 */
      fetched: number;
    }
  | {
      ok: false;
      /** offline = 没有在线 QQ / 完全离线模式；error = 其它。 */
      reason: 'offline' | 'error';
      message: string;
    };

/**
 * 把 decodeMessage 产出的 codec 风格元素提升为渲染视图。
 *
 * 大部分元素可直接交给共享的 toRenderElements；但 reply 元素里的
 * origElements 已经被 liftReplyElem 提升成 codec 风格（带 kind），而
 * toRenderElements 的 reply 分支假设它们是原始 wire（会再 decodeElement 一次），
 * 直接复用会把引用内容打成 unknown，所以这里对 reply 单独处理。
 */
export function renderDecodedElements(elements: Record<string, unknown>[]): RenderElement[] {
  return elements.map((el) => {
    if (el.kind === 'reply') {
      const { kind: _kind, origElements, ...rest } = el;
      const data: Record<string, unknown> = { ...rest };
      if (Array.isArray(origElements)) {
        data.origElements = renderDecodedElements(origElements as Record<string, unknown>[]);
      }
      return { type: 'reply', data } as unknown as RenderElement;
    }
    return toRenderElements([el as never])[0] as RenderElement;
  });
}

function toGapMessage(
  kind: 'c2c' | 'group',
  conv: string,
  decoded: ReturnType<typeof decodeMessage>,
): GapFetchedMessage {
  const { head, sender, dress } = decoded;
  const decoration =
    dress.bubble || dress.font || dress.widget
      ? { bubbleId: dress.bubble, fontId: dress.font, widgetId: dress.widget }
      : undefined;
  return {
    kind,
    msgId: String(head.msgId),
    msgSeq: String(head.sequence),
    conv,
    senderUid: sender.uid,
    senderUin: String(sender.uin),
    sendTime: String(head.timestamp),
    elements: renderDecodedElements(decoded.elements),
    ...(decoration ? { decoration } : {}),
  };
}

/** 缓存命中 + 新拉取的消息按 seq 去重合并，保持升序（旧在上、新在下）。 */
function mergeBySeq(
  cached: GapFetchedMessage[],
  fetched: GapFetchedMessage[],
): GapFetchedMessage[] {
  const bySeq = new Map<number, GapFetchedMessage>();
  for (const message of cached) bySeq.set(Number(message.msgSeq), message);
  for (const message of fetched) bySeq.set(Number(message.msgSeq), message);
  return [...bySeq.values()].sort((a, b) => Number(a.msgSeq) - Number(b.msgSeq));
}

export class GapHistoryService {
  private readonly cache: RoamMsgCacheDb;

  constructor(
    private readonly nt: Pick<
      NtHelperBinding,
      'sendPacket' | 'executeSql' | 'executeSqlWrite' | 'closeDb'
    >,
    _session: AccountSession,
    private readonly resolvePid: () => number,
    /** 本账号漫游消息缓存库的绝对路径（weq 缓存目录 /roam-msg/<uin>.db）。 */
    cacheDbPath: string,
  ) {
    this.cache = new RoamMsgCacheDb(nt, cacheDbPath);
  }

  /**
   * 读本机漫游缓存中 [startSeq, endSeq] 的缺失消息（按 seq 升序）。
   * 前端打开缺口弹窗前先探一下缓存：命中就不强制要求 QQ 在线。
   */
  async cached(
    kind: 'c2c' | 'group',
    conv: string,
    startSeq: number,
    endSeq: number,
  ): Promise<GapFetchedMessage[]> {
    if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq) || startSeq > endSeq) {
      return [];
    }
    try {
      return await this.cache.query(kind, conv, startSeq, endSeq);
    } catch (e) {
      console.error('[GapHistory] failed to read roam cache:', e);
      return [];
    }
  }

  /**
   * 拉取缺口 [startSeq, endSeq] 中「以 endSeq 结尾」的一段（最多 30 个 seq）。
   *
   * 分页契约：调用方第一次传整个缺口的末端（占位条下一条消息的 seq - 1），
   * 之后把返回的 nextEndSeq 原样作为下一次的 endSeq 传入，每次向更旧的方向
   * 推一个 30-seq 窗口，直到 nextEndSeq 为 null。返回按 seq 升序排好。
   *
   * 窗口返回零条 = 漫游未覆盖（或消息已过期）。QQ 漫游覆盖的是从最新向前的
   * 连续一段，更旧的窗口必然也是空的，所以此时直接收尾（nextEndSeq = null），
   * 由调用方决定首屏空窗如何提示。
   */
  async fetch(
    kind: 'c2c' | 'group',
    conv: string,
    startSeq: number,
    endSeq: number,
  ): Promise<GapFetchResult> {
    if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq) || startSeq > endSeq) {
      return { ok: false, reason: 'error', message: `seq 窗口非法: ${startSeq}-${endSeq}` };
    }
    if (endSeq > 0xffffffff) {
      return { ok: false, reason: 'error', message: 'seq 超出 uint32 范围，无法拉取' };
    }

    // 本次要拉的服务端窗口：缺口末端最多 30 个 seq。
    const windowStart = Math.max(startSeq, endSeq - SERVER_MAX_WINDOW + 1);
    const windowWidth = endSeq - windowStart + 1;

    // 1) 先查本机漫游缓存：窗口全部命中就直接返回，不联网（QQ 不在线也能看）。
    let cached: GapFetchedMessage[] = [];
    try {
      cached = await this.cache.query(kind, conv, windowStart, endSeq);
    } catch (e) {
      console.error('[GapHistory] failed to read roam cache:', e);
    }
    if (cached.length === windowWidth) {
      const hasOlder = windowStart > startSeq;
      return {
        ok: true,
        messages: cached,
        nextEndSeq: hasOlder ? windowStart - 1 : null,
        fetched: 0,
      };
    }

    let pid: number;
    try {
      pid = this.resolvePid();
    } catch {
      // 离线时至少把已缓存的部分展示出来。
      return cached.length > 0
        ? { ok: true, messages: cached, nextEndSeq: null, fetched: 0 }
        : { ok: false, reason: 'offline', message: 'QQ 未在线，无法拉取缺失消息' };
    }

    const rawBySeq = new Map<number, Uint8Array>();
    try {
      const res =
        kind === 'group'
          ? await fetchGroupHistoryRaw(this.nt, pid, {
              groupUin: Number(conv),
              startSeq: windowStart,
              endSeq,
            })
          : await fetchC2cHistoryRaw(this.nt, pid, {
              friendUid: conv,
              startSeq: windowStart,
              endSeq,
            });

      const stepsFor = (index: number): PathStep[] =>
        kind === 'group' ? [{ tag: 3 }, { tag: 6, index }] : [{ tag: 7, index }];

      for (let index = 0; index < res.messages.length; index += 1) {
        const bytes = extractPath(res.rawResponse, stepsFor(index));
        if (!bytes) continue;
        const decoded = decodeMessage(bytes);
        rawBySeq.set(decoded.head.sequence, bytes);
      }
    } catch (e) {
      if (cached.length > 0) {
        return { ok: true, messages: cached, nextEndSeq: null, fetched: 0 };
      }
      return {
        ok: false,
        reason: 'error',
        message: e instanceof Error ? e.message : String(e),
      };
    }

    if (rawBySeq.size === 0) {
      // 漫游未覆盖（或消息已过期）：已缓存的部分照常展示。
      return cached.length > 0
        ? { ok: true, messages: cached, nextEndSeq: null, fetched: 0 }
        : { ok: true, messages: [], nextEndSeq: null, fetched: 0 };
    }

    const seqs = [...rawBySeq.keys()].sort((a, b) => a - b);
    const fetchedMessages = seqs.map((seq) =>
      toGapMessage(kind, conv, decodeMessage(rawBySeq.get(seq)!)),
    );
    // 2) 拉到的消息全部写入本机漫游缓存（best-effort，写失败不影响返回）。
    try {
      await this.cache.store(fetchedMessages);
    } catch (e) {
      console.error('[GapHistory] failed to store roam cache:', e);
    }
    // 3) 缓存命中 + 新拉取的合并（去重、升序）。
    const messages = mergeBySeq(cached, fetchedMessages);
    // 窗口下界还没到缺口的 startSeq = 更旧的 seq 还在缺口内，继续分页；
    // 反之这一页已经把缺口最旧的一端盖住了。
    const hasOlder = windowStart > startSeq;
    return {
      ok: true,
      messages,
      nextEndSeq: hasOlder ? endSeq - SERVER_MAX_WINDOW : null,
      fetched: fetchedMessages.length,
    };
  }
}
