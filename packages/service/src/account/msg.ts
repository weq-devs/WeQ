/**
 * MsgService — fetch the messages of one conversation by seq cursor.
 *
 * The renderer loads a conversation as a *seq window*:
 *   - `*Latest`  → newest N (open / switch-into a conversation).
 *   - `*Before`  → the page just older than a seq (scroll up).
 *   - `*From`    → re-read everything at/after a seq (live refresh of the
 *                  currently-loaded window — picks up new tail + in-place edits).
 *
 * All return newest-first; bigint ids/seqs are serialized at the IPC boundary
 * by the caller. c2c queries resolve the peer uid to its sort number (column
 * 40027) via the session's resident `UidMap` so they hit the (40027,40003)
 * composite index; a missing mapping falls back to an unindexed uid scan.
 */

import type { AccountSession } from '@weq/account';
import { C2cMsg, GroupMsg, C2cPartition, type AppendMsgFields, type C2cMsgDb } from '@weq/db';
import {
  ProtoMsg,
  encodeElement,
  Element,
  ElementType,
  validateComposeMessage,
  COMPOSE_ELEMENT_SPECS,
  isDatalineUid,
  type ComposeKind,
  type FieldSpec,
  type MsgCacheRecord,
} from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { toRenderElements, type RenderElement } from './msg_view';

const bodyCodec = new ProtoMsg(MsgBody);

/**
 * Reversible soft-delete markers (see {@link MsgService.deleteMessage}).
 *
 * `SOFT_DELETE_MASK` is XOR-ed into the numeric partition key 40027 (real group
 * code / private-chat sortNo). Bit 62 sits far above any real group code or peer
 * index, so toggling it moves the row out of every real conversation query and
 * never collides; XOR-ing again restores the original value.
 *
 * `SOFT_DELETE_UID_PREFIX` is prepended to the TEXT key 40021 on the c2c/dataline
 * tables to also cover the uid-fallback and device-line query paths (which filter
 * on 40021, not 40027). Restore only strips it from rows that still carry the
 * mask bit, so it can never corrupt a live uid (real uids start with `u_`).
 */
const SOFT_DELETE_MASK = 1n << 62n;
const SOFT_DELETE_UID_PREFIX = 'weqdel';

/**
 * ElementType values that render as a media thumbnail in a reply quote. A reply
 * whose stored `origElements` lacks all of these (QQ NT stores only a "[图片]"
 * text placeholder in the 40800 body) is a candidate for 40900-cache enrichment.
 */
const REPLY_MEDIA_TYPES: ReadonlySet<number> = new Set([
  ElementType.PIC,
  ElementType.VIDEO,
  ElementType.FILE,
  ElementType.MFACE,
  ElementType.PTT,
]);

/** A message carrying a reply element, tagged with its msgId for a 40900 lookup. */
interface ReplyBearer {
  msgId: bigint;
  elements: Element[];
}

/**
 * Input for authoring a new message. `elements` is the *raw* authored array
 * (already byte-decoded at the IPC boundary); it is validated + coerced against
 * the codec compose schemas here, so the service is the single validation point.
 */
export interface InsertMsgInput {
  /** Who the message appears to be from. */
  senderUid: string;
  senderUin: string | bigint;
  /** Authored elements (text/at/pic/face + optional leading reply). */
  elements: unknown[];
  /** Unix seconds; defaults to now. */
  sendTime?: number;
}

export interface InsertMsgResult {
  msgId: bigint;
  msgSeq: bigint;
}

/**
 * Augmented message shapes for the renderer.
 */
export interface RenderC2cMsg extends Omit<C2cMsg, 'elements'> {
  elements: RenderElement[];
}
export interface RenderGroupMsg extends Omit<GroupMsg, 'elements'> {
  elements: RenderElement[];
}

export class MsgService {
  constructor(private readonly session: AccountSession) {}

  // ---- compose / insert ----------------------------------------------------

