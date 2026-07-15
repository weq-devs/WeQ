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
import { DeletedMsgStore } from './deleted_msgs';

const bodyCodec = new ProtoMsg(MsgBody);

/**
 * QQ's own recall/delete rewrites a message's type columns to `(1,1)`, leaving
 * the 40800 body untouched. WeQ's delete mirrors this exactly (see
 * {@link MsgService.deleteMessage}) so the DB stays byte-consistent with QQ's
 * behavior; reversibility (which rows WeQ deleted + their original 40011/40012)
 * is tracked out-of-band in a {@link DeletedMsgStore}, never in the DB.
 */
const DELETED_MSG_TYPE = 1n;
const DELETED_SUB_TYPE = 1n;

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
 *
 * `deletedKind` marks the QQ-style `(1,1)` deleted signature and its origin:
 * `'weq'` = WeQ deleted it (in the DeletedMsgStore, restorable) → the chat
 * shows a "已删除" veil + restore button; `'qq'` = QQ's own recall / a delete
 * from another client (no store record, NOT restorable) → a "QQ删除" veil, no
 * restore. `undefined` = a live message.
 */
export type DeletedKind = 'weq' | 'qq';
export interface RenderC2cMsg extends Omit<C2cMsg, 'elements'> {
  elements: RenderElement[];
  deletedKind?: DeletedKind;
}
export interface RenderGroupMsg extends Omit<GroupMsg, 'elements'> {
  elements: RenderElement[];
  deletedKind?: DeletedKind;
}

export class MsgService {
  /**
   * `deleted` is the per-account {@link DeletedMsgStore}; omit it for contexts
   * that never delete (e.g. the export pipeline's private MsgService).
   */
  constructor(
    private readonly session: AccountSession,
    private readonly deleted?: DeletedMsgStore,
  ) {}

  /**
   * Classify a message's deleted state from its raw type columns. A `(1,1)`
   * signature (see {@link DELETED_MSG_TYPE}) means deleted; the DeletedMsgStore
   * then tells WeQ-deleted (restorable) apart from a QQ-native recall (not).
   * `undefined` when the columns weren't selected or the message is live.
   */
  private classifyDeleted(m: { msgId: bigint; msgType?: bigint; subType?: bigint }): DeletedKind | undefined {
    if (m.msgType !== DELETED_MSG_TYPE || m.subType !== DELETED_SUB_TYPE) return undefined;
    return this.deleted?.get(m.msgId.toString()) ? 'weq' : 'qq';
  }

  /** {@link renderC2c} plus the computed {@link RenderC2cMsg.deletedKind}. */
  private renderC2cWithState(m: C2cMsg): RenderC2cMsg {
    return { ...renderC2c(m), deletedKind: this.classifyDeleted(m) };
  }

  /** {@link renderGroup} plus the computed {@link RenderGroupMsg.deletedKind}. */
  private renderGroupWithState(m: GroupMsg): RenderGroupMsg {
    return { ...renderGroup(m), deletedKind: this.classifyDeleted(m) };
  }

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
   * Delete a message the way QQ itself does: rewrite the type columns
   * 40011/40012 to `(1,1)` in place (verified against a live QQ delete — those
   * are the ONLY two columns QQ touches; the 40800 body stays intact). The row
   * never leaves its conversation partition, so it still renders in the chat —
   * the frontend shows it under a translucent "deleted" overlay.
   *
   * Reversibility lives in the {@link DeletedMsgStore}: the original 40011/40012
   * are remembered there per msgId (they vary by message kind — plain text is
   * 2/16, replies 9/…), which is also what distinguishes WeQ deletes from QQ's
   * own recalls (both are `(1,1)` in the DB). Without a store this degrades to
   * an irreversible-but-QQ-identical delete.
   *
   * Searches c2c → dataline → group and acts on whichever holds the row.
   * Returns true if a row was rewritten.
   */
  async deleteMessage(msgId: bigint, kind: 'c2c' | 'group', conv: string): Promise<boolean> {
    for (const db of [this.session.c2cMsgs, this.session.datalineMsgs, this.session.groupMsgs] as const) {
      const orig = await db.readMsgType(msgId);
      if (!orig) continue;
      this.deleted?.add(msgId.toString(), {
        origMsgType: orig.msgType.toString(),
        origSubType: orig.subType.toString(),
        kind,
        conv,
        deletedAt: Math.floor(Date.now() / 1000),
      });
      return (await db.writeMsgType(msgId, DELETED_MSG_TYPE, DELETED_SUB_TYPE)) > 0;
    }
    return false;
  }

