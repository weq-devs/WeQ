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
 * 特别关心 (special-care) marker for a conversation, decoded from the 48902
 * notify-highlight extension (50005 → 50060, kind 1006). Present only when the
 * conversation has an unread message from a 特别关心 friend.
 */
export interface SpecialCareInfo {
  /** Seq of the (latest) special-care message. */
  msgSeq: number;
  /** Uid of the special-care sender. */
  senderUid: string;
  /** Send time of the special-care message (unix seconds). */
  sendTime: number;
}

export interface UnreadInfoResult {
  peer: string;
  chatType: number;
  uid: string;
  msgSeq?: number;
  /** 特别关心 marker, when the conversation has a special-care unread. */
  specialCare?: SpecialCareInfo;
}

/** QQ NT's notify-highlight kind code for 特别关心. */
const HIGHLIGHT_KIND_SPECIAL_CARE = 1006;

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

    return {
      peer: row[0] as string,
      chatType,
      uid,
      msgSeq: decoded.info?.msgSeq,
      specialCare: extractSpecialCare(decoded.info?.ext),
    };
  }

  close(): void {
    this.qq.close();
  }
}

/**
 * Pull the 特别关心 marker out of the decoded 50005 extension. Picks the
 * highlight group tagged with the special-care kind and returns its latest
 * (highest-seq) item. Returns undefined when there's no special-care unread.
 */
type DecodedExt = NonNullable<
  NonNullable<ReturnType<ProtoMsg<typeof UnreadInfo>['decode']>['info']>['ext']
>;

function extractSpecialCare(ext: DecodedExt | undefined): SpecialCareInfo | undefined {
  const groups = ext?.highlight;
  if (!groups?.length) return undefined;

  let best: SpecialCareInfo | undefined;
  for (const group of groups) {
    if (group.kind !== HIGHLIGHT_KIND_SPECIAL_CARE) continue;
    for (const item of group.items ?? []) {
      if (item.msgSeq === undefined) continue;
      if (!best || item.msgSeq > best.msgSeq) {
        best = {
          msgSeq: item.msgSeq,
          senderUid: item.senderUid ?? '',
          sendTime: item.sendTime ?? 0,
        };
      }
    }
  }
  return best;
}
