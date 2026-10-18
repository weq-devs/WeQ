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
import type { PbNode, PbValue } from '@weq/codec/raw';
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
  /** Preview text (50024). For 群提醒词 this is the keyword that matched. */
  text: string;
}

export interface UnreadInfoResult {
  peer: string;
  chatType: number;
  uid: string;
  msgSeq?: number;
  /** Notify-highlights (特别关心 / @我 / …) present on this conversation. */
  highlights?: UnreadHighlight[];
}

export interface UnreadInfoTarget {
  chatType: number;
  uid: string;
}

export interface UnreadInfoSnapshot extends UnreadInfoResult {
  latestSeq: string | null;
  readError?: true;
}

/**
 * One hit to write back into the `48902` notify-highlight extension
 * (`50005 → 50060`). Kept as a raw kind code (not the mapped enum) so callers
 * can write categories — e.g. `2006` 群提醒词 — that WeQ itself produces and
 * that QQ renders natively.
 */
export interface UnreadHighlightInput {
  /** Raw `50000` kind code, e.g. 2006 = 群提醒词. */
  kind: number;
  /** Seq of the highlighted message. */
  msgSeq: number;
  /** Sender uid. */
  senderUid: string;
  /** Send time (unix seconds). */
  sendTime: number;
  /** Preview text stored on the item (QQ often leaves this empty; we fill it). */
  text: string;
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

  /** 每批在同一条 SQL 内读取最新序号与已读水位，避免逐会话 IPC 和交错快照。 */
  async getUnreadInfos(targets: UnreadInfoTarget[]): Promise<UnreadInfoSnapshot[]> {
    const unique = [...new Map(targets.map((t) => [`${t.chatType}_${t.uid}`, t])).values()];
    const result: UnreadInfoSnapshot[] = [];
    for (let offset = 0; offset < unique.length; offset += 256) {
      const batch = unique.slice(offset, offset + 256);
      const rows = await this.qq.query(
        `WITH targets(chatType, uid, peer) AS (VALUES ${batch.map(() => '(?, ?, ?)').join(',')})
         SELECT t.chatType, t.uid, t.peer, u."48902", r."40003"
         FROM targets t
         LEFT JOIN msg_unread_info_table u ON u."48901" = t.peer
         LEFT JOIN recent_contact_v3_table r ON r."40021" = t.uid AND r."40010" = t.chatType`,
        batch.flatMap((t) => [t.chatType, t.uid, `${t.chatType}_${t.uid}`]),
      );
      for (const row of rows) {
        const bytes = row[3];
        const identity = {
          chatType: Number(row[0]),
          uid: String(row[1]),
          peer: String(row[2]),
          latestSeq: row[4] === null ? null : String(row[4]),
        };
        try {
          const decoded = bytes instanceof Uint8Array ? this.proto.decode(bytes) : {};
          const highlights = extractHighlights(decoded.info?.ext);
          result.push({
            ...identity,
            msgSeq: decoded.info?.msgSeq,
            highlights: highlights.length ? highlights : undefined,
          });
        } catch {
          result.push({ ...identity, readError: true });
        }
      }
    }
    return result;
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
    const target = latestSeq === undefined ? await this.latestSeqOf(uid) : BigInt(latestSeq);
    if (target === null || target <= 0n) return false;
    // 重试不得跟随新消息抬高目标，否则会把尚未展示的消息也标成已读。
    for (let attempt = 0; attempt < 3; attempt++) {
      const changed = await this.markReadAttempt(chatType, uid, target);
      if (changed !== null) return changed;
    }
    throw new Error('已读状态更新冲突，请稍后重试。');
  }

  private async markReadAttempt(
    chatType: number,
    uid: string,
    target: bigint,
  ): Promise<boolean | null> {
    const peer = `${chatType}_${uid}`;
    const rows = await this.qq.query(
      `SELECT "48902" FROM msg_unread_info_table WHERE "48901" = ? LIMIT 1`,
      [peer],
    );
    const row = rows[0];
    if (!row) return false;

    const bytes = row[0] as Uint8Array | null;
    if (!bytes || bytes.length === 0) return false;

    const tree = buildEditTree(bytes);
    const info = tree.find((node) => node.tag === 48902);
    if (!info?.children) return false;

    const readNode = info.children.find((node) => node.tag === 41002);
    // 50060 在 50005 内，遍历整棵树处理所有提醒组。
    const highlightNodes = findAll(info, 50060);
    // 只清理确认范围内的提醒；保留并发新到或无法识别序号的条目。
    const removable: PbNode[] = [];
    for (const group of highlightNodes) {
      const items = findAll(group, 50040);
      const readItems = items.filter((item) => {
        const seq = readVarintChild(item, 50020);
        return seq !== null && BigInt(seq) <= target;
      });
      if (items.length === 0 || readItems.length === items.length) removable.push(group);
      else removable.push(...readItems);
    }
    const storedRead = readNode ? readVarintText(readNode) : 0n;
    if (storedRead > target) target = storedRead;
    const alreadyRead = removable.length === 0 && readNode && storedRead >= target;
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
    for (const node of removable) {
      next = removeNode(next, node.id);
    }

    const encoded = encodeEditTree(next, bytes);
    const changed = await this.qq.write(
      `UPDATE msg_unread_info_table SET "48902" = ? WHERE "48901" = ? AND "48902" = ?`,
      [encoded, peer, bytes],
    );
    return changed > 0 ? true : null;
  }

