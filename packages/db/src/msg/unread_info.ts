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
 *   1000 = @我 (at-me), 1006 = 特别关心 (special-care), 1007 = QQ红包 (red-packet),
 *   2000 = @全体 (at-all), 2001 = 新文件 (new-file).
 * More (回复我 …) will slot in as their codes are captured.
 */
export type HighlightKind =
  | 'atMe'
  | 'atAll'
  | 'specialCare'
  | 'newFile'
  | 'redPacket'
  | 'unknown';

const HIGHLIGHT_KIND_BY_CODE: Record<number, HighlightKind> = {
  1000: 'atMe',
  1006: 'specialCare',
  1007: 'redPacket',
  2000: 'atAll',
  2001: 'newFile',
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

  close(): void {
    this.qq.close();
  }
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
