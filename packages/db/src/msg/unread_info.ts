/**
 * `msg_unread_info_table` — conversation unread info.
 *
 * Column map:
 *   48901  peer      (TEXT — format: "chatType_uid")
 *   48902  unreadBuf (BLOB — protobuf with field 41002: msgSeq)
 */

import type { DatabaseAlgorithms, NtHelperBinding } from '@weq/native';
import { QqDb } from '../qq_db';
import { ProtoMsg } from '@weq/codec';
import {
  appendNode,
  buildEditTree,
  encodeEditTree,
  newNode,
  removeNode,
  updateNode,
} from '@weq/codec/raw';
import type { PbNode } from '@weq/codec/raw';
import { UnreadInfo } from '@weq/codec/proto/msg/48902';

export interface UnreadInfoDbOptions {
  dbPath: string;
  key?: string;
  algo?: DatabaseAlgorithms;
}

/**
 * Named categories of the 48902 notify-highlight (50005 → 50060), keyed by the
 * observed `50000` kind code. QQ NT populates one highlight group per category
 * that currently has an unread hit:
 *   1000 = @我 (at-me), 1002 = 回复我 (reply-me), 1006 = 特别关心 (special-care),
 *   1007 = QQ红包 (red-packet), 2000 = @全体 (at-all), 2001 = 新文件 (new-file),
 *   2005 = 群公告 (group announcement), 2006 = 群提醒词 (group keyword).
 * More will slot in as their codes are captured.
 */
export type HighlightKind =
  | 'atMe'
  | 'atAll'
  | 'replyMe'
  | 'specialCare'
  | 'newFile'
  | 'redPacket'
  | 'groupAnnouncement'
  | 'groupKeyword'
  | 'unknown';

const HIGHLIGHT_KIND_BY_CODE: Record<number, HighlightKind> = {
  1000: 'atMe',
  1002: 'replyMe',
  1006: 'specialCare',
  1007: 'redPacket',
  2000: 'atAll',
  2001: 'newFile',
  2005: 'groupAnnouncement',
  2006: 'groupKeyword',
};

/**
 * One notify-highlight hit for a conversation, decoded from 50060 → 50040.
 * Present only while the conversation has a matching unread message.
 */
export interface UnreadHighlight {
  /** Mapped category; 'unknown' when the 50000 code isn't recognized yet. */
  kind: HighlightKind;
  /** Raw 50000 code, preserved so unmapped categories are still identifiable. */
  rawKind: number;
  /** Seq of the (latest) highlighted message in this category. */
  msgSeq: number;
  /** Uid of the sender. */
  senderUid: string;
  /** Send time of the highlighted message (unix seconds). */
  sendTime: number;
}

export interface UnreadInfoResult {
  peer: string;
  chatType: number;
  uid: string;
  msgSeq?: number;
  /** Notify-highlights (特别关心 / @我 / …) present on this conversation. */
  highlights?: UnreadHighlight[];
}

export class UnreadInfoDb {
  private readonly qq: QqDb;
  private readonly proto = new ProtoMsg(UnreadInfo);

