/**
 * ForwardMsgService — fetch the merged-forward / quote-reply cache (40900) for
 * one message, by msgId. Group and c2c are separate methods because they hit
 * different tables (group_msg_table / c2c_msg_table).
 *
 * Returns the repeated `MsgCacheRecord[]` from tag 40900 — each record a
 * full cached message snapshot, possibly nesting its own 40900 list (deep
 * forwards), with local sender names filled in. Callers serialize at the
 * IPC/JSON boundary (bigint + bytes).
 *
 * When the 40900 cache is empty (gap messages pulled by seq never live in the
 * local DB), `fetchRemote` falls back to the protocol's SsoRecvLongMsg
 * (`fetchForwardRaw`) to pull the merged-forward chain from QQ servers by
 * resId. An online QQ is required, enforced by resolvePid.
 */

import type { AccountSession } from '@weq/account';
import type { MsgCacheRecord } from '@weq/codec';
import type { UserProfile } from '@weq/db';
import type { NtHelperBinding } from '@weq/native';
import { decodeMessage, encode, fetchForwardRaw, PUSH_MSG_BODY } from '@weq/protocol';
import { renderDecodedElements } from './gap_history';
import type { RenderElement } from './msg_view';
import { mediaElementFromRenderElement, type MediaElement } from './media_url';

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
  private readonly fetchedMedia = new Map<string, Map<string, MediaElement>>();

  constructor(
    private readonly session: AccountSession,
    private readonly nt: Pick<NtHelperBinding, 'sendPacket'>,
    private readonly resolvePid: () => number,
  ) {}

  /** Forward/reply cache for a c2c message. */
  async getC2cForward(msgId: bigint): Promise<MsgCacheRecord[]> {
    const records = await this.session.forwardMsgs.listC2cForward(msgId);
    await this.resolveSenders(records);
    return records;
  }

  /** Forward/reply cache for a group message. */
  async getGroupForward(msgId: bigint): Promise<MsgCacheRecord[]> {
    const records = await this.session.forwardMsgs.listGroupForward(msgId);
    await this.resolveSenders(records);
    return records;
  }

  /**
   * Fetch a merged-forward chain by resId from QQ servers when the local 40900
   * cache is empty. resolvePid throws when QQ is offline; callers (IPC layer)
   * additionally guard against "completely offline mode". The self long uid
   * comes from the session (resolved at open — the uid directory never has the
   * owner's row, see `AccountSession.selfUid`).
   */
  async fetchRemote(resId: string): Promise<FetchedForwardRecord[]> {
    const selfUid = this.session.selfUid;
    if (!selfUid) {
      throw new Error('self uid unavailable, cannot fetch merged forward');
    }
    const pid = this.resolvePid();
    const res = await fetchForwardRaw(this.nt, pid, { selfUid, resId });
    if (res.error) {
      throw new Error(`fetch merged forward failed: ${res.error}`);
    }
    const records = res.messages.map(toFetchedForwardRecord);
    await this.resolveSenders(records);
    const media = new Map<string, MediaElement>();
    for (const row of records) {
      for (const element of row.elements) {
        if (element.type !== 'file' && element.type !== 'video' && element.type !== 'ptt') continue;
        const token = element.data.fileToken;
        if (token)
          media.set(
            JSON.stringify([row.msgId, element.type, token]),
            mediaElementFromRenderElement(element),
          );
      }
    }
    this.fetchedMedia.delete(resId);
    this.fetchedMedia.set(resId, media);
    if (this.fetchedMedia.size > 8)
      this.fetchedMedia.delete(this.fetchedMedia.keys().next().value!);
    return records;
  }

  /** 读取刚打开的在线转发中的媒体引用，不拿子消息 ID 去查普通会话。 */
  getFetchedMedia(
    resId: string,
    msgId: string,
    kind: string,
    token: string,
  ): MediaElement | undefined {
    return this.fetchedMedia.get(resId)?.get(JSON.stringify([msgId, kind, token]));
  }

  /** 转发快照常常没有昵称；本地资料优先，缺项仍保留快照，不为显示名称联网。 */
  private async resolveSenders(
    records: Array<MsgCacheRecord | FetchedForwardRecord>,
  ): Promise<void> {
    const senders: Array<MsgCacheRecord | FetchedForwardRecord> = [];
    const collect = (rows: typeof records) => {
      for (const row of rows) {
        senders.push(row);
        if ('subMsgs' in row && Array.isArray(row.subMsgs))
          collect(row.subMsgs as MsgCacheRecord[]);
      }
    };
    collect(records);
    const uinOf = (row: (typeof records)[number]) => {
      const value = String(row.senderUin ?? '');
      return /^[1-9]\d*$/.test(value) ? value : '';
    };
    const uidOf = (row: (typeof records)[number]) => {
      if (row.senderUid && /^u_[A-Za-z0-9_-]+$/.test(row.senderUid)) return row.senderUid;
      const uin = uinOf(row);
      return (uin ? this.session.uidMap.uidByUin(BigInt(uin)) : '') || '';
    };
    const uids = [...new Set(senders.map(uidOf).filter(Boolean))];
    const byUid = new Map<string, UserProfile>();
    const byUin = new Map<string, UserProfile>();
    const remember = (profile: UserProfile) => {
      byUid.set(profile.uid, profile);
      if (profile.uin > 0n) byUin.set(String(profile.uin), profile);
    };
    for (let offset = 0; offset < uids.length; offset += 200) {
      try {
        for (const profile of await this.session.profileInfo.profilesByUids(
          uids.slice(offset, offset + 200),
        ))
          remember(profile);
      } catch {
        /* 资料缺失不阻断正文。 */
      }
    }
    const missingUins = new Set(
      senders
        .filter((row) => !byUid.has(uidOf(row)))
        .map(uinOf)
        .filter(Boolean),
    );
    for (const uin of missingUins) {
      if (byUin.has(uin)) continue;
      try {
        const profile = await this.session.profileInfo.getProfileByUin(BigInt(uin));
        if (profile) remember(profile);
      } catch {
        /* 仅 QQ 号的旧记录仍可按原昵称阅读。 */
      }
    }
    for (const row of senders) {
      const uid = uidOf(row);
      const uin = uinOf(row);
      const profile = byUid.get(uid) ?? byUin.get(uin);
      if (
        !profile ||
        (uid && profile.uid !== uid) ||
        (uin && profile.uin > 0n && String(profile.uin) !== uin)
      )
        continue;
      row.senderUid = uid || profile.uid;
      row.sendNick = profile.remark?.trim() || profile.nick?.trim() || row.sendNick;
    }
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
