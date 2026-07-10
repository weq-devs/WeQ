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
  validateComposeMessage,
  COMPOSE_ELEMENT_SPECS,
  isDatalineUid,
  type ComposeKind,
  type FieldSpec,
} from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { toRenderElements, type RenderElement } from './msg_view';

const bodyCodec = new ProtoMsg(MsgBody);

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

  // ---- c2c -----------------------------------------------------------------

  /** Newest N private-chat messages with one peer. */
  async getC2cLatest(targetUid: string, limit = 50): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listLatest(this.c2cPartition(targetUid), limit);
    return msgs.map(renderC2c);
  }

  /** Private-chat page just older than `beforeSeq` (scroll-up). */
  async getC2cBefore(targetUid: string, beforeSeq: bigint, limit = 50): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listBefore(this.c2cPartition(targetUid), beforeSeq, limit);
    return msgs.map(renderC2c);
  }

  /** Private-chat page just newer than `afterSeq` (scroll-down / jump context). */
  async getC2cAfter(targetUid: string, afterSeq: bigint, limit = 50): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listAfter(this.c2cPartition(targetUid), afterSeq, limit);
    return msgs.map(renderC2c);
  }

  /** Re-read private-chat messages with seq >= `sinceSeq` (live refresh). */
  async getC2cFrom(targetUid: string, sinceSeq: bigint, limit = 500): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listFrom(this.c2cPartition(targetUid), sinceSeq, limit);
    return msgs.map(renderC2c);
  }

  /**
   * Private-chat page just newer than `afterRowId` (rowid order). Export-only
   * fallback for conversations whose msgSeq is unusable — see
   * `C2cMsgDb.listAfterRowId`.
   */
  async getC2cAfterRowId(targetUid: string, afterRowId: bigint, limit = 2000): Promise<Array<RenderC2cMsg & { rowId: bigint }>> {
    const msgs = await this.c2cDbFor(targetUid).listAfterRowId(this.c2cPartition(targetUid), afterRowId, limit);
    return msgs.map((m) => ({ ...renderC2c(m), rowId: m.rowId }));
  }

  // ---- group ---------------------------------------------------------------

  /** Newest N group messages in one group. */
  async getGroupLatest(targetGroupCode: string, limit = 50): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listLatest(targetGroupCode, limit);
    return msgs.map(renderGroup);
  }

  /** Group page just older than `beforeSeq` (scroll-up). */
  async getGroupBefore(targetGroupCode: string, beforeSeq: bigint, limit = 50): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listBefore(targetGroupCode, beforeSeq, limit);
    return msgs.map(renderGroup);
  }

  /** Group page just newer than `afterSeq` (scroll-down / jump context). */
  async getGroupAfter(targetGroupCode: string, afterSeq: bigint, limit = 50): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listAfter(targetGroupCode, afterSeq, limit);
    return msgs.map(renderGroup);
  }

  /** Re-read group messages with seq >= `sinceSeq` (live refresh). */
  async getGroupFrom(targetGroupCode: string, sinceSeq: bigint, limit = 500): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listFrom(targetGroupCode, sinceSeq, limit);
    return msgs.map(renderGroup);
  }

  /**
   * Group page just newer than `afterRowId` (rowid order). Export-only fallback
   * for conversations whose msgSeq is unusable — see `GroupMsgDb.listAfterRowId`.
   */
  async getGroupAfterRowId(targetGroupCode: string, afterRowId: bigint, limit = 2000): Promise<Array<RenderGroupMsg & { rowId: bigint }>> {
    const msgs = await this.session.groupMsgs.listAfterRowId(targetGroupCode, afterRowId, limit);
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
