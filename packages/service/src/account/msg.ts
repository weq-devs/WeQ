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
import { C2cMsg, GroupMsg, C2cPartition } from '@weq/db';
import { ProtoMsg, encodeElement, Element } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { toRenderElements, type RenderElement } from './msg_view';

const bodyCodec = new ProtoMsg(MsgBody);

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
    const msgs = await this.session.c2cMsgs.listLatest(this.c2cPartition(targetUid), limit);
    return msgs.map(renderC2c);
  }

  /** Private-chat page just older than `beforeSeq` (scroll-up). */
  async getC2cBefore(targetUid: string, beforeSeq: bigint, limit = 50): Promise<RenderC2cMsg[]> {
    const msgs = await this.session.c2cMsgs.listBefore(this.c2cPartition(targetUid), beforeSeq, limit);
    return msgs.map(renderC2c);
  }

  /** Private-chat page just newer than `afterSeq` (scroll-down / jump context). */
  async getC2cAfter(targetUid: string, afterSeq: bigint, limit = 50): Promise<RenderC2cMsg[]> {
    const msgs = await this.session.c2cMsgs.listAfter(this.c2cPartition(targetUid), afterSeq, limit);
    return msgs.map(renderC2c);
  }

  /** Re-read private-chat messages with seq >= `sinceSeq` (live refresh). */
  async getC2cFrom(targetUid: string, sinceSeq: bigint, limit = 500): Promise<RenderC2cMsg[]> {
    const msgs = await this.session.c2cMsgs.listFrom(this.c2cPartition(targetUid), sinceSeq, limit);
    return msgs.map(renderC2c);
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

  /** Resolve a peer uid to its indexed partition (sortNo), else fall back to uid. */
  private c2cPartition(targetUid: string): C2cPartition {
    const sortNo = this.session.uidMap.sortNoByUid(targetUid);
    return sortNo !== undefined ? { sortNo } : { uid: targetUid };
  }
}

function renderC2c(m: C2cMsg): RenderC2cMsg {
  return { ...m, elements: toRenderElements(m.elements) };
}

function renderGroup(m: GroupMsg): RenderGroupMsg {
  return { ...m, elements: toRenderElements(m.elements) };
}
