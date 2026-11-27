/**
 * GapHistoryService — 拉取聊天时间线中「缺失」的远端消息（按 seq 窗口）。
 *
 * 本地 DB 的 seq 跳号只是候选缺口，不证明服务端一定仍有对应消息。
 * 这里直接走 @weqbot/protocol 的原始 SSO 通道
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
import { measureMessageWork } from '@weq/db';
import type { NtHelperBinding } from '@weq/native';
import { decodeMessage, fetchC2cHistoryRaw, fetchGroupHistoryRaw } from '@weqbot/protocol';
import type { SpecialMessageKind } from '@weqbot/protocol/message-fallbacks';
import { toRenderElements, type RenderElement } from './msg_view';
import { RoamMsgCacheDb } from './roam_msg_cache';
import type { UnreadSequenceRange } from './unread_info';
import type { DeletedMsgStore } from './deleted_msgs';
import { mediaElementFromRenderElement, type MediaElement } from './media_url';
import { withRoamingRequest } from '../common/roaming_request_queue';
import { logErrorContext, getLogger } from '../common/logger';
import { existsSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeSsoHistoryWindow } from './sso_history_window';
import type { RecallInfo } from './msg';
import type { RecallArchive } from './recall_archive';
import { compareMessageOrder } from '@weq/codec';
import { mergeRoamingTimeline } from '../common/roaming_timeline';
import type { RecallMessageParams } from './group_moderation';

/** 单个物理请求的最大 seq 跨度，不是消息条数承诺。 */
const SERVER_MAX_WINDOW = 30;

const logger = getLogger().child({ scope: 'gap-history' });

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
  /** 同一条已确认的 WeQ 发送消息有了更完整的副本。 */
  sentFromWeq?: true;
  /** 当前正文来自 QQ 代理实时推送。 */
  livePush?: true;
  recall?: RecallInfo;
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

export interface SpecialMessageLookup {
  type: SpecialMessageKind;
  senderUid: string;
  senderUin: string;
  sendTime: string;
}

function hasSpecialElement(elements: RenderElement[], type: SpecialMessageKind): boolean {
  switch (type) {
    case 'emojiBounce':
      return elements.some((element) => element.type === 'emojiBounce');
    case 'pokeEmoji':
      return elements.some((element) => element.type === 'face' && element.data.subType === 5);
    case 'flashPhoto':
      return elements.some(
        (element) =>
          element.type === 'pic' &&
          element.data.isFlash === true &&
          element.data.fileToken?.startsWith('/'),
      );
  }
}