  /**
   * Append one notify-highlight hit to a conversation's `48902` blob so the
   * conversation shows the matching badge in **both** WeQ and QQ itself. Used
   * by the group-keyword reminder (kind `2006`).
   *
   * Like {@link markRead} this rewrite goes through the wire-level edit tree:
   * every field we have not reverse-engineered survives byte-for-byte. When the
   * conversation has no unread row yet, a minimal `48902` blob carrying just
   * `chatType` / `peerUid` / the highlight is inserted instead.
   *
   * Idempotent per `(kind, msgSeq)`: re-adding the same hit is a no-op.
   *
   * @returns true when the row was actually written.
   */
  async addHighlight(
    chatType: number,
    uid: string,
    highlight: UnreadHighlightInput,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const changed = await this.addHighlightAttempt(chatType, uid, highlight);
      if (changed !== null) return changed;
    }
    throw new Error('提醒状态更新冲突，请稍后重试。');
  }

  private async addHighlightAttempt(
    chatType: number,
    uid: string,
    highlight: UnreadHighlightInput,
  ): Promise<boolean | null> {
    const peer = `${chatType}_${uid}`;
    const rows = await this.qq.query(
      `SELECT "48902" FROM msg_unread_info_table WHERE "48901" = ? LIMIT 1`,
      [peer],
    );
    const existing = rows[0]?.[0];
    const bytes = existing instanceof Uint8Array && existing.length > 0 ? existing : null;

    const itemNode = nestedNode(50040, [
      varintNode(50020, highlight.msgSeq),
      utf8Node(50022, highlight.senderUid),
      varintNode(50023, highlight.sendTime),
      utf8Node(50024, highlight.text),
    ]);
    const groupNode = () => nestedNode(50060, [varintNode(50000, highlight.kind), itemNode]);

    let tree: PbNode[];
    if (bytes) {
      tree = buildEditTree(bytes);
      const info = tree.find((node) => node.tag === 48902);
      if (!info?.children) return false;
      const read = info.children.find((node) => node.tag === 41002);
      if (read && readVarintText(read) >= BigInt(highlight.msgSeq)) return false;

      // Reuse the existing group of the same kind when there is one — QQ's
      // shape is one 50060 per category with many 50040 items under it.
      const group = findAll(info, 50060).find(
        (node) => readVarintChild(node, 50000) === highlight.kind,
      );
      if (group) {
        const dup = findAll(group, 50040).some(
          (node) => readVarintChild(node, 50020) === highlight.msgSeq,
        );
        if (dup) return false;
        tree = appendNode(tree, group.id, itemNode);
      } else {
        const node = groupNode();
        const ext = info.children.find((child) => child.tag === 50005);
        tree = ext
          ? appendNode(tree, ext.id, node)
          : appendNode(tree, info.id, nestedNode(50005, [...extHeader(uid, chatType), node]));
      }
    } else {
      // No row yet: a minimal 48902 carrying only the highlight. 41002 sits one
      // below the hit so the conversation still reads as unread.
      const readSeq = highlight.msgSeq > 1 ? highlight.msgSeq - 1 : 0;
      tree = [
        nestedNode(48902, [
          varintNode(40010, chatType),
          utf8Node(40021, uid),
          ...(readSeq > 0 ? [varintNode(41002, readSeq)] : []),
          nestedNode(50005, [...extHeader(uid, chatType), groupNode()]),
        ]),
      ];
    }

    const encoded = encodeEditTree(tree, bytes ?? new Uint8Array(0));
    if (rows.length > 0) {
      const changed = await this.qq.write(
        `UPDATE msg_unread_info_table SET "48902" = ? WHERE "48901" = ? AND "48902" IS ?`,
        [encoded, peer, existing ?? null],
      );
      return changed > 0 ? true : null;
    }
    const changed = await this.qq.write(
      `INSERT OR IGNORE INTO msg_unread_info_table ("48901", "48902") VALUES (?, ?)`,
      [peer, encoded],
    );
    return changed > 0 ? true : null;
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

/** A freshly-built, dirty `varint` (wire 0) field node. */
function varintNode(tag: number, value: number | bigint): PbNode {
  const node = newNode(tag, 0);
  node.value = { kind: 'varint', text: value.toString() } satisfies PbValue;
  return node;
}

/** A freshly-built, dirty UTF-8 (wire 2) field node. */
function utf8Node(tag: number, text: string): PbNode {
  const node = newNode(tag, 2);
  node.value = { kind: 'utf8', text } satisfies PbValue;
  return node;
}

/** A freshly-built, dirty nested-message (wire 2) field node. */
function nestedNode(tag: number, children: PbNode[]): PbNode {
  const node = newNode(tag, 2);
  node.value = { kind: 'nested' } satisfies PbValue;
  node.children = children;
  return node;
}

/** The `50001` peerUid + `50002` chatType header shared by every `50005` ext. */
function extHeader(uid: string, chatType: number): PbNode[] {
  return [utf8Node(50001, uid), varintNode(50002, chatType)];
}

/** Read a nested node's scalar child (by tag) back as a number, or null. */
function readVarintChild(parent: PbNode, tag: number): number | null {
  const child = parent.children?.find((node) => node.tag === tag);
  if (!child) return null;
  const value = readVarintText(child);
  return Number(value);
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
          text: item.text ?? '',
        };
      }
    }
    if (best) out.push(best);
  }
  return out;
}