  /**
   * Reverse a {@link deleteMessage}: write the remembered original 40011/40012
   * back and drop the store record. No-op (false) for messages WeQ never
   * deleted — including QQ's own recalls, which have no store record.
   */
  async restoreMessage(msgId: bigint): Promise<boolean> {
    const rec = this.deleted?.get(msgId.toString());
    if (!rec) return false;
    for (const db of [this.session.c2cMsgs, this.session.datalineMsgs, this.session.groupMsgs] as const) {
      const cur = await db.readMsgType(msgId);
      if (!cur) continue;
      const n = await db.writeMsgType(msgId, BigInt(rec.origMsgType), BigInt(rec.origSubType));
      if (n > 0) this.deleted?.remove(msgId.toString());
      return n > 0;
    }
    return false;
  }

  /**
   * List the deleted messages of one conversation, newest-first, rendered like
   * a normal page so the UI can reuse its chat bubbles. Scans EVERY `(1,1)` row
   * in the conversation (see `listDeletedByConv`) — so it surfaces both WeQ's
   * own deletes AND QQ-native recalls the store never recorded — then tags each
   * with `deletedKind` ('weq' restorable vs 'qq' not) via {@link classifyDeleted}.
   */
  async getDeletedMessages(kind: 'c2c' | 'group', conv: string): Promise<RenderC2cMsg[] | RenderGroupMsg[]> {
    if (kind === 'group') {
      const msgs = await this.session.groupMsgs.listDeletedByConv(conv);
      await this.enrichReplyMedia(msgs, 'group');
      return msgs.map((m) => this.renderGroupWithState(m));
    }
    const msgs = await this.c2cDbFor(conv).listDeletedByConv(conv);
    await this.enrichReplyMedia(msgs, 'c2c');
    return msgs.map((m) => this.renderC2cWithState(m));
  }

  /**
   * The msgIds WeQ deleted in one conversation — the lightweight signal the
   * chat view uses to draw the translucent "deleted" overlay over in-place
   * rows without fetching their content again.
   */
  getDeletedMsgIds(kind: 'c2c' | 'group', conv: string): string[] {
    return this.deleted?.listIds(kind, conv) ?? [];
  }

  /** Newest N private-chat messages with one peer. */
  async getC2cLatest(targetUid: string, limit = 50): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listLatest(this.c2cPartition(targetUid), limit);
    await this.enrichReplyMedia(msgs, 'c2c');
    return msgs.map((m) => this.renderC2cWithState(m));
  }

  /** Private-chat page just older than `beforeSeq` (scroll-up). */
  async getC2cBefore(targetUid: string, beforeSeq: bigint, limit = 50): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listBefore(this.c2cPartition(targetUid), beforeSeq, limit);
    await this.enrichReplyMedia(msgs, 'c2c');
    return msgs.map((m) => this.renderC2cWithState(m));
  }

  /** Private-chat page just newer than `afterSeq` (scroll-down / jump context). */
  async getC2cAfter(targetUid: string, afterSeq: bigint, limit = 50): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listAfter(this.c2cPartition(targetUid), afterSeq, limit);
    await this.enrichReplyMedia(msgs, 'c2c');
    return msgs.map((m) => this.renderC2cWithState(m));
  }

  /** Re-read private-chat messages with seq >= `sinceSeq` (live refresh). */
  async getC2cFrom(targetUid: string, sinceSeq: bigint, limit = 500): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listFrom(this.c2cPartition(targetUid), sinceSeq, limit);
    await this.enrichReplyMedia(msgs, 'c2c');
    return msgs.map((m) => this.renderC2cWithState(m));
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
    return msgs.map((m) => this.renderGroupWithState(m));
  }

  /** Group page just older than `beforeSeq` (scroll-up). */
  async getGroupBefore(targetGroupCode: string, beforeSeq: bigint, limit = 50): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listBefore(targetGroupCode, beforeSeq, limit);
    await this.enrichReplyMedia(msgs, 'group');
    return msgs.map((m) => this.renderGroupWithState(m));
  }

  /** Group page just newer than `afterSeq` (scroll-down / jump context). */
  async getGroupAfter(targetGroupCode: string, afterSeq: bigint, limit = 50): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listAfter(targetGroupCode, afterSeq, limit);
    await this.enrichReplyMedia(msgs, 'group');
    return msgs.map((m) => this.renderGroupWithState(m));
  }

  /** Re-read group messages with seq >= `sinceSeq` (live refresh). */
  async getGroupFrom(targetGroupCode: string, sinceSeq: bigint, limit = 500): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listFrom(targetGroupCode, sinceSeq, limit);
    await this.enrichReplyMedia(msgs, 'group');
    return msgs.map((m) => this.renderGroupWithState(m));
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
