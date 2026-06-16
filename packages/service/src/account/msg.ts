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
import type { C2cMsg, GroupMsg, C2cPartition } from '@weq/db';
import { toRenderElements, type RenderElement } from './msg_view';

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
