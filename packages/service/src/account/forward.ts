/**
 * ForwardMsgService — fetch the merged-forward / quote-reply cache (40900) for
 * one message, by msgId. Group and c2c are separate methods because they hit
 * different tables (group_msg_table / c2c_msg_table).
 *
 * Returns the raw repeated `MsgCacheRecord[]` from tag 40900 — each record a
 * full cached message snapshot, possibly nesting its own 40900 list (deep
 * forwards). Callers serialize at the IPC/JSON boundary (bigint + bytes).
 *
 * When the 40900 cache is empty (gap messages pulled by seq never live in the
 * local DB), `fetchRemote` falls back to the protocol's SsoRecvLongMsg
 * (`fetchForwardRaw`) to pull the merged-forward chain from QQ servers by
 * resId. An online QQ is required, enforced by resolvePid.
 */

import type { AccountSession } from '@weq/account';
import type { MsgCacheRecord } from '@weq/codec';
import type { NtHelperBinding } from '@weq/native';
import { decodeMessage, encode, fetchForwardRaw, PUSH_MSG_BODY } from '@weq/protocol';
import { renderDecodedElements } from './gap_history';
import type { RenderElement } from './msg_view';

/** One forwarded record pulled from QQ servers, in the renderer's wire shape. */
export interface FetchedForwardRecord {
  msgId: string;
  msgSeq?: string;
  msgType?: number;
  senderUid?: string;
  senderUin?: string;
  sendTime?: string;
  sendNick?: string;
  elements: RenderElement[];
  decoration?: { bubbleId: number; fontId: number; widgetId: number };
}

export class ForwardMsgService {
  constructor(
    private readonly session: AccountSession,
    private readonly nt: Pick<NtHelperBinding, 'sendPacket'>,
    private readonly resolvePid: () => number,
  ) {}

  /** Forward/reply cache for a c2c message. */
  getC2cForward(msgId: bigint): Promise<MsgCacheRecord[]> {
    return this.session.forwardMsgs.listC2cForward(msgId);
  }

  /** Forward/reply cache for a group message. */
  getGroupForward(msgId: bigint): Promise<MsgCacheRecord[]> {
    return this.session.forwardMsgs.listGroupForward(msgId);
  }

  /**
   * Fetch a merged-forward chain by resId from QQ servers when the local 40900
   * cache is empty. resolvePid throws when QQ is offline; callers (IPC layer)
   * additionally guard against "completely offline mode". The self long uid is
   * resolved from the resident uid map, falling back to profile info.
   */
  async fetchRemote(resId: string): Promise<FetchedForwardRecord[]> {
    const selfUid =
      this.session.uidMap.uidByUin(BigInt(this.session.context.uin)) ??
      (await this.session.profileInfo.getSelfUid());
    if (!selfUid) {
      throw new Error('self uid unavailable, cannot fetch merged forward');
    }
    const pid = this.resolvePid();
    const res = await fetchForwardRaw(this.nt, pid, { selfUid, resId });
    if (res.error) {
      throw new Error(`fetch merged forward failed: ${res.error}`);
    }
    return res.messages.map(toFetchedForwardRecord);
  }
}

/** Lift one SsoRecvLongMsg PushMsgBody into a forward-window renderable record. */
function toFetchedForwardRecord(raw: Record<string, unknown>): FetchedForwardRecord {
  // The decoder eats raw bytes: the schema round-trip (decode -> encode) keeps
  // exactly the fields decodeMessage needs (head / sender / richText.elems).
  const bytes = encode(PUSH_MSG_BODY, raw);
  const decoded = decodeMessage(bytes);
  const { head, sender, dress } = decoded;
  const grp = (
    raw.responseHead as { grp?: { memberName?: string; memberCard?: string } } | undefined
  )?.grp;
  const sendNick = grp?.memberName || grp?.memberCard || '';
  const decoration =
    dress.bubble || dress.font || dress.widget
      ? { bubbleId: dress.bubble, fontId: dress.font, widgetId: dress.widget }
      : undefined;
  return {
    msgId: String(head.msgId),
    msgSeq: String(head.sequence),
    msgType: head.msgType,
    senderUid: sender.uid,
    senderUin: String(sender.uin),
    sendTime: String(head.timestamp),
    ...(sendNick ? { sendNick } : {}),
    elements: renderDecodedElements(decoded.elements),
    ...(decoration ? { decoration } : {}),
  };
}