  /**
   * Field descriptors for each authorable element kind, derived from the codec
   * Zod schemas. The frontend builds its compose form from this — no parallel
   * interface to keep in sync.
   */
  getComposeSpecs(): Record<ComposeKind, FieldSpec[]> {
    return COMPOSE_ELEMENT_SPECS;
  }

  /** Insert a new private-chat message with `peerUid`. */
  async insertC2cMessage(peerUid: string, input: InsertMsgInput): Promise<InsertMsgResult | null> {
    const fields = this.buildAppendFields(input);
    return this.c2cDbFor(peerUid).appendMessage(this.c2cPartition(peerUid), fields);
  }

  /** Insert a new group message into `targetGroupCode`. */
  async insertGroupMessage(targetGroupCode: string, input: InsertMsgInput): Promise<InsertMsgResult | null> {
    const fields = this.buildAppendFields(input);
    return this.session.groupMsgs.appendMessage(targetGroupCode, fields);
  }

  /**
   * Validate the authored elements, derive msgType, encode the 40800 body, and
   * assemble the column overrides shared by c2c/group append. Throws on invalid
   * input so the caller surfaces the reason.
   */
  private buildAppendFields(input: InsertMsgInput): AppendMsgFields {
    const parsed = validateComposeMessage(input.elements);
    if (!parsed.ok) throw new Error(parsed.error);

    const body = bodyCodec.encode({ elements: parsed.elements.map(encodeElement) });
    const sendTime = BigInt(input.sendTime ?? Math.floor(Date.now() / 1000));

    return {
      senderUid: input.senderUid,
      senderUin: BigInt(input.senderUin),
      msgType: parsed.msgType,
      sendTime,
      dayTimestamp: localMidnight(sendTime),
      body,
    };
  }

  // ---- raw / modify --------------------------------------------------------

  /**
   * Get all raw elements of a message by msgId (not filtered by renderer).
   * Searches both C2C and Group tables.
   */
  async getRawElements(msgId: bigint): Promise<{ elements: Element[]; kind: 'c2c' | 'group' } | null> {
    const { decodeBody } = await import('@weq/db');

    const c2cBlob = await this.session.c2cMsgs.getMsgBody(msgId);
    if (c2cBlob) {
        return { elements: decodeBody(c2cBlob), kind: 'c2c' };
    }

    // Device-line messages share the c2c wire shape / edit path.
    const datalineBlob = await this.session.datalineMsgs.getMsgBody(msgId);
    if (datalineBlob) {
        return { elements: decodeBody(datalineBlob), kind: 'c2c' };
    }

    const groupBlob = await this.session.groupMsgs.getMsgBody(msgId);
    if (groupBlob) {
        return { elements: decodeBody(groupBlob), kind: 'group' };
    }

    return null;
  }

  /**
   * Update the elements of a message by msgId.
   */
  async updateElements(msgId: bigint, elements: Element[]): Promise<boolean> {
    const info = await this.getRawElements(msgId);
    if (!info) return false;

    const blob = bodyCodec.encode({
        elements: elements.map(encodeElement)
    });

    let affected = 0;
    if (info.kind === 'c2c') {
        affected = await this.session.c2cMsgs.updateMsgBody(msgId, blob);
    } else {
        affected = await this.session.groupMsgs.updateMsgBody(msgId, blob);
    }

    return affected > 0;
  }

  /**
   * Reversible soft-delete: hide a message from its conversation by XOR-ing a
   * high-bit mask into the 40027 partition key (real group code / private-chat
   * sortNo), plus prefixing the 40021 uid key on the c2c/dataline tables so the
   * uid-fallback and device-line queries miss it too. The row stays in the DB;
   * {@link restoreMessage} brings it back. Searches c2c → dataline → group and
   * acts on whichever holds the row. Returns true if a row was hidden.
   */
  async deleteMessage(msgId: bigint): Promise<boolean> {
    let n = await this.session.c2cMsgs.softDelete(msgId, SOFT_DELETE_MASK, SOFT_DELETE_UID_PREFIX);
    if (n === 0) n = await this.session.datalineMsgs.softDelete(msgId, SOFT_DELETE_MASK, SOFT_DELETE_UID_PREFIX);
    if (n === 0) n = await this.session.groupMsgs.softDeleteMsg(msgId, SOFT_DELETE_MASK);
    return n > 0;
  }