function projectSpecialMessage(
  message: GapFetchedMessage,
  lookup: SpecialMessageLookup,
): GapFetchedMessage | undefined {
  if (message.recall || (message.kind === 'c2c' && message.ntSeqVerified !== true)) return;
  const uidsKnown = Boolean(message.senderUid && lookup.senderUid);
  const uinsKnown = /^[1-9]\d*$/.test(message.senderUin) && /^[1-9]\d*$/.test(lookup.senderUin);
  if (
    (uidsKnown && message.senderUid !== lookup.senderUid) ||
    (uinsKnown && message.senderUin !== lookup.senderUin) ||
    (!uidsKnown && !uinsKnown && message.sendTime !== lookup.sendTime)
  )
    return;
  if (hasSpecialElement(message.elements, lookup.type)) return message;
  if (message.sourceFormat !== 'protocol' || !message.protocolRaw) return undefined;
  // 旧版本可能保存了完整协议包，同时在投影时丢掉了特殊元素。
  try {
    const decoded = decodeMessage(Buffer.from(message.protocolRaw, 'base64'));
    const elements = renderDecodedElements(decoded.elements);
    if (hasSpecialElement(elements, lookup.type)) return { ...message, elements };
  } catch {
    // 缓存里没有可用正文时走正常漫游请求。
  }
}

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
    private readonly deleted?: DeletedMsgStore,
    readonly recallArchive?: RecallArchive,
  ) {
    this.cache = new RoamMsgCacheDb(
      nt,
      cacheDbPath,
      (kind, conv) => this.deleted?.listHiddenIds(kind, conv) ?? [],
    );
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
    cursor?: { msgSeq: number; sendTime: number; msgId: string },
  ): Promise<GapFetchedMessage[]> {
    const rows = await measureMessageWork(this.session.msgDbPath, 'roamingCache', () =>
      this.cache.query(
        kind,
        conv,
        startSeq,
        endSeq,
        kind === 'c2c',
        limit,
        descending,
        false,
        cursor,
      ),
    );
    const archived = (
      (await this.recallArchive?.query(kind, conv, startSeq, endSeq, limit, descending, cursor)) ??
      []
    ).filter((row) => !this.deleted?.isHiddenCached(row));
    if (!archived.length) return rows;
    return mergeRoamingTimeline(kind, [], [...archived, ...rows], { descending, limit }).sort(
      compareMessageOrder,
    );
  }

  async latestSent(): Promise<GapFetchedMessage[]> {
    return (await this.cache.latestSent()).filter((row) => !this.deleted?.isHiddenCached(row));
  }

  unreadSentSequences(ranges: UnreadSequenceRange[]): Promise<Map<string, string[]>> {
    return this.cache.unreadSentSequences(this.session.selfUid, ranges);
  }

  /** 原文可能仅在 WeQ 发送缓存里；先读快照，只有服务端确认撤回后才落标记。 */
  async withSelfRecallProtection(
    params: RecallMessageParams,
    send: () => Promise<void>,
  ): Promise<GapFetchedMessage | undefined> {
    const sent = (await this.cache.sentMessages(params.kind, params.conv, params.sequence)).find(
      (row) =>
        row.senderUid === this.session.selfUid &&
        row.elements.length > 0 &&
        row.msgRandom === String(params.random) &&
        (params.kind === 'group' ||
          (row.clientSeq === String(params.clientSequence) &&
            row.sendTime === String(params.timestamp))),
    );
    await send();
    if (!sent) return;
    const recalled = {
      ...sent,
      recall: sent.recall ?? {
        revokeUid: sent.senderUid,
        sameSender: true,
        recallTs: Math.floor(Date.now() / 1000),
      },
    };
    try {
      await this.cache.store([recalled]);
      return recalled;
    } catch (error) {
      // 服务端已接受撤回，不能把本地存储故障冒充请求失败、诱导重复发送。
      logger.warn('撤回已成功，但发送缓存的防撤回标记保存失败', logErrorContext(error));
      return undefined;
    }
  }

  async cachedRecalls(kind?: 'c2c' | 'group', conv?: string): Promise<GapFetchedMessage[]> {
    const rows = existsSync(this.cache.dbPath)
      ? await this.cache.sentMessages(kind, conv, undefined, true)
      : [];
    const archived = (await this.recallArchive?.list(kind, conv)) ?? [];
    const unique = new Map(
      [...rows, ...archived].map((row) => [
        `${row.kind}:${row.conv}:${row.msgSeq}:${row.senderUid}`,
        row,
      ]),
    );
    return [...unique.values()].filter((row) => row.recall && !this.deleted?.isHiddenCached(row));
  }

  /** Batch coverage is committed only after this durable cache write succeeds. */
  async retainForBatch(messages: GapFetchedMessage[]): Promise<void> {
    for (let i = 0; i < messages.length; i += 80) await this.cache.store(messages.slice(i, i + 80));
  }

  async cachedForExport(
    kind: 'c2c' | 'group',
    conv: string,
    includeHidden = false,
  ): Promise<GapFetchedMessage[]> {
    const cached = await this.cache.allForExport(kind, conv);
    const archived = (await this.recallArchive?.list(kind, conv)) ?? [];
    const rows = mergeRoamingTimeline(kind, [], [...archived, ...cached]);
    return includeHidden ? rows : rows.filter((row) => !this.deleted?.isHiddenCached(row));
  }

  async cachedDeleted(kind: 'c2c' | 'group', conv: string, ids: readonly string[]) {
    const keys = ids.flatMap((id) => {
      const match = /^roaming:(?:(?:native|protocol):)?([1-9]\d*):(-?\d+)$/.exec(id);
      return match ? [[match[1]!, match[2]!] as const] : [];
    });
    const rows = await this.cache.allForExport(kind, conv, keys);
    const archived = (await this.recallArchive?.byKeys(kind, conv, keys)) ?? [];
    return mergeRoamingTimeline(kind, [], [...archived, ...rows]);
  }

  /** 仅枚举可见缓存会话，不联网；供即时分析目录发现缓存独有对象。 */
  cachedConversations() {
    return this.cache.listConversations();
  }
  hasCalendarCache(): boolean {
    return existsSync(this.cache.dbPath);
  }
  calendarConversations(kind: 'c2c' | 'group', convs: readonly string[]) {
    return this.cache.calendarConversations(kind, convs);
  }
  calendarPage(
    kind: 'c2c' | 'group',
    conv: string,
    limit: number,
    cursor?: { msgSeq: number; sendTime: number; msgId: string },
    timeRange?: { start: number; end: number },
  ) {
    return this.cache.query(
      kind,
      conv,
      1,
      Number.MAX_SAFE_INTEGER,
      kind === 'c2c',
      limit,
      false,
      false,
      cursor,
      true,
      timeRange,
    );
  }

  /** 删除入口需要读取精确缓存行，包括已隐藏记录。 */
  async cachedForDeletion(
    kind: 'c2c' | 'group',
    conv: string,
    seq: number,
  ): Promise<GapFetchedMessage[]> {
    const rows = await this.cache.query(kind, conv, seq, seq, kind === 'c2c', 2000, true, true);
    const archived = (await this.recallArchive?.query(kind, conv, seq, seq, 2000, true)) ?? [];
    return mergeRoamingTimeline(kind, [], [...archived, ...rows]);
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
  async findByMsgId(
    msgId: string,
    options?: { recalledOnly?: boolean },
  ): Promise<GapFetchedMessage | null> {
    if (!msgId) return null;
    try {
      const archived = await this.recallArchive?.find(msgId);
      return archived ?? (await this.cache.findByMsgId(msgId, options));
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
      specialMessage?: SpecialMessageLookup;
      cacheOnly?: boolean;
    } = {},
  ): Promise<GapFetchResult> {
    if (
      !Number.isSafeInteger(startSeq) ||
      !Number.isSafeInteger(endSeq) ||
      startSeq < 1 ||
      startSeq > endSeq ||
      (options.specialMessage !== undefined && startSeq !== endSeq) ||
      endSeq > 0xffffffff
    )
      return { ok: false, reason: 'error', networkRequested: false, message: 'SSO 历史窗口无效。' };
    const windowEnd = Math.min(endSeq, startSeq + SERVER_MAX_WINDOW - 1);
    const specialMessage = options.specialMessage;
    const readCache = async () => {
      if (!specialMessage) return this.cache.query(kind, conv, startSeq, windowEnd, kind === 'c2c');
      const candidates = await this.cache.matchingMessage(kind, conv, startSeq, (row) =>
        projectSpecialMessage(row, specialMessage),
      );
      if (candidates.length <= 1) return candidates;
      const exact = candidates.filter((row) => row.sendTime === specialMessage.sendTime);
      return exact.length === 1 ? exact : [];
    };
    const complete = (rows: GapFetchedMessage[]) =>
      new Set(rows.map((row) => row.msgSeq)).size === windowEnd - startSeq + 1;
    const nextStartSeq = windowEnd < endSeq ? windowEnd + 1 : null;
    let cached: GapFetchedMessage[] = [];
    try {
      cached = await readCache();
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
    if (options.cacheOnly)
      return {
        ok: true,
        messages: cached,
        nextStartSeq: null,
        fetched: 0,
        networkRequested: false,
      };
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
        cached = await readCache();
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
          this.deleted?.restoreFetched(decoded.messages);
          const observed = [
            ...decoded.messages.map((row) => Number(row.msgSeq)),
            ...decoded.observations.map((row) => row.msgSeq).filter((seq) => seq >= startSeq),
          ];
          return {
            cached: false as const,
            messages: await readCache(),
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
      // 这条路径以前完全不打日志：降级成功时前端/MCP 只会看到「这条缺口没补上」，
      // 排查时没有任何线索。现在至少留下窗口与原因。
      logger.warn('roaming gap window failed', {
        event: 'gap-window-failed',
        kind,
        conv,
        startSeq,
        endSeq: windowEnd,
        degraded: cached.length > 0 && !options.strictIdentity,
        cachedRows: cached.length,
        networkRequested,
        ...logErrorContext(error),
      });
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
