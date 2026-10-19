/**
 * GapHistoryService — 拉取聊天时间线中「缺失」的远端消息（按 seq 窗口）。
 *
 * 本地 DB 的 seq 跳号只是候选缺口，不证明服务端一定仍有对应消息。
 * 这里直接走 @weq/protocol 的原始 SSO 通道
 * （SsoGetGroupMsg / SsoGetC2cMsg）按窗口拉取，再用 decodeMessage 把每条消息
 * 解成 codec 风格元素，最后统一提升成渲染视图（{ type, data }），让前端可以
 * 像普通消息一样完整渲染（头像 / 昵称 / 装扮 / 消息体）。
 *
 * 每次请求覆盖最多 30 个 seq，不把序号跨度当成消息条数：
 * 第一页从缺口起始（最旧）往后拉一段，之后每次把上一页返回的 nextStartSeq
 * 作为新的 startSeq 继续向更新的方向推，直到缺口拉完或漫游中断。
 *
 * 拉到的消息会全部写入本机漫游缓存（RoamMsgCacheDb，weq 缓存目录下按账号
 * 一个库），下次遇到同一个缺口先查缓存：窗口全部命中就直接返回、不联网，
 * 部分命中则把缓存与本次新拉的合并后返回。
 */

import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { type decodeMessage, fetchC2cHistoryRaw, fetchGroupHistoryRaw } from '@weq/protocol';
import { toRenderElements, type RenderElement } from './msg_view';
import { RoamMsgCacheDb } from './roam_msg_cache';
import { mediaElementFromRenderElement, type MediaElement } from './media_url';
import { withRoamingRequest } from '../common/roaming_request_queue';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeSsoHistoryWindow } from './sso_history_window';

/** 单个物理请求的最大 seq 跨度，不是消息条数承诺。 */
const SERVER_MAX_WINDOW = 30;

/** 一条拉取到的远端消息，形状与主时间线的 ChatMsgWire 对齐。 */
export interface GapFetchedMessage {
  sourceFormat?: 'native' | 'protocol';
  protocolRaw?: string;
  nativeRaw?: Record<string, unknown>;
  kind: 'c2c' | 'group';
  msgId: string;
  msgSeq: string;
  msgRandom?: string;
  clientSeq?: string;
  localSent?: boolean;
  /** True only when this row was indexed using a server NT conversation sequence. */
  ntSeqVerified?: boolean;
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
      /** 下一段更新窗口的起始 seq；null 只表示本轮区间已检查，不保证缺口补齐。 */
      nextStartSeq: number | null;
      /** 本次窗口实际拉到的条数。 */
      fetched: number;
      networkRequested?: boolean;
      networkDurationMs?: number;
      networkError?: string;
      examinedStart?: number;
      unresolvedRecords?: number;
    }
  | {
      ok: false;
      /** offline = 没有在线 QQ / 完全离线模式；error = 其它。 */
      reason: 'offline' | 'error';
      unknown?: boolean;
      message: string;
      networkRequested?: boolean;
      networkDurationMs?: number;
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

export function toGapMessage(
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
    ...(kind === 'c2c'
      ? {
          msgRandom: String(head.msgId),
          ntSeqVerified: (head.ntMsgSeq ?? 0) > 0,
          ...(head.clientSequence ? { clientSeq: String(head.clientSequence) } : {}),
        }
      : {}),
    conv,
    senderUid: sender.uid,
    senderUin: String(sender.uin),
    sendTime: String(head.timestamp),
    elements: renderDecodedElements(decoded.elements),
    ...(decoration ? { decoration } : {}),
  };
}

export function assertRoamingPageIdentity(
  kind: 'group' | 'c2c',
  conv: string,
  selfUin: string,
  decoded: ReturnType<typeof decodeMessage>,
  start: number,
  end: number,
): void {
  const peerMatches =
    kind === 'group'
      ? String(decoded.session.uin) === conv
      : (decoded.sender.uid === conv && String(decoded.session.uin) === selfUin) ||
        (decoded.session.uid === conv && String(decoded.sender.uin) === selfUin);
  if (
    !peerMatches ||
    !Number.isSafeInteger(decoded.head.sequence) ||
    decoded.head.sequence < start ||
    decoded.head.sequence > end ||
    !Number.isSafeInteger(decoded.head.timestamp) ||
    decoded.head.timestamp <= 0 ||
    (kind === 'c2c' &&
      (!(decoded.head.ntMsgSeq && decoded.head.ntMsgSeq > 0) ||
        decoded.head.sequence !== decoded.head.ntMsgSeq))
  )
    throw new Error('漫游响应的账号、会话或 NT 序号不一致，未提交本窗覆盖。');
}