  /**
   * Reverse a {@link deleteMessage} soft-delete. Guarded so calling it on a
   * message that was never soft-deleted is a harmless no-op (returns false).
   */
  async restoreMessage(msgId: bigint): Promise<boolean> {
    let n = await this.session.c2cMsgs.restore(msgId, SOFT_DELETE_MASK, SOFT_DELETE_UID_PREFIX);
    if (n === 0) n = await this.session.datalineMsgs.restore(msgId, SOFT_DELETE_MASK, SOFT_DELETE_UID_PREFIX);
    if (n === 0) n = await this.session.groupMsgs.restoreMsg(msgId, SOFT_DELETE_MASK);
    return n > 0;
  }

  /**
   * Hard-delete: physically drop the message row by msgId. Unlike
   * {@link deleteMessage} (the reversible soft-delete) this is IRREVERSIBLE —
   * the row is gone and cannot be restored. Searches c2c → dataline → group and
   * deletes from whichever holds the row. Returns true if a row was deleted.
   */
  async hardDeleteMessage(msgId: bigint): Promise<boolean> {
    let n = await this.session.c2cMsgs.hardDelete(msgId);
    if (n === 0) n = await this.session.datalineMsgs.hardDelete(msgId);
    if (n === 0) n = await this.session.groupMsgs.hardDeleteMsg(msgId);
    return n > 0;
  }

  /**
   * List the soft-deleted messages of one conversation (see {@link deleteMessage}),
   * newest-first, rendered exactly like a normal page so the UI can reuse its
   * chat bubbles. Group rows are found at `groupCode ^ mask`; c2c/dataline rows
   * by the `weqdel`-prefixed uid — the same table split as the live queries.
   */
  async getDeletedMessages(kind: 'c2c' | 'group', conv: string, limit = 200): Promise<RenderC2cMsg[] | RenderGroupMsg[]> {
    if (kind === 'group') {
      const msgs = await this.session.groupMsgs.listDeleted(conv, SOFT_DELETE_MASK, limit);
      await this.enrichReplyMedia(msgs, 'group');
      return msgs.map(renderGroup);
    }
    const msgs = await this.c2cDbFor(conv).listDeleted(conv, SOFT_DELETE_UID_PREFIX, limit);
    await this.enrichReplyMedia(msgs, 'c2c');
    return msgs.map(renderC2c);
  }