  constructor(nt: NtHelperBinding, opts: UnreadInfoDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  async getUnreadInfo(chatType: number, uid: string): Promise<UnreadInfoResult | null> {
    const peer = `${chatType}_${uid}`;
    const rows = await this.qq.query(
      `SELECT "48901", "48902" FROM msg_unread_info_table WHERE "48901" = ? LIMIT 1`,
      [peer],
    );

    const row = rows[0];
    if (!row) return null;

    const buf = row[1] as Uint8Array;
    const decoded = buf ? this.proto.decode(buf) : {};
    const highlights = extractHighlights(decoded.info?.ext);

    return {
      peer: row[0] as string,
      chatType,
      uid,
      msgSeq: decoded.info?.msgSeq,
      highlights: highlights.length ? highlights : undefined,
    };
  }

  /**
   * Mark one conversation as read: raise `41002` (last-read seq) to the
   * conversation's newest seq and drop the `50060` notify-highlight groups, so
   * the unread dot goes away and — crucially — WeQ does not re-offer the same
   * highlight jumps the next time the chat is opened.
   *
   * The blob is rewritten through the wire-level edit tree (see
   * `@weq/codec/raw`): a node we don't touch is copied straight out of the
   * original bytes, so the columns we have NOT reverse-engineered
   * (`41024` / `41027` / `41032` / `50006` / `50007` …) survive bit-identically.
   *
   * @param latestSeq newest seq to write; when omitted it is read from
   *   `recent_contact_v3_table.40003` (same DB) so callers don't need to thread
   *   the conversation watermark through.
   * @returns true when the row was actually updated.
   */
  async markRead(
    chatType: number,
    uid: string,
    latestSeq?: number | bigint | string,
  ): Promise<boolean> {
    const peer = `${chatType}_${uid}`;
    const rows = await this.qq.query(
      `SELECT "48902" FROM msg_unread_info_table WHERE "48901" = ? LIMIT 1`,
      [peer],
    );
    const row = rows[0];
    if (!row) return false;

    let target: bigint;
    if (latestSeq === undefined) {
      const latest = await this.latestSeqOf(uid);
      if (latest === null) return false;
      target = latest;
    } else {
      target = BigInt(latestSeq);
    }
    // 0 不是合法水位（41002 缺失才会是 0）—— 拿它去写只会把已读位置倒退。
    if (target <= 0n) return false;

    const bytes = row[0] as Uint8Array | null;
    if (!bytes || bytes.length === 0) return false;

    const tree = buildEditTree(bytes);
    const info = tree.find((node) => node.tag === 48902);
    if (!info?.children) return false;

    const readNode = info.children.find((node) => node.tag === 41002);
    // 50060 lives nested inside 50005 (ext), not directly under the info node —
    // walk the whole subtree so a multi-group blob drops every one of them.
    const highlightNodes = findAll(info, 50060);
    const highlightNode = highlightNodes[0];
    // Never regress the watermark: QQ may have advanced 41002 between our read
    // and this write, so take the higher of (stored, requested).
    const storedRead = readNode ? readVarintText(readNode) : 0n;
    if (storedRead > target) target = storedRead;
    const alreadyRead = !highlightNode && readNode && storedRead >= target;
    if (alreadyRead) return false;

    let next = tree;
    if (readNode) {
      next = updateNode(next, readNode.id, (node) => ({
        ...node,
        value: { kind: 'varint', text: target.toString() },
      }));
    } else {
      // No 41002 yet (a conversation row created before any read marker).
      // Append one so the read watermark lands where QQ expects it.
      const appended = newNode(41002, 0);
      appended.value = { kind: 'varint', text: target.toString() };
      next = appendNode(next, info.id, appended);
    }
    for (const node of highlightNodes) {
      next = removeNode(next, node.id);
    }

    const encoded = encodeEditTree(next, bytes);
    const changed = await this.qq.write(
      `UPDATE msg_unread_info_table SET "48902" = ? WHERE "48901" = ?`,
      [encoded, peer],
    );
    return changed > 0;
  }

  /** Conversation watermark (`recent_contact_v3_table.40003`) or null when absent. */
  private async latestSeqOf(uid: string): Promise<bigint | null> {
    const rows = await this.qq.query(
      `SELECT "40003" FROM recent_contact_v3_table WHERE "40021" = ? LIMIT 1`,
      [uid],
    );
    const value = rows[0]?.[0];
    if (value === undefined || value === null) return null;
    return BigInt(value as number | bigint | string);
  }

  close(): void {
    this.qq.close();
  }
}

/** Read a `varint`-kind node's decimal text back as a BigInt (0 when malformed). */
function readVarintText(node: PbNode): bigint {
  if (node.value.kind !== 'varint' && node.value.kind !== 'timestamp') return 0n;
  try {
    return BigInt(node.value.text);
  } catch {
    return 0n;
  }
}

/** Every node under `root` (inclusive) whose tag matches, depth-first. */
function findAll(root: PbNode, tag: number): PbNode[] {
  const out: PbNode[] = [];
  if (root.tag === tag) out.push(root);
  for (const child of root.children ?? []) {
    out.push(...findAll(child, tag));
  }
  return out;
}

type DecodedExt = NonNullable<
  NonNullable<ReturnType<ProtoMsg<typeof UnreadInfo>['decode']>['info']>['ext']
>;

/**
 * Flatten the 50060 highlight groups into one entry per category. Each group's
 * `50000` code maps to a `HighlightKind`; within a group the latest (highest
 * seq) 50040 item wins.
 */
function extractHighlights(ext: DecodedExt | undefined): UnreadHighlight[] {
  const groups = ext?.highlight;
  if (!groups?.length) return [];

  const out: UnreadHighlight[] = [];
  for (const group of groups) {
    const rawKind = group.kind ?? -1;
    let best: UnreadHighlight | undefined;
    for (const item of group.items ?? []) {
      if (item.msgSeq === undefined) continue;
      if (!best || item.msgSeq > best.msgSeq) {
        best = {
          kind: HIGHLIGHT_KIND_BY_CODE[rawKind] ?? 'unknown',
          rawKind,
          msgSeq: item.msgSeq,
          senderUid: item.senderUid ?? '',
          sendTime: item.sendTime ?? 0,
        };
      }
    }
    if (best) out.push(best);
  }
  return out;
}
