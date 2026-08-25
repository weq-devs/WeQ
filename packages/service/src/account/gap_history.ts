/**
 * GapHistoryService — 拉取聊天时间线中「缺失」的远端消息（按 seq 窗口）。
 *
 * 本地 DB 的 seq 一旦跳号（详见 renderer 的 messageGap.ts），说明 QQ 服务端
 * 还有这些消息但从未同步到本机。这里直接走 @weq/protocol 的原始 SSO 通道
 * （SsoGetGroupMsg / SsoGetC2cMsg）按窗口拉取，再用 decodeMessage 把每条消息
 * 解成 codec 风格元素，最后统一提升成渲染视图（{ type, data }），让前端可以
 * 像普通消息一样完整渲染（头像 / 昵称 / 装扮 / 消息体）。
 *
 * 注意：服务端单次请求最多返回约 30 条，所以窗口按 30 分段、从窗口末尾
 * （最新）向前拉取，再按 msgId 去重合并。
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

/** 服务端单次最多返回约 30 条（见 packages/protocol/tools/scan_msg_history.ts）。 */
const SERVER_MAX_WINDOW = 30;
/** 单次点击最多拉取的条数；缺口超过时取窗口最新的一段，避免请求风暴。 */
const MAX_GAP_MESSAGES = 500;
/** 分段请求数上限：缺口再大也只扫最近的 100×30 = 3000 个 seq。 */
const MAX_GAP_CHUNKS = 100;

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
      requested: number;
      fetched: number;
      /** 缺口超过拉取上限（500 条 / 3000 个 seq），只拉到了最新的一段。 */
      truncated: boolean;
    }
  | {
      ok: false;
      /** offline = 没有在线 QQ / 完全离线模式；no-messages = 拉取返回零条；error = 其它。 */
      reason: 'offline' | 'no-messages' | 'error';
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
function renderDecodedElements(elements: Record<string, unknown>[]): RenderElement[] {
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

export class GapHistoryService {
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendPacket'>,
    _session: AccountSession,
    private readonly resolvePid: () => number,
  ) {}

  /**
   * 按 [startSeq, endSeq] 窗口拉取缺失的远端消息（含端点）。
   *
   * 窗口从最新端向前按 SERVER_MAX_WINDOW 分段请求；任一分段返回零条即停止
   * （QQ 漫游覆盖的是从最新向前的连续一段，更旧的窗口必然也是空的）。
   * 返回按 seq 升序排好。
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

    let pid: number;
    try {
      pid = this.resolvePid();
    } catch {
      return { ok: false, reason: 'offline', message: 'QQ 未在线，无法拉取缺失消息' };
    }

    const rawBySeq = new Map<number, Uint8Array>();
    let truncated = false;
    let chunks = 0;
    try {
      for (
        let end = endSeq;
        end >= startSeq && rawBySeq.size < MAX_GAP_MESSAGES && chunks < MAX_GAP_CHUNKS;
        end -= SERVER_MAX_WINDOW
      ) {
        chunks += 1;
        const start = Math.max(startSeq, end - SERVER_MAX_WINDOW + 1);
        const res =
          kind === 'group'
            ? await fetchGroupHistoryRaw(this.nt, pid, {
                groupUin: Number(conv),
                startSeq: start,
                endSeq: end,
              })
            : await fetchC2cHistoryRaw(this.nt, pid, {
                friendUid: conv,
                startSeq: start,
                endSeq: end,
              });

        const stepsFor = (index: number): PathStep[] =>
          kind === 'group' ? [{ tag: 3 }, { tag: 6, index }] : [{ tag: 7, index }];

        let filled = 0;
        for (let index = 0; index < res.messages.length; index += 1) {
          const bytes = extractPath(res.rawResponse, stepsFor(index));
          if (!bytes) continue;
          const decoded = decodeMessage(bytes);
          rawBySeq.set(decoded.head.sequence, bytes);
          filled += 1;
        }
        // 任一分段返回零条即停止：QQ 漫游覆盖的是从最新向前的连续一段，
        // 更旧的窗口必然也是空的，没必要继续发请求。
        if (filled === 0) break;
      }
    } catch (e) {
      return {
        ok: false,
        reason: 'error',
        message: e instanceof Error ? e.message : String(e),
      };
    }

    // 循环因条数 / 请求数上限提前退出 = 缺口没有拉全。
    truncated = rawBySeq.size >= MAX_GAP_MESSAGES || chunks >= MAX_GAP_CHUNKS;

    if (rawBySeq.size === 0) {
      return {
        ok: false,
        reason: 'no-messages',
        message: '拉取失败：未开启消息漫游或者消息已过期',
      };
    }

    const seqs = [...rawBySeq.keys()].sort((a, b) => a - b);
    const messages = seqs.map((seq) => toGapMessage(kind, conv, decodeMessage(rawBySeq.get(seq)!)));
    return {
      ok: true,
      messages,
      requested: endSeq - startSeq + 1,
      fetched: messages.length,
      truncated,
    };
  }
}