  /** Newest N private-chat messages with one peer. */
  async getC2cLatest(targetUid: string, limit = 50): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listLatest(this.c2cPartition(targetUid), limit);
    await this.enrichReplyMedia(msgs, 'c2c');
    return msgs.map(renderC2c);
  }

  /** Private-chat page just older than `beforeSeq` (scroll-up). */
  async getC2cBefore(targetUid: string, beforeSeq: bigint, limit = 50): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listBefore(this.c2cPartition(targetUid), beforeSeq, limit);
    await this.enrichReplyMedia(msgs, 'c2c');
    return msgs.map(renderC2c);
  }

  /** Private-chat page just newer than `afterSeq` (scroll-down / jump context). */
  async getC2cAfter(targetUid: string, afterSeq: bigint, limit = 50): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listAfter(this.c2cPartition(targetUid), afterSeq, limit);
    await this.enrichReplyMedia(msgs, 'c2c');
    return msgs.map(renderC2c);
  }

  /** Re-read private-chat messages with seq >= `sinceSeq` (live refresh). */
  async getC2cFrom(targetUid: string, sinceSeq: bigint, limit = 500): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listFrom(this.c2cPartition(targetUid), sinceSeq, limit);
    await this.enrichReplyMedia(msgs, 'c2c');
    return msgs.map(renderC2c);
  }

  /**
   * Private-chat page of seq-less messages (migration-imported history) just
   * newer than `afterRowId` (rowid order). Export-only — the seq scan misses
   * these; see `C2cMsgDb.listSeqlessAfterRowId` and `message_source`.
   */
  async getC2cSeqlessAfterRowId(targetUid: string, afterRowId: bigint, limit = 2000): Promise<Array<RenderC2cMsg & { rowId: bigint }>> {
    const msgs = await this.c2cDbFor(targetUid).listSeqlessAfterRowId(this.c2cPartition(targetUid), afterRowId, limit);
    return msgs.map((m) => ({ ...renderC2c(m), rowId: m.rowId }));
  }

  // ---- group ---------------------------------------------------------------

  /** Newest N group messages in one group. */
  async getGroupLatest(targetGroupCode: string, limit = 50): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listLatest(targetGroupCode, limit);
    await this.enrichReplyMedia(msgs, 'group');
    return msgs.map(renderGroup);
  }

  /** Group page just older than `beforeSeq` (scroll-up). */
  async getGroupBefore(targetGroupCode: string, beforeSeq: bigint, limit = 50): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listBefore(targetGroupCode, beforeSeq, limit);
    await this.enrichReplyMedia(msgs, 'group');
    return msgs.map(renderGroup);
  }

  /** Group page just newer than `afterSeq` (scroll-down / jump context). */
  async getGroupAfter(targetGroupCode: string, afterSeq: bigint, limit = 50): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listAfter(targetGroupCode, afterSeq, limit);
    await this.enrichReplyMedia(msgs, 'group');
    return msgs.map(renderGroup);
  }

  /** Re-read group messages with seq >= `sinceSeq` (live refresh). */
  async getGroupFrom(targetGroupCode: string, sinceSeq: bigint, limit = 500): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listFrom(targetGroupCode, sinceSeq, limit);
    await this.enrichReplyMedia(msgs, 'group');
    return msgs.map(renderGroup);
  }

  /**
   * Group page of seq-less messages (migration-imported history) just newer
   * than `afterRowId` (rowid order). Export-only — the seq scan misses these;
   * see `GroupMsgDb.listSeqlessAfterRowId` and `message_source`.
   */
  async getGroupSeqlessAfterRowId(targetGroupCode: string, afterRowId: bigint, limit = 2000): Promise<Array<RenderGroupMsg & { rowId: bigint }>> {
    const msgs = await this.session.groupMsgs.listSeqlessAfterRowId(targetGroupCode, afterRowId, limit);
    return msgs.map((m) => ({ ...renderGroup(m), rowId: m.rowId }));
  }

  // ---- count ---------------------------------------------------------------

  /**
   * Count the total stored messages of one conversation (a single COUNT query).
   * Used as a coarse `total` estimate for export progress; failures degrade to 0
   * so callers never break on it.
   */
  async countConv(kind: 'c2c' | 'group', conv: string): Promise<number> {
    try {
      if (kind === 'group') {
        const byCode = await this.session.groupMsgs.countByGroups([conv]);
        return byCode[conv] ?? 0;
      }
      const byUid = await this.c2cDbFor(conv).countByUids([conv]);
      return byUid[conv] ?? 0;
    } catch {
      return 0;
    }
  }

  // ---- reply media enrichment ----------------------------------------------

  /**
   * Back-fill a reply quote's real media element from the 40900 cache.
   *
   * QQ NT stores only a "[图片]" / "[视频]" TEXT placeholder in a reply's inline
   * `origElements` (40800 body) — the quoted message's true media (image token,
   * md5, CDN urls) lives instead in the 40900 message-cache column as a full
   * snapshot of the quoted row. So for every reply whose stored origElements
   * carries NO media element, we look up this message's 40900 cache, find the
   * cached quoted message (matched by origMsgId, else the first record), and
   * splice its real elements into origElements — letting the renderer show an
   * actual thumbnail. Text/@/face replies and replies that already carry media
   * are left untouched (no lookup).
   *
   * Mutates the passed messages in place (before render mapping) and swallows
   * per-message lookup failures so a bad cache never breaks the page.
   */
  private async enrichReplyMedia(
    msgs: ReplyBearer[],
    kind: 'c2c' | 'group',
  ): Promise<void> {
    const pending = msgs.filter((m) => m.elements.some(isMediaLessReply));
    if (pending.length === 0) return;

    await Promise.all(
      pending.map(async (m) => {
        try {
          const cache =
            kind === 'group'
              ? await this.session.forwardMsgs.listGroupForward(m.msgId)
              : await this.session.forwardMsgs.listC2cForward(m.msgId);
          if (cache.length === 0) return;
          const media = cachedQuotedMedia(cache);
          if (media.length === 0) return;
          for (const el of m.elements) {
            if (isMediaLessReply(el)) (el as ReplyLike).origElements = media;
          }
        } catch {
          /* keep the "[图片]" placeholder on any cache miss / decode error */
        }
      }),
    );
  }

  /** Resolve a peer uid to its indexed partition (sortNo), else fall back to uid. */
  private c2cPartition(targetUid: string): C2cPartition {
    const sortNo = this.session.uidMap.sortNoByUid(targetUid);
    return sortNo !== undefined ? { sortNo } : { uid: targetUid };
  }

  /**
   * Pick the message table for a "c2c-like" conversation. Device-line uids
   * (我的手机/我的电脑) live in `dataline_msg_table`; everything else is a real
   * private chat in `c2c_msg_table`. Both are served by C2cMsgDb (same schema),
   * and dataline uids aren't in the uid map so they naturally take the uid
   * partition path.
   */
  private c2cDbFor(targetUid: string): C2cMsgDb {
    return isDatalineUid(targetUid) ? this.session.datalineMsgs : this.session.c2cMsgs;
  }
}