export class GapHistoryService {
  private readonly cache: RoamMsgCacheDb;

  constructor(
    private readonly nt: Pick<
      NtHelperBinding,
      'sendPacket' | 'executeSql' | 'executeSqlWrite' | 'closeDb'
    >,
    private readonly session: AccountSession,
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
      return await this.cache.query(kind, conv, startSeq, endSeq, kind === 'c2c');
    } catch (e) {
      console.error('[GapHistory] failed to read roam cache:', e);
      return [];
    }
  }

  /** Bounded, offline-only timeline page; private-chat rows need verified NT numbering. */
  async cachedTimeline(
    kind: 'c2c' | 'group',
    conv: string,
    startSeq: number,
    endSeq: number,
    limit: number,
    descending: boolean,
  ): Promise<GapFetchedMessage[]> {
    return this.cache.query(kind, conv, startSeq, endSeq, kind === 'c2c', limit, descending);
  }

  /** Batch coverage is committed only after this durable cache write succeeds. */
  async retainForBatch(messages: GapFetchedMessage[]): Promise<void> {
    for (let i = 0; i < messages.length; i += 80) await this.cache.store(messages.slice(i, i + 80));
  }

  async cachedForExport(kind: 'c2c' | 'group', conv: string): Promise<GapFetchedMessage[]> {
    return this.cache.allForExport(kind, conv);
  }

  resolveReplySeq(
    conv: string,
    clientSeq: string,
    senderUin?: string,
    sendTime?: string,
  ): Promise<string | null> {
    return this.cache.resolveReplySeq(conv, clientSeq, senderUin, sendTime);
  }

  /** 按 msgId 找一条已缓存的缺失消息（媒体补全 / 文件下载回查用）。 */
  async findByMsgId(msgId: string): Promise<GapFetchedMessage | null> {
    if (!msgId) return null;
    try {
      return await this.cache.findByMsgId(msgId);
    } catch (e) {
      console.error('[GapHistory] failed to find cached message by msgId:', e);
      return null;
    }
  }

  /**
   * 在漫游缓存里按 msgId 定位视频 / 文件 / 语音元素，返回元素 + 会话类型。
   *
   * 缺失消息弹窗拉到的漫游消息不在本地 msg 表（getRawElements 查不到），媒体协议
   * 的 OIDB 补全和 `file:download` 需要回退到这里拿元素。`token` 只用于同一消息里
   * 有多个同类媒体时消歧，其余情况取第一个。
   */
  async findMediaElement(
    msgId: string,
    kind: 'video' | 'file' | 'ptt',
    token: string,
  ): Promise<{ element: MediaElement; conv: 'c2c' | 'group' } | null> {
    const gap = await this.findByMsgId(msgId);
    if (!gap) return null;
    // 缺失消息解码只产出 codec 风格的 'video' / 'file'（没有 bubbleVideo）。
    const matches = gap.elements.filter((el) => el.type === kind);
    const el =
      (token
        ? matches.find((m) => (m.data as { fileToken?: unknown } | undefined)?.fileToken === token)
        : undefined) ?? matches[0];
    if (!el) return null;
    return { element: mediaElementFromRenderElement(el), conv: gap.kind };
  }

  /**
   * 拉取缺口 [startSeq, endSeq] 中「以 startSeq 开头」的一段（最多 30 个 seq）。
   *
   * 分页契约：调用方第一次传整个缺口的起始（占位条上一条消息的 seq + 1），
   * 之后把返回的 nextStartSeq 原样作为下一次的 startSeq 传入，每次向更新的
   * 方向推一个 30-seq 窗口，直到 nextStartSeq 为 null。返回按 seq 升序排好。
   *
   * 窗口返回零条不代表缺口拉完：QQ 漫游覆盖的是从最新向前的连续一段，缺口
   * 最旧的一端可能不在覆盖范围内，所以空窗继续向更新方向推进；只有
   * nextStartSeq 为 null（整个缺口已遍历完）才收尾，由调用方决定首屏空窗
   * 如何提示。
   */
  async fetch(
    kind: 'c2c' | 'group',
    conv: string,
    startSeq: number,
    endSeq: number,
    options: {
      signal?: AbortSignal;
      intervalMs?: number;
      strictIdentity?: boolean;
      beforeRequest?: () => void;
    } = {},
  ): Promise<GapFetchResult> {
    if (
      !Number.isSafeInteger(startSeq) ||
      !Number.isSafeInteger(endSeq) ||
      startSeq < 1 ||
      startSeq > endSeq ||
      endSeq > 0xffffffff
    )
      return { ok: false, reason: 'error', networkRequested: false, message: 'SSO 历史窗口无效。' };
    const windowEnd = Math.min(endSeq, startSeq + SERVER_MAX_WINDOW - 1);
    const complete = (rows: GapFetchedMessage[]) =>
      new Set(rows.map((row) => row.msgSeq)).size === windowEnd - startSeq + 1;
    const nextStartSeq = windowEnd < endSeq ? windowEnd + 1 : null;
    let cached: GapFetchedMessage[] = [];
    try {
      cached = await this.cache.query(kind, conv, startSeq, windowEnd, kind === 'c2c');
    } catch (error) {
      return {
        ok: false,
        reason: 'error',
        networkRequested: false,
        message: error instanceof Error ? error.message : '漫游缓存读取失败。',
      };
    }
    if (complete(cached))
      return { ok: true, messages: cached, nextStartSeq, fetched: 0, networkRequested: false };
    let pid: number;
    try {
      pid = this.resolvePid();
    } catch {
      return cached.length > 0 && !options.strictIdentity
        ? { ok: true, messages: cached, nextStartSeq: null, fetched: 0, networkRequested: false }
        : {
            ok: false,
            reason: 'offline',
            message: 'QQ 未在线，无法拉取缺失消息',
            networkRequested: false,
          };
    }
    let networkRequested = false;
    let admissionFailed = false;
    let networkDurationMs = 0;
    try {
      const result = await withRoamingRequest(async () => {
        cached = await this.cache.query(kind, conv, startSeq, windowEnd, kind === 'c2c');
        if (complete(cached)) return { cached: true as const };
        options.signal?.throwIfAborted();
        try {
          pid = this.resolvePid();
        } catch (error) {
          admissionFailed = true;
          throw error;
        }
        const space = statfsSync(dirname(this.cache.dbPath));
        if (space.bavail * space.bsize < 1024 ** 3)
          throw Error('漫游缓存卷可用空间不足 1 GiB，未派发请求。');
        options.beforeRequest?.();
        networkRequested = true;
        const started = Date.now();
        let received = false;
        try {
          const response =
            kind === 'group'
              ? await fetchGroupHistoryRaw(this.nt, pid, {
                  groupUin: Number(conv),
                  startSeq,
                  endSeq: windowEnd,
                })
              : await fetchC2cHistoryRaw(this.nt, pid, {
                  friendUid: conv,
                  startSeq,
                  endSeq: windowEnd,
                });
          networkDurationMs = Date.now() - started;
          received = true;
          if (this.resolvePid() !== pid) throw Error('QQ 会话已变化，未接受在途 SSO 响应。');
          const decoded = decodeSsoHistoryWindow(
            response,
            { kind, conv, name: conv },
            this.session.context.uin,
            { start: startSeq, end: windowEnd },
          );
          // 全窗核验并持久化后，调用方才能提交覆盖和断点。
          if (decoded.observations.length)
            await this.cache.storeProtocolObservations(decoded.observations);
          await this.cache.store(decoded.messages);
          const observed = [
            ...decoded.messages.map((row) => Number(row.msgSeq)),
            ...decoded.observations.map((row) => row.msgSeq),
          ];
          return {
            cached: false as const,
            messages: await this.cache.query(kind, conv, startSeq, windowEnd, kind === 'c2c'),
            fetched: decoded.messages.length,
            unresolvedRecords: decoded.observations.length,
            examinedStart: observed.length ? Math.min(...observed) : startSeq,
          };
        } finally {
          if (!received) networkDurationMs = Date.now() - started;
        }
      }, options);
      if (result.cached)
        return { ok: true, messages: cached, nextStartSeq, fetched: 0, networkRequested: false };
      return {
        ok: true,
        messages: result.messages,
        nextStartSeq,
        fetched: result.fetched,
        unresolvedRecords: result.unresolvedRecords,
        examinedStart: result.examinedStart,
        networkRequested: true,
        networkDurationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cached.length > 0 && !options.strictIdentity)
        return {
          ok: true,
          messages: cached,
          nextStartSeq: null,
          fetched: 0,
          networkRequested,
          networkDurationMs,
          networkError: message,
        };
      return {
        ok: false,
        reason: admissionFailed ? 'offline' : 'error',
        message,
        networkRequested,
        networkDurationMs,
        unknown: networkRequested,
      };
    }
  }
}