/** Local-midnight (unix seconds) of a unix-seconds timestamp — column 40058. */
function localMidnight(sec: bigint): bigint {
  const d = new Date(Number(sec) * 1000);
  return BigInt(Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000));
}

function renderC2c(m: C2cMsg): RenderC2cMsg {
  return { ...m, elements: toRenderElements(m.elements) };
}

function renderGroup(m: GroupMsg): RenderGroupMsg {
  return { ...m, elements: toRenderElements(m.elements) };
}

/** A reply element (pre-render): `origElements` holds raw quoted ElementWire. */
interface ReplyLike {
  kind?: string;
  origElements?: unknown[];
}

/** Raw wire element: an object bearing a numeric `elementType`. */
function wireType(el: unknown): number {
  const t = (el as { elementType?: unknown })?.elementType;
  return typeof t === 'number' ? t : 0;
}

/**
 * True for a `reply` element whose stored `origElements` contains no media
 * element — i.e. only the "[图片]"/"[视频]" text placeholder QQ writes into the
 * 40800 body. These are the replies worth a 40900-cache lookup.
 */
function isMediaLessReply(el: Element): boolean {
  if ((el as ReplyLike).kind !== 'reply') return false;
  const orig = (el as ReplyLike).origElements;
  if (!Array.isArray(orig)) return true;
  return !orig.some((o) => REPLY_MEDIA_TYPES.has(wireType(o)));
}

/**
 * Pick the quoted message's real media-bearing elements out of a 40900 cache.
 *
 * A reply's 40900 cache holds exactly ONE record: the quoted message (only
 * merged-forwards, msgType 8, carry multiple). The reply element's `origMsgId`
 * is NOT the cached record's snowflake msgId (verified on a live row — they
 * differ), so we can't match by id; we take the sole record. Returns its raw
 * wire elements (ready for decodeElement in mapReply), or [] when the cached
 * record carries no media after all.
 */
function cachedQuotedMedia(cache: MsgCacheRecord[]): unknown[] {
  const record = cache[0];
  const els = (record as { elements?: unknown[] } | undefined)?.elements;
  if (!Array.isArray(els)) return [];
  return els.some((o) => REPLY_MEDIA_TYPES.has(wireType(o))) ? els : [];
}
